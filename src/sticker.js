'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sharp = require('sharp');
const webpmux = require('node-webpmux');
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
async function sendSticker(sock, jid, buffer, quoted = null, isVideo = false, wm = null) {
  try {
    log.info(`Converting to WebP sticker (isVideo=${isVideo})...`);
    let stickerBuf = await toWebpBuffer(buffer, isVideo);
    if (wm) {
      try {
        stickerBuf = await addWatermark(stickerBuf, wm);
      } catch (err) {
        log.warn(`Failed to add watermark to sticker: ${err.message}`);
      }
    }
    const msg = { sticker: stickerBuf, mimetype: 'image/webp' };
    if (quoted) msg.quoted = quoted;
    await sock.sendMessage(jid, msg);
    stats.inc('sticker');
    log.ok(`✅ Sticker sent (${(stickerBuf.length / 1024).toFixed(1)} KB)`);
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
// di-tap/dilihat detailnya di WhatsApp.
// format text: "author" atau "pack|author" / "pack | author"

function buildExifBuffer(pack, author, categories = ['']) {
  const json = {
    'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: categories,
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');

  // Little-endian TIFF header (8 bytes) + 1 IFD entry count (2 bytes) + IFD entry (12 bytes)
  // Tag 0x5741 ('AW' di little-endian: 0x41, 0x57) + Type 7 (UNDEFINED: 0x07, 0x00)
  // + length (4 bytes) + data offset (4 bytes: 22 / 0x16)
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x41, 0x57,
    0x07, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x16, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([exifAttr, jsonBuf]);
  exif.writeUIntLE(jsonBuf.length, 14, 4);
  return exif;
}

async function addWatermark(buffer, text) {
  let pack = 'Sticker';
  let author = String(text || '').trim();
  const sep = String(text || '').indexOf('|');
  if (sep !== -1) {
    pack = String(text).slice(0, sep).trim() || 'Sticker';
    author = String(text).slice(sep + 1).trim() || author;
  }

  const img = new webpmux.Image();
  try {
    await img.load(buffer);
  } catch (err) {
    const webpBuf = await sharp(buffer, { animated: true }).webp().toBuffer();
    await img.load(webpBuf);
  }
  img.exif = buildExifBuffer(pack, author);
  return await img.save(null);
}

module.exports = {
  sendSticker,
  convertStickerToMedia,
  convertMediaToAudio,
  addWatermark,
  toWebpBuffer,
  buildExifBuffer,
};
