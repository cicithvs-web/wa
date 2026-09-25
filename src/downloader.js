'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const axios = require('axios');
const { execFile } = require('child_process');
const { CONFIG, YTDLP_BIN, COOKIES_DIR, COOKIES_MAP, DL_UA, log, stats } = require('./config');

//============================================================
// HELPERS
//============================================================

function getCookieFile(url) {
  for (const domain in COOKIES_MAP) {
    if (url.includes(domain)) {
      const filePath = path.join(COOKIES_DIR, COOKIES_MAP[domain]);
      if (fs.existsSync(filePath)) return filePath;
    }
  }
  return null;
}

function detectPlatform(url) {
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return null;
}

// Jalankan binary yt-dlp. YouTube butuh JS runtime (Node) + EJS solver
// buat ngatasin SABR streaming challenge.
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(YTDLP_BIN)) {
      return reject(new Error('Binary yt-dlp belum ada. Jalankan: node download-ytdlp.js'));
    }
    const fullArgs = [...args, '--js-runtimes', 'node', '--remote-components', 'ejs:github'];
    execFile(YTDLP_BIN, fullArgs, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Ambil metadata semua entry dalam 1 postingan (carousel IG, thread X
// dengan banyak video, dst). Maks 10 entry biar gak kebablasan.
async function probeEntries(url, cookieFile) {
  const args = [
    url,
    '--dump-json',
    '--ignore-no-formats-error',
    '--no-warnings',
    '--quiet',
    '--playlist-end', '10',
  ];
  if (cookieFile) args.push('--cookies', cookieFile);
  const stdout = await runYtDlp(args);
  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function classifyEntry(info) {
  const formats = info.formats || [];
  const hasVideo = formats.some((f) => f.vcodec && f.vcodec !== 'none');
  return hasVideo ? 'video' : 'photo';
}

function pickBestThumbnail(info) {
  const thumbs = (info.thumbnails || []).filter((t) => t && t.url);
  if (thumbs.length) {
    return thumbs.sort(
      (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    )[0];
  }
  if (info.thumbnail) return { url: info.thumbnail };
  if (info.url && /\.(jpg|jpeg|png|webp)(?:\?|$)/i.test(info.url)) {
    return { url: info.url };
  }
  return null;
}

function downloadUrlToFile(fileUrl, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Terlalu banyak redirect saat mengambil foto'));
    const lib = fileUrl.startsWith('https') ? https : http;
    lib
      .get(fileUrl, { headers: { 'User-Agent': DL_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(downloadUrlToFile(res.headers.location, destPath, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Gagal mengambil foto, status: ${res.statusCode}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function downloadEntryVideo(originalUrl, index, outputTemplate, cookieFile) {
  return new Promise((resolve, reject) => {
    const args = [
      originalUrl,
      '-o', outputTemplate,
      '-f', 'bv*+ba/b',
      '--playlist-items', String(index + 1),
      '--dump-json',
      '--no-simulate',
      '--no-warnings',
      '--quiet',
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github',
    ];
    if (cookieFile) args.push('--cookies', cookieFile);

    execFile(YTDLP_BIN, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const info = JSON.parse(lines[lines.length - 1]);
        let filePath =
          (info.requested_downloads && info.requested_downloads[0] && info.requested_downloads[0].filepath) ||
          info._filename ||
          info.filepath;
        if (!filePath) {
          const ext = info.ext || 'mp4';
          filePath = path.join(path.dirname(outputTemplate), `${info.id}.${ext}`);
        }
        resolve(filePath);
      } catch (parseErr) {
        reject(new Error('Gagal membaca output yt-dlp: ' + parseErr.message));
      }
    });
  });
}

//============================================================
// Kompatibilitas video WhatsApp — WA cuma jamin bisa play video
// H.264 (video) + AAC (audio) di container mp4 dengan moov atom di
// depan (faststart).
//============================================================

function ffprobeVideoCodec(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], (err, stdout) => {
      if (err) return resolve(null);
      resolve((stdout || '').trim().toLowerCase() || null);
    });
  });
}

function remuxFaststart(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], { maxBuffer: 1024 * 1024 * 100 }, (err, _o, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
  });
}

function transcodeToH264(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ], { maxBuffer: 1024 * 1024 * 100 }, (err, _o, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
  });
}

async function ensureWaCompatibleVideo(inputPath) {
  const dir     = path.dirname(inputPath);
  const outPath = path.join(dir, `wa_${Date.now()}_${path.basename(inputPath, path.extname(inputPath))}.mp4`);

  try {
    const codec = await ffprobeVideoCodec(inputPath);
    if (codec === 'h264' || codec === 'avc1') {
      await remuxFaststart(inputPath, outPath);
    } else {
      log.info(`⚙️ Video codec "${codec || 'unknown'}" gak didukung WA, transcoding ke H.264...`);
      await transcodeToH264(inputPath, outPath);
    }
    return outPath;
  } catch (e) {
    log.warn(`Konversi video gagal (${e.message}), kirim file asli apa adanya.`);
    return inputPath;
  }
}

//============================================================
// TikTok — via tikwm.com (support foto slideshow, tanpa login)
//============================================================
async function handleTiktok(sock, jid, url, quotedMsg = null) {
  const { data } = await axios.get('https://www.tikwm.com/api/', {
    params: { url },
    timeout: 20000,
  });

  if (!data || data.code !== 0 || !data.data) {
    throw new Error('TikTok API gagal: ' + (data?.msg || 'response tidak valid'));
  }

  const d = data.data;
  const author = d.author?.nickname || d.author?.unique_id || 'TikTok';
  const caption = `🎵 ${author}\n\n${(d.title || '').slice(0, 900)}`;

  const images = Array.isArray(d.images) && d.images.length ? d.images : null;

  if (images) {
    for (let i = 0; i < images.length; i++) {
      await sock.sendMessage(jid, {
        image: { url: images[i] },
        caption: i === 0 ? caption : undefined,
        ...(quotedMsg && i === 0 ? { quoted: quotedMsg } : {}),
      });
      stats.inc('download');
    }
    if (d.music) {
      try {
        await sock.sendMessage(jid, {
          audio: { url: d.music },
          mimetype: 'audio/mp4',
        });
      } catch (e) {
        log.warn('Gagal kirim audio TikTok: ' + e.message);
      }
    }
    return;
  }

  const videoUrl = d.play || d.hdplay || d.wmplay;
  if (!videoUrl) throw new Error('Video tidak ditemukan dari TikWM.');
  await sock.sendMessage(jid, {
    video: { url: videoUrl },
    caption,
    ...(quotedMsg && { quoted: quotedMsg }),
  });
  stats.inc('download');
}

//============================================================
// Alur generik: dipakai buat Instagram, X/Twitter, dan Facebook.
//============================================================
async function handleEntries(sock, jid, url, cookieFile, quotedMsg = null) {
  const tmpDir = fs.mkdtempSync(path.join(CONFIG.DOWNLOAD_TMP_DIR, 'dl-'));
  try {
    const entries = await probeEntries(url, cookieFile);
    if (!entries.length) throw new Error('Tidak ada media yang ditemukan di postingan ini.');

    const first = entries[0];
    const owner = first.uploader || first.uploader_id || first.channel || 'unknown';
    const caption = `👤 ${owner}\n\n${(first.description || first.title || '').slice(0, 900)}`;

    let sentAny = false;

    for (let i = 0; i < entries.length; i++) {
      const info = entries[i];
      const kind = classifyEntry(info);
      try {
        if (kind === 'video') {
          const outTpl = path.join(tmpDir, `v${i}_%(id)s.%(ext)s`);
          const filePath = await downloadEntryVideo(url, i, outTpl, cookieFile);
          if (fs.existsSync(filePath)) {
            const waFilePath = await ensureWaCompatibleVideo(filePath);
            const buf = fs.readFileSync(waFilePath);
            await sock.sendMessage(jid, {
              video: buf,
              caption: !sentAny ? caption : undefined,
              ...(quotedMsg && !sentAny ? { quoted: quotedMsg } : {}),
            });
            stats.inc('download');
            sentAny = true;
          }
        } else {
          const best = pickBestThumbnail(info);
          if (!best) continue;
          const extMatch = best.url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i);
          const ext = extMatch ? extMatch[1] : 'jpg';
          const destPath = path.join(tmpDir, `p${i}.${ext}`);
          await downloadUrlToFile(best.url, destPath);
          const buf = fs.readFileSync(destPath);
          await sock.sendMessage(jid, {
            image: buf,
            caption: !sentAny ? caption : undefined,
            ...(quotedMsg && !sentAny ? { quoted: quotedMsg } : {}),
          });
          stats.inc('download');
          sentAny = true;
        }
      } catch (err) {
        log.warn(`Gagal ambil item ke-${i} (${kind}): ${err.message}`);
      }
    }

    if (!sentAny) throw new Error('Tidak ada media yang berhasil diunduh dari postingan ini.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function handleInstagram(sock, jid, url, quotedMsg = null) {
  const cookieFile = getCookieFile(url);
  if (!cookieFile) {
    throw new Error(
      'Cookies Instagram belum ada/tidak ditemukan di cookies/instagram.txt. Instagram sekarang wajib login untuk diakses, export cookies dari browser yang sudah login IG.'
    );
  }
  await handleEntries(sock, jid, url, cookieFile, quotedMsg);
}

// Facebook & X/Twitter — pakai alur generik yang sama
async function handleYtdlpVideo(sock, jid, url, quotedMsg = null) {
  const cookieFile = getCookieFile(url);
  await handleEntries(sock, jid, url, cookieFile, quotedMsg);
}

//============================================================
// YouTube (video & Shorts)
//============================================================
async function handleYoutube(sock, jid, url, quotedMsg = null) {
  const cookieFile = getCookieFile(url);
  const tmpDir = fs.mkdtempSync(path.join(CONFIG.DOWNLOAD_TMP_DIR, 'dl-yt-'));
  try {
    const args = [
      url,
      '-o', path.join(tmpDir, '%(id)s.%(ext)s'),
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '-S', 'vcodec:h264,res,acodec:m4a',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--dump-json',
      '--no-simulate',
      '--no-warnings',
      '--quiet',
    ];
    if (cookieFile) args.push('--cookies', cookieFile);

    const stdout = await runYtDlp(args);
    const lines = stdout.trim().split('\n').filter(Boolean);
    const info = JSON.parse(lines[lines.length - 1]);

    let filePath =
      (info.requested_downloads && info.requested_downloads[0] && info.requested_downloads[0].filepath) ||
      info._filename ||
      info.filepath;
    if (!filePath) {
      const ext = info.ext || 'mp4';
      filePath = path.join(tmpDir, `${info.id}.${ext}`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error('File hasil download tidak ditemukan: ' + filePath);
    }

    const waFilePath = await ensureWaCompatibleVideo(filePath);
    const caption = `👤 ${info.uploader || info.channel || 'YouTube'}\n\n${(info.title || '').slice(0, 900)}`;
    const buf = fs.readFileSync(waFilePath);
    await sock.sendMessage(jid, {
      video: buf,
      caption,
      ...(quotedMsg && { quoted: quotedMsg }),
    });
    stats.inc('download');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

//============================================================
// Dispatcher
//============================================================
async function runDownloader(sock, jid, url, platform, quotedMsg) {
  if (platform === 'tiktok') return handleTiktok(sock, jid, url, quotedMsg);
  if (platform === 'instagram') return handleInstagram(sock, jid, url, quotedMsg);
  if (platform === 'youtube') return handleYoutube(sock, jid, url, quotedMsg);
  return handleYtdlpVideo(sock, jid, url, quotedMsg);
}

//============================================================
// Anti-loop dedupe
//============================================================
const recentDownloadUrls = new Map();
const DEDUPE_WINDOW_MS = 60 * 1000;

function isRecentlyProcessed(url) {
  const last = recentDownloadUrls.get(url);
  const now = Date.now();
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentDownloadUrls.set(url, now);
  if (recentDownloadUrls.size > 500) {
    for (const [u, t] of recentDownloadUrls) {
      if (now - t > DEDUPE_WINDOW_MS) recentDownloadUrls.delete(u);
    }
  }
  return false;
}

module.exports = { detectPlatform, runDownloader, isRecentlyProcessed };
