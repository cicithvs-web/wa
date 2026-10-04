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
// Tambah teks watermark ke sticker (static: sharp SVG, animated: ffmpeg drawtext)
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// SVG banner semi transparan di bawah sticker
function buildWmSvg(text, width, height) {
  const lines = [];
  let cur = '';
  const maxChars = 24; // perkiraan wrap per baris
  for (const word of String(text).split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > maxChars && cur) {
      lines.push(cur.trim());
      cur = word;
    } else {
      cur = (cur + ' ' + word).trim();
    }
  }
  if (cur) lines.push(cur.trim());
  const shown = lines.slice(0, 3); // maks 3 baris
  const fs_ = 26;
  const lineH = fs_ + 6;
  const bannerH = shown.length * lineH + 16;
  const y0 = height - bannerH;
  const tspans = shown.map((l, i) =>
    `<tspan x="50%" dy="${i === 0 ? fs_ : lineH}">${escapeXml(l)}</tspan>`
  ).join('');
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${y0}" width="${width}" height="${bannerH}" fill="black" opacity="0.55"/>
      <text x="50%" y="${y0 + 8}" text-anchor="middle"
            font-family="DejaVu Sans, sans-serif" font-size="${fs_}"
            fill="white" stroke="black" stroke-width="0.8">
        ${tspans}
      </text>
    </svg>`
  );
}

async function addWatermark(buffer, text) {
  const meta = await sharp(buffer, { animated: true }).metadata();
  const isAnimated = (meta.pages || 1) > 1;

  if (!isAnimated) {
    // STATIC: render SVG -> PNG overlay, lalu composite ke gambar.
    // (Composite SVG langsung ke WebP tidak andal — banner bisa hilang.)
    const width  = meta.width || 512;
    const height = meta.height || 512;
    const svg = buildWmSvg(text, width, height);
    // Render SVG pada ukuran asli (tanpa density scaling) -> overlay PNG RGBA
    const overlay = await sharp(svg).resize(width, height, { fit: 'fill' }).png().toBuffer();
    // Normalkan base ke PNG RGBA dulu agar dimensi & channel konsisten
    const base = await sharp(buffer).ensureAlpha().resize(width, height, { fit: 'fill' }).png().toBuffer();
    return sharp(base)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .webp({ quality: 90 })
      .toBuffer();
  }

  // ANIMATED: ekstrak frame via sharp -> composite banner per frame -> reassemble
  // (ffmpeg build ini gak bisa demux webp animasi langsung, jadi pakai pola webpToMp4Buffer)
  const ts       = Date.now();
  const frameDir = path.join(TMP_DIR, `wm_frames_${ts}`);
  const tmpOut   = path.join(os.tmpdir(), `wm_out_${ts}.webp`);

  const cleanup = () => {
    try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  };

  try {
    fs.mkdirSync(frameDir, { recursive: true });

    const pages = meta.pages || 1;
    const delay = meta.delay || [];
    // Dimensi per-frame: meta {animated:true} kasih height gabungan semua frame,
    // jadi ambil dari page pertama
    const firstPage = await sharp(buffer, { animated: false, page: 0 }).metadata();
    const width  = firstPage.width || 512;
    const height = firstPage.height || 512;

    const svg = buildWmSvg(text, width, height);
    // Render overlay sekali (PNG RGBA ukuran frame), reuse untuk semua frame
    const overlay = await sharp(svg).resize(width, height, { fit: 'fill' }).png().toBuffer();

    for (let i = 0; i < pages; i++) {
      const frameBase = await sharp(buffer, { animated: false, page: i })
        .ensureAlpha()
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer();
      const frameBuf = await sharp(frameBase)
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png()
        .toBuffer();
      fs.writeFileSync(path.join(frameDir, `frame_${String(i).padStart(4, '0')}.png`), frameBuf);
    }

    const avgDelay = delay.length > 0
      ? delay.reduce((a, b) => a + b, 0) / delay.length
      : 100;
    const fps = Math.max(1, Math.min(30, Math.round(1000 / avgDelay)));

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-framerate', String(fps),
        '-i', path.join(frameDir, 'frame_%04d.png'),
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-qscale', '50',
        '-preset', 'default',
        '-loop', '0',
        '-an',
        tmpOut,
      ], { maxBuffer: 100 * 1024 * 1024 }, (err, _o, stderr) => {
        if (err) {
          const hint = (stderr || '').split('\n').filter(l => /error|invalid/i.test(l)).slice(0, 2).join(' | ');
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

module.exports = { sendSticker, convertStickerToMedia, convertMediaToAudio, addWatermark };
