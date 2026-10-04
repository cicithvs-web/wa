'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { log, stats, logger } = require('./config');
const { safeSend } = require('./helpers');

//----------TMP DIR----------
const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// CONVERT BUFFER TO WEBP (untuk sticker)
async function toWebpBuffer(buffer, isVideo = false) {
  if (isVideo) {
    return new Promise((resolve, reject) => {
      const tmpIn  = path.join(os.tmpdir(), `stk_in_${Date.now()}.mp4`);
      const tmpOut = path.join(os.tmpdir(), `stk_out_${Date.now()}.webp`);
      fs.writeFileSync(tmpIn, buffer);
      execFile('ffmpeg', [
        '-i', tmpIn,
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2',
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-qscale', '50',
        '-preset', 'default',
        '-loop', '0',
        '-an',
        '-vsync', '0',
        '-t', '5',
        tmpOut,
      ], (err) => {
        try { fs.unlinkSync(tmpIn); } catch (_) {}
        if (err) {
          try { fs.unlinkSync(tmpOut); } catch (_) {}
          return reject(new Error('ffmpeg error: ' + err.message));
        }
        const out = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpOut); } catch (_) {}
        resolve(out);
      });
    });
  } else {
    return await sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp()
      .toBuffer();
  }
}

async function webpToMp4Buffer(buffer) {
  const ts       = Date.now();
  const frameDir = path.join(TMP_DIR, `frames_${ts}`);
  const tmpOut   = path.join(TMP_DIR, `stk_out_${ts}.mp4`);

  const cleanup = () => {
    try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  };

  try {
    fs.mkdirSync(frameDir, { recursive: true });

    const meta  = await sharp(buffer, { animated: true }).metadata();
    const pages = meta.pages || 1;
    const delay = meta.delay || [];
    log.dim(`WebP: ${pages} frame(s)`);

    for (let i = 0; i < pages; i++) {
      const frameBuf = await sharp(buffer, { animated: false, page: i })
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const framePath = path.join(frameDir, `frame_${String(i).padStart(4, '0')}.png`);
      fs.writeFileSync(framePath, frameBuf);
    }

    const avgDelay = delay.length > 0
      ? delay.reduce((a, b) => a + b, 0) / delay.length
      : 100;
    const fps = Math.max(1, Math.min(30, Math.round(1000 / avgDelay)));
    log.dim(`FPS: ${fps}`);

    const ffmpegArgs = pages <= 1
      ? ['-y', '-loop', '1', '-i', path.join(frameDir, 'frame_0000.png'),
         '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'fast',
         '-crf', '28', '-t', '2', '-movflags', '+faststart', '-an', tmpOut]
      : ['-y', '-framerate', String(fps),
         '-i', path.join(frameDir, 'frame_%04d.png'),
         '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'fast',
         '-crf', '28', '-movflags', '+faststart', '-an', tmpOut];

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ffmpegArgs, { maxBuffer: 100 * 1024 * 1024 }, (err, _o, stderr) => {
        if (err) {
          const hint = (stderr || '').split('\n')
            .filter(l => /error|invalid/i.test(l)).slice(0, 2).join(' | ');
          return reject(new Error('ffmpeg error: ' + (hint || err.message)));
        }
        resolve();
      });
    });

    const out = fs.readFileSync(tmpOut);
    cleanup();
    return out;

  } catch (e) {
    cleanup();
    throw e;
  }
}

//----------SEND STICKER----------
async function sendSticker(sock, jid, buffer, quoted = null, isVideo = false) {
  try {
    log.info(`Converting to WebP sticker (isVideo=${isVideo})...`);
    const webp = await toWebpBuffer(buffer, isVideo);
    const msg = { sticker: webp, mimetype: 'image/webp' };
    if (quoted) msg.quoted = quoted;
    await sock.sendMessage(jid, msg);
    stats.inc('sticker');
    log.ok(`✅ Sticker sent (${(webp.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (e) {
    log.warn(`Sticker failed: ${e.message}`);
    throw e;
  }
}

//------CONVERT STICKER TO MEDIA------
async function convertStickerToMedia(sock, jid, msg, type = 'image') {
  try {
    log.info(`🔄 Converting sticker to ${type}...`);
    
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    
    if (!buffer || buffer.length === 0) {
      throw new Error('Buffer kosong');
    }
    
    log.ok(`Sticker downloaded (${(buffer.length / 1024).toFixed(1)} KB)`);
    
    const caption = `🔁 Sticker → ${type}`;
    
    if (type === 'image') {
      const png = await sharp(buffer).png().toBuffer();
      await sock.sendMessage(jid, { image: png, caption, mimetype: 'image/png' });
    } else if (type === 'video') {
      await safeSend(sock, jid, { text: `🔄 Mengonversi stiker ke video...` });
      const mp4 = await webpToMp4Buffer(buffer);
      await sock.sendMessage(jid, { video: mp4, caption, mimetype: 'video/mp4' });
    }
    
    log.ok(`✅ Converted sticker to ${type}`);
    return true;
    
  } catch (e) {
    log.err(`Convert failed: ${e.message}`);
    await safeSend(sock, jid, { text: `❌ Gagal convert: ${e.message}` });
    return false;
  }
}

//------CONVERT MEDIA TO AUDIO / VN------
async function convertMediaToAudio(buffer, isVn = false) {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const tmpIn = path.join(TMP_DIR, `aud_in_${ts}`);
    const ext = isVn ? 'ogg' : 'mp3';
    const tmpOut = path.join(TMP_DIR, `aud_out_${ts}.${ext}`);

    fs.writeFileSync(tmpIn, buffer);

    const args = isVn
      ? ['-y', '-i', tmpIn, '-vn', '-map_metadata', '-1',
         '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000',
         '-application', 'voip', '-f', 'ogg', tmpOut]
      : ['-y', '-i', tmpIn, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', tmpOut];

    execFile('ffmpeg', args, (err, _stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch (_) {}
      if (err) {
        try { fs.unlinkSync(tmpOut); } catch (_) {}
        const hint = (stderr || '').split('\n').filter(l => /error|invalid/i.test(l)).slice(0, 2).join(' | ');
        return reject(new Error('ffmpeg error: ' + (hint || err.message)));
      }
      try {
        const out = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpOut);
        resolve(out);
      } catch (readErr) {
        reject(readErr);
      }
    });
  });
}

//------WATERMARK STICKER (wm)------
// Watermark = metadata EXIF sticker (pack name + author), tampil saat sticker
// di-tap/dilihat detailnya — BUKAN teks yang digambar di atas gambar.
// text boleh "pack" atau "pack|author".
//
// Implementasi manual: bangun TIFF/EXIF chunk berisi JSON metadata WhatsApp,
// lalu sisipkan ke WebP RIFF. Tanpa native dependency tambahan.

function buildExifChunk(pack, author) {
  const packId = require('crypto').randomBytes(32).toString('hex');
  const json = JSON.stringify({
    'sticker-pack-id': packId,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    'emojis': [],
  });
  const jsonBuf = Buffer.from(json, 'utf8');

  // TIFF header: little-endian 'II' + 42 + offset IFD(8)
  // IFD: 1 entry -> tag 0x0141? Tidak — WhatsApp pakai tag 0x02BC? Kita tiru
  // layout dari wa-sticker-formatter: tag 0x0141 adalah 'AW' custom... sebenarnya
  // mereka pakai tag 0x0157 (ASCII) berisi JSON. Kita replika persis:
  // header(8) + ifdCount(2)=1 + entry(12) + nextIFD(4) + json
  const tiffHeader = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const ifdCount = Buffer.from([0x01, 0x00]);
  // entry: tag(2)=0x0157 type(2)=7(undefined/ASCII) count(4)=jsonLen value(4)=offset
  const jsonOffset = 8 + 2 + 12 + 4; // tepat setelah nextIFD pointer
  const entry = Buffer.alloc(12);
  entry.writeUInt16LE(0x0157, 0);      // tag
  entry.writeUInt16LE(7, 2);           // type = UNDEFINED
  entry.writeUInt32LE(jsonBuf.length, 4);
  entry.writeUInt32LE(jsonOffset, 8);  // offset data
  const nextIfd = Buffer.from([0x00, 0x00, 0x00, 0x00]);

  const exifData = Buffer.concat([tiffHeader, ifdCount, entry, nextIfd, jsonBuf]);

  // WebP EXIF chunk: FourCC 'EXIF' + size(LE, tanpa 8 byte header) + data
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(exifData.length, 0);
  const chunk = Buffer.concat([Buffer.from('EXIF', 'latin1'), sizeBuf, exifData]);
  // chunk harus even-length; pad dengan 0 kalau ganjil
  return exifData.length % 2 === 0 ? chunk : Buffer.concat([chunk, Buffer.from([0])]);
}

// Sisipkan EXIF chunk ke WebP RIFF (setelah VP8/VP8L/VP8X chunk terakhir)
function insertExifToWebp(webpBuf, exifChunk) {
  // WebP = RIFF(12) + chunks. Sisipkan EXIF sebelum akhir file.
  // Update RIFF size di offset 4.
  const riffSize = webpBuf.length - 8;
  const newRiffSize = riffSize + exifChunk.length;
  const out = Buffer.concat([webpBuf, exifChunk]);
  out.writeUInt32LE(newRiffSize, 4);
  // Pastikan VP8X feature flag EXIF diset kalau ada VP8X chunk (bit 3 = 0x08)
  const vp8xIdx = webpBuf.indexOf(Buffer.from('VP8X', 'latin1'));
  if (vp8xIdx !== -1) {
    const flagsOffset = vp8xIdx + 8; // setelah 'VP8X'+size(4)
    out[flagsOffset] = out[flagsOffset] | 0x08;
  }
  return out;
}

async function addWatermark(buffer, text) {
  let pack = 'Sticker';
  let author = String(text || '').trim();
  const sep = String(text || '').indexOf('|');
  if (sep !== -1) {
    pack = String(text).slice(0, sep).trim() || 'Sticker';
    author = String(text).slice(sep + 1).trim() || author;
  }

  // Hapus EXIF lama kalau ada (hindari duplikat chunk)
  let base = buffer;
  const exifIdx = base.indexOf(Buffer.from('EXIF', 'latin1'));
  if (exifIdx !== -1) {
    const exifSize = base.readUInt32LE(exifIdx + 4) + 8;
    const padded = exifSize % 2 === 0 ? exifSize : exifSize + 1;
    base = Buffer.concat([base.slice(0, exifIdx), base.slice(exifIdx + padded)]);
    // perbaiki RIFF size
    base.writeUInt32LE(base.length - 8, 4);
  }

  const exifChunk = buildExifChunk(pack, author);
  return insertExifToWebp(base, exifChunk);
}

module.exports = { sendSticker, convertStickerToMedia, convertMediaToAudio, addWatermark };
