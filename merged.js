'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  jidNormalizedUser,
  proto,
} = require('@whiskeysockets/baileys');

const qrcode  = require('qrcode-terminal');
const express = require('express');
const QRCode  = require('qrcode'); // beda sama qrcode-terminal, ini buat generate PNG
const chalk   = require('chalk');
const pino    = require('pino');
const fs      = require('fs');
const path    = require('path');
const sharp   = require('sharp');
const { execFile } = require('child_process');
const os      = require('os');
const crypto   = require('crypto');
const axios   = require('axios');
const https   = require('https');
const http    = require('http');

//------------CONFIG----------
const CONFIG = {
  VERSION            : '4.0.0',
  AUTH_FOLDER        : './auth_info',
  RECONNECT_DELAY_MS : 5000,
  MAX_RECONNECT      : 10,
  AUTO_REACT         : true,
  AUTO_REPLY_FILE    : './auto_reply.json',
  PHOTO_STORE_DIR    : './ar_photos',
  TAG_STATE_FILE     : './tag_state.json',
  DOWNLOAD_TMP_DIR   : './download_tmp',
  AUTO_DOWNLOAD_LINKS: true, // auto-detect link TikTok/IG/X/FB/YouTube tanpa command
  WEB_PORT           : process.env.PORT || 3000, // port buat endpoint /qr
};

//----------DOWNLOADER CONFIG (TikTok / Instagram / X / Facebook / YouTube)----------
const YTDLP_BIN = path.join(__dirname, 'bin', 'yt-dlp');
const COOKIES_DIR = path.join(__dirname, 'cookies');
const COOKIES_MAP = {
  'instagram.com': 'instagram.txt',
  'facebook.com' : 'facebook.txt',
  'fb.watch'     : 'facebook.txt',
  'twitter.com'  : 'twitter.txt',
  'x.com'        : 'twitter.txt',
  'youtube.com'  : 'youtube.txt',
  'youtu.be'     : 'youtube.txt',
};
const URL_REGEX = /https?:\/\/\S+/;
const DL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

if (!fs.existsSync(CONFIG.DOWNLOAD_TMP_DIR)) fs.mkdirSync(CONFIG.DOWNLOAD_TMP_DIR, { recursive: true });
if (!fs.existsSync(YTDLP_BIN)) {
  console.log('[WARN] Binary yt-dlp belum ada di ./bin/yt-dlp — jalankan "node download-ytdlp.js" dulu (fitur download IG/X/FB/YouTube butuh ini).');
}
//----------LOGGER----------
const logger = pino({ level: 'silent' });

const log = {
  info: (...a) => console.log(chalk.cyan('[INFO]'),   ...a),
  ok  : (...a) => console.log(chalk.green('[OK]'),    ...a),
  warn: (...a) => console.log(chalk.yellow('[WARN]'), ...a),
  err : (...a) => console.log(chalk.red('[ERR]'),     ...a),
  dim : (...a) => console.log(chalk.gray('[LOG]'),    ...a),
};

//----------STATS----------
const stats = {
  image: 0, video: 0, audio: 0, sticker: 0, failed: 0, download: 0,
  startedAt: Date.now(),
  inc(type) {
    if (type === 'image') this.image++;
    else if (type === 'video') this.video++;
    else if (type === 'audio') this.audio++;
    else if (type === 'sticker') this.sticker++;
    else if (type === 'download') this.download++;
  },
  total() { return this.image + this.video + this.audio + this.sticker + this.download; },
  uptime() {
    const s   = Math.floor((Date.now() - this.startedAt) / 1000);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}j ${m}m ${sec}d`;
  },
};

//----------JID HELPERS----------
function isGroupJid(jid = '') { return jid.endsWith('@g.us'); }
function isPrivateJid(jid = '') { return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'); }

//============================================================
// DOWNLOADER (TikTok / Instagram / X / Facebook / YouTube)
// Diadaptasi dari bot Telegram (yt-dlp binary + tikwm.com API)
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

// ============================================================
// Kompatibilitas video WhatsApp — WA cuma jamin bisa play video
// H.264 (video) + AAC (audio) di container mp4 dengan moov atom di
// depan (faststart). yt-dlp sering ngasih VP9/AV1+Opus (apalagi buat
// YouTube Shorts di resolusi tinggi), yang bikin WA nolak file
// ("ada masalah dengan file video") walau ukurannya normal.
// Di sini: cek codec videonya dulu via ffprobe — kalau udah H.264,
// cukup remux cepat (pindah moov atom doang, gak re-encode). Kalau
// bukan, baru transcode penuh ke H.264/AAC.
// ============================================================
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

// ============================================================
// TikTok — via tikwm.com (support foto slideshow, tanpa login)
// ============================================================
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

// ============================================================
// Alur generik: dipakai buat Instagram, X/Twitter, dan Facebook.
// Semua ditreat sebagai "kumpulan entry" (1 entry = 1 video/foto),
// jadi postingan dengan banyak video (mis. X bisa sampai 4 video
// dalam satu tweet) atau carousel foto/video (IG feed post) sama-sama
// ke-download semuanya, bukan cuma 1.
// ============================================================
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

// Facebook & X/Twitter — pakai alur generik yang sama supaya postingan
// dengan >1 video (X bisa sampai 4 video dalam 1 tweet) ikut
// ke-download semua, bukan cuma 1 yang keambil.
async function handleYtdlpVideo(sock, jid, url, quotedMsg = null) {
  const cookieFile = getCookieFile(url);
  await handleEntries(sock, jid, url, cookieFile, quotedMsg);
}

// ============================================================
// YouTube (video & Shorts) — via yt-dlp + cookies (opsional,
// berguna buat video age-restricted/member-only). Selalu
// --no-playlist biar kalau link-nya kebawa ?list=... gak ke-download
// satu playlist penuh, cukup video yang dituju aja.
// ============================================================
async function handleYoutube(sock, jid, url, quotedMsg = null) {
  const cookieFile = getCookieFile(url);
  const tmpDir = fs.mkdtempSync(path.join(CONFIG.DOWNLOAD_TMP_DIR, 'dl-yt-'));
  try {
    const args = [
      url,
      '-o', path.join(tmpDir, '%(id)s.%(ext)s'),
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '-S', 'vcodec:h264,res,acodec:m4a', // utamain H.264/AAC kalau tersedia biar gak perlu transcode
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

// Dispatcher tunggal dipakai baik oleh auto-detect maupun command .dl
async function runDownloader(sock, jid, url, platform, quotedMsg) {
  if (platform === 'tiktok') return handleTiktok(sock, jid, url, quotedMsg);
  if (platform === 'instagram') return handleInstagram(sock, jid, url, quotedMsg);
  if (platform === 'youtube') return handleYoutube(sock, jid, url, quotedMsg);
  return handleYtdlpVideo(sock, jid, url, quotedMsg);
}

// Anti-loop: karena auto-download sekarang juga aktif untuk pesan fromMe
// (bot dikontrol dari akun sendiri), caption hasil download kadang
// mengandung link (mis. link bio). Tanpa ini, link tsb bisa ke-download
// ulang terus-menerus. Simpan URL yang baru saja diproses selama 60 detik.
const recentDownloadUrls = new Map();
const DEDUPE_WINDOW_MS = 60 * 1000;

function isRecentlyProcessed(url) {
  const last = recentDownloadUrls.get(url);
  const now = Date.now();
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentDownloadUrls.set(url, now);
  // beres-beres entry lama biar Map gak numpuk terus
  if (recentDownloadUrls.size > 500) {
    for (const [u, t] of recentDownloadUrls) {
      if (now - t > DEDUPE_WINDOW_MS) recentDownloadUrls.delete(u);
    }
  }
  return false;
}

//----------AUTO REPLY SYSTEM----------
const AUTO_REPLY_FILE = './auto_reply.json';
const PHOTO_STORE_DIR = './ar_photos';

if (!fs.existsSync(PHOTO_STORE_DIR)) fs.mkdirSync(PHOTO_STORE_DIR, { recursive: true });

function loadAutoReplies() {
  try {
    if (fs.existsSync(AUTO_REPLY_FILE)) return JSON.parse(fs.readFileSync(AUTO_REPLY_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}
function saveAutoReplies(data) {
  try { fs.writeFileSync(AUTO_REPLY_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

let autoReplies = loadAutoReplies();
log.info(`Auto-reply loaded: ${Object.keys(autoReplies).length} entri`);

// Hash foto untuk dijadikan trigger key
function photoHash(buffer) {
  return '__photo__' + crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

// Kirim balasan auto-reply (teks atau foto)
async function sendAutoReply(sock, jid, entry, quotedMsg) {
  try {
    if (entry.type === 'text') {
      await safeSend(sock, jid, { text: entry.value, quoted: quotedMsg });

    } else if (entry.type === 'photo') {
      const filePath = path.join(PHOTO_STORE_DIR, entry.value);
      if (!fs.existsSync(filePath)) {
        await safeSend(sock, jid, { text: '⚠️ File foto balasan tidak ditemukan.', quoted: quotedMsg });
        return;
      }
      const buf = fs.readFileSync(filePath);
      await sock.sendMessage(jid, {
        image  : buf,
        caption: entry.caption || '',
      }, { quoted: quotedMsg });
    }
  } catch (e) {
    log.warn('sendAutoReply error: ' + e.message);
  }
}

//============================================================
// TAG ALL STATE (BOT AUTO TAG ALL MEMBERS - INVISIBLE)
//============================================================
const TAG_STATE_FILE = './tag_state.json';
const tagStates = new Map();

function loadTagStates() {
  try {
    if (fs.existsSync(TAG_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TAG_STATE_FILE, 'utf8'));
      for (const [key, value] of Object.entries(data)) {
        tagStates.set(key, value);
      }
      log.ok(`✅ Loaded ${tagStates.size} tag states`);
    }
  } catch (_) {}
}

function saveTagStates() {
  try {
    const data = Object.fromEntries(tagStates);
    fs.writeFileSync(TAG_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

loadTagStates();

//============================================================
// DOWNLOAD TOGGLE STATE (.dlon / .dloff PER GRUP/USER)
//============================================================
const DL_STATE_FILE = './dl_state.json';
const dlOffStates = new Map(); // jid -> true berarti auto-download DIMATIKAN di chat itu

function loadDlOffStates() {
  try {
    if (fs.existsSync(DL_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(DL_STATE_FILE, 'utf8'));
      for (const [key, value] of Object.entries(data)) {
        dlOffStates.set(key, value);
      }
      log.ok(`✅ Loaded ${dlOffStates.size} dl-off states`);
    }
  } catch (_) {}
}

function saveDlOffStates() {
  try {
    const data = Object.fromEntries(dlOffStates);
    fs.writeFileSync(DL_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

function isAutoDownloadEnabled(jid) {
  return dlOffStates.get(jid) !== true;
}

loadDlOffStates();

//============================================================
// REMINDER / SCHEDULER (.reminder — reply pesan + detik)
// Reply ke foto/video/teks/gabungan lalu ".reminder <detik>",
// bot simpan kontennya dan forward balik ke chat itu pas waktunya.
//============================================================
const REMIND_STATE_FILE = './reminders.json';
const REMIND_MEDIA_DIR  = './reminder_media';
if (!fs.existsSync(REMIND_MEDIA_DIR)) fs.mkdirSync(REMIND_MEDIA_DIR, { recursive: true });

const reminders = new Map(); // id -> { id, jid, content, dueAt, createdAt, timer }
let reminderIdCounter = 1;
let botSock = null; // di-set saat koneksi 'open', dipakai buat kirim reminder

function loadReminders() {
  try {
    if (fs.existsSync(REMIND_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(REMIND_STATE_FILE, 'utf8'));
      reminderIdCounter = data.nextId || 1;
      for (const r of data.items || []) {
        reminders.set(r.id, { ...r, timer: null });
      }
      log.ok(`✅ Loaded ${reminders.size} reminders`);
    }
  } catch (_) {}
}

function persistReminders() {
  try {
    const items = Array.from(reminders.values()).map(({ timer, ...rest }) => rest);
    fs.writeFileSync(REMIND_STATE_FILE, JSON.stringify({ nextId: reminderIdCounter, items }, null, 2));
  } catch (_) {}
}

// Ambil konten pesan yang di-reply (foto/video/audio/sticker/teks) dan
// simpan buffer media ke disk sekarang juga (link media WA bisa basi).
async function captureQuotedContent(sock, jid, quotedId, quotedMsg, ctxInfo) {
  const fakeMsg = {
    key: { remoteJid: jid, fromMe: false, id: quotedId, participant: ctxInfo?.participant || jid },
    message: quotedMsg,
  };

  if (quotedMsg.imageMessage) {
    const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const fname = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(REMIND_MEDIA_DIR, fname), buf);
    return { type: 'image', mediaFile: fname, text: quotedMsg.imageMessage.caption || '' };
  }
  if (quotedMsg.videoMessage) {
    const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const fname = `vid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;
    fs.writeFileSync(path.join(REMIND_MEDIA_DIR, fname), buf);
    return { type: 'video', mediaFile: fname, text: quotedMsg.videoMessage.caption || '' };
  }
  if (quotedMsg.audioMessage) {
    const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const fname = `aud_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.ogg`;
    fs.writeFileSync(path.join(REMIND_MEDIA_DIR, fname), buf);
    return { type: 'audio', mediaFile: fname, ptt: !!quotedMsg.audioMessage.ptt, text: '' };
  }
  if (quotedMsg.stickerMessage) {
    const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const fname = `stk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webp`;
    fs.writeFileSync(path.join(REMIND_MEDIA_DIR, fname), buf);
    return { type: 'sticker', mediaFile: fname, text: '' };
  }

  const textContent = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '';
  if (!textContent) throw new Error('Tipe pesan yang di-reply tidak didukung.');
  return { type: 'text', text: textContent };
}

async function sendReminderContent(sock, jid, content) {
  if (content.type === 'text') {
    await safeSend(sock, jid, { text: content.text });
    return;
  }

  const filePath = path.join(REMIND_MEDIA_DIR, content.mediaFile);
  if (!fs.existsSync(filePath)) {
    await safeSend(sock, jid, { text: '⚠️ File media reminder sudah tidak ada.' });
    return;
  }
  const buffer  = fs.readFileSync(filePath);
  const caption = content.text ? content.text : '';

  if (content.type === 'image') {
    await safeSend(sock, jid, { image: buffer, caption });
  } else if (content.type === 'video') {
    await safeSend(sock, jid, { video: buffer, caption });
  } else if (content.type === 'audio') {
    await safeSend(sock, jid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: content.ptt });
  } else if (content.type === 'sticker') {
    await safeSend(sock, jid, { sticker: buffer });
  }
  // Catatan: file media SENGAJA tidak dihapus di sini karena reminder ini
  // berulang terus tiap `intervalMs` sampai di-.delremind.
}

// Reminder ini bersifat recurring: begitu waktunya tiba, konten dikirim,
// lalu dijadwalkan ulang otomatis tiap `r.intervalMs` sampai di-.delremind.
function scheduleReminder(r) {
  const delay = r.dueAt - Date.now();
  const fire = async () => {
    if (!reminders.has(r.id)) return; // udah dibatalkan sebelum sempat jalan

    if (!botSock) {
      // Belum konek, coba lagi sebentar
      r.timer = setTimeout(fire, 5000);
      return;
    }

    try {
      await sendReminderContent(botSock, r.jid, r.content);
    } catch (e) {
      log.err(`Gagal kirim reminder #${r.id}: ${e.message}`);
    }

    if (!reminders.has(r.id)) return; // dibatalkan pas lagi ngirim

    r.dueAt = Date.now() + r.intervalMs;
    persistReminders();
    r.timer = setTimeout(fire, r.intervalMs);
  };

  if (delay <= 0) {
    // Udah lewat waktu (misal bot sempat mati), langsung kirim lalu lanjut siklusnya
    fire();
  } else {
    r.timer = setTimeout(fire, delay);
  }
}

function addReminder(jid, content, intervalMs) {
  const id = reminderIdCounter++;
  const dueAt = Date.now() + intervalMs;
  const r = { id, jid, content, dueAt, intervalMs, createdAt: Date.now(), timer: null };
  reminders.set(id, r);
  scheduleReminder(r);
  persistReminders();
  return r;
}

function cancelReminder(id, jid) {
  const r = reminders.get(id);
  if (!r || r.jid !== jid) return false;
  if (r.timer) clearTimeout(r.timer);
  if (r.content?.mediaFile) {
    try { fs.unlinkSync(path.join(REMIND_MEDIA_DIR, r.content.mediaFile)); } catch (_) {}
  }
  reminders.delete(id);
  persistReminders();
  return true;
}

function listReminders(jid) {
  return Array.from(reminders.values())
    .filter((r) => r.jid === jid)
    .sort((a, b) => a.dueAt - b.dueAt);
}

function formatDueAt(ts) {
  return new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

loadReminders();

//----------SAFE SEND----------
async function safeSend(sock, jid, content) {
  try {
    return await sock.sendMessage(jid, content);
  } catch (e) {
    log.warn(`safeSend failed to ${jid}: ${e.message}`);
    return null;
  }
}

//----------REACTION----------
async function reactToMessage(sock, msg, emoji = '👁️') {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: emoji, key: msg.key },
    });
  } catch (_) {}
}

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

//----------TMP DIR----------
const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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

//----------EXTRACT VIEW ONCE-----------
function extractViewOnce(msg) {
  if (!msg?.message) return null;

  const m = msg.message;
  let media = null;
  let type  = null;

  const wrapper =
    m.viewOnceMessageV2          ||
    m.viewOnceMessage            ||
    m.viewOnceMessageV2Extension ||
    null;

  if (wrapper?.message) {
    const inner = wrapper.message;
    if (inner.imageMessage)      { media = inner.imageMessage; type = 'image'; }
    else if (inner.videoMessage) { media = inner.videoMessage; type = 'video'; }
    else if (inner.audioMessage) { media = inner.audioMessage; type = 'audio'; }
  }

  if (!media) {
    if (m.imageMessage?.viewOnce)      { media = m.imageMessage; type = 'image'; }
    else if (m.videoMessage?.viewOnce) { media = m.videoMessage; type = 'video'; }
    else if (m.audioMessage?.viewOnce) { media = m.audioMessage; type = 'audio'; }
  }

  if (!media && m.ephemeralMessage?.message) {
    const ep = m.ephemeralMessage.message;
    const epWrapper =
      ep.viewOnceMessageV2          ||
      ep.viewOnceMessage            ||
      ep.viewOnceMessageV2Extension ||
      null;
    if (epWrapper?.message) {
      const inner = epWrapper.message;
      if (inner.imageMessage)      { media = inner.imageMessage; type = 'image'; }
      else if (inner.videoMessage) { media = inner.videoMessage; type = 'video'; }
      else if (inner.audioMessage) { media = inner.audioMessage; type = 'audio'; }
    }
    if (!media) {
      if (ep.imageMessage?.viewOnce)      { media = ep.imageMessage; type = 'image'; }
      else if (ep.videoMessage?.viewOnce) { media = ep.videoMessage; type = 'video'; }
      else if (ep.audioMessage?.viewOnce) { media = ep.audioMessage; type = 'audio'; }
    }
  }

  if (!media || !type) return null;

  return {
    type,
    media,
    msg,
    sender : msg.key?.participant || msg.key?.remoteJid || null,
    chatJid: msg.key?.remoteJid,
    msgId: msg.key?.id,
  };
}

//----------PROCESS VIEW ONCE----------
async function processViewOnce(sock, data, quotedMsg = null) {
  const { type, media, msg, chatJid } = data;
  const mimetype = media.mimetype || (type === 'audio' ? 'audio/ogg; codecs=opus' : `${type}/unknown`);

  log.info(`View Once → type: ${type} | chat: ${chatJid}`);

  const quoted = quotedMsg || msg;

  try {
    await safeSend(sock, chatJid, {
      text: `👁️ *View Once terdeteksi!* Tipe: ${type}`,
      quoted,
    });

    if (CONFIG.AUTO_REACT) {
      await reactToMessage(sock, msg, '👁️');
    }

    const buffer = await downloadMediaMessage(
      msg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    if (!buffer || buffer.length === 0) throw new Error('Buffer kosong');

    stats.inc(type);
    log.ok(`Downloaded ${type} (${(buffer.length / 1024).toFixed(1)} KB)`);

    const caption = `😹 ${(buffer.length / 1024).toFixed(1)} KB`;
    const opts = { quoted };

    if (type === 'image') {
      await sock.sendMessage(chatJid, { image: buffer, caption, mimetype }, opts);
    } else if (type === 'video') {
      await sock.sendMessage(chatJid, { video: buffer, caption, mimetype }, opts);
    } else if (type === 'audio') {
      await sock.sendMessage(chatJid, {
        audio: buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      }, opts);
    }

    log.ok(`Sent back ${type} to ${chatJid}`);

  } catch (err) {
    stats.failed++;
    log.err(`processViewOnce error: ${err.message}`);
    await safeSend(sock, chatJid, {
      text: `❌ *Gagal membuka View Once*\n⚠️ ${err.message}`,
      quoted,
    });
  }
}

//----------COMMAND HANDLER----------
async function handleCommand(sock, msg, text) {
  const jid = msg.key?.remoteJid;
  if (!jid || !text?.startsWith('.')) return;

  const cmd = text.trim().split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case '.help':
  await safeSend(sock, jid, {
    text:
      `╭─「 *WhatsApp Bot* 」\n` +
      `│\n` +

      `├─ *Media*\n` +
      `│  ├ • *.open*\n` +
      `│  ├ • *.sticker*\n` +
      `│  ├ • *.toimage*\n` +
      `│  └ • *.tovideo*\n` +
      `│\n` +

      `├─ *Downloader*\n` +
      `│  ├ • Kirim link *(Auto)*\n` +
      `│  ├ • *.dl <link>*\n` +
      `│  ├ • *.dlon* / *.dloff*\n` +
      `│  └ • *.dlstatus*\n` +
      `│\n` +

      `├─ *Scheduler*\n` +
      `│  ├ • *Reply pesan* + *.reminder <detik>*\n` +
      `│  ├ • *.reminders*\n` +
      `│  └ • *.delremind <id>*\n` +
      `│\n` +

      `├─ *Sistem*\n` +
      `│  ├ • *.status*\n` +
      `│  ├ • *.ping*\n` +
      `│  └ • *.uptime*\n` +
      `│\n` +

      `╰─ *Version ${CONFIG.VERSION}*`,
  });
  break;

case '.status': {
  const s = stats;
  await safeSend(sock, jid, {
    text:
      `╭─「 *Bot Status* 」\n` +
      `│\n` +
      `├─ *Statistik*\n` +
      `│  ├Images         : ${s.image}\n` +
      `│  ├Videos          : ${s.video}\n` +
      `│  ├Audios          : ${s.audio}\n` +
      `│  ├Sticker          : ${s.sticker}\n` +
      `│  ├Download    : ${s.download}\n` +
      `│  ├Failed           : ${s.failed}\n` +
      `│  └Total             : ${s.total()}\n` +
      `│\n` +
      `├─ *Informasi*\n` +
      `│  ├ Uptime      : ${s.uptime()}\n` +
      `│  └ Version     : ${CONFIG.VERSION}\n` +
      `│\n` +
      `╰─ Bot Berjalan Normal`,
  });
  break;
}


    case '.ping':
      await safeSend(sock, jid, { text: '🏓 Pong! Bot aktif.' });
      break;

    case '.uptime':
      await safeSend(sock, jid, { text: `⏱️ *Uptime:* ${stats.uptime()}` });
      break;

    //------(.open) - BUKA VIEW ONCE------
    case '.open': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedId = ctxInfo?.stanzaId;
      const quotedMsg = ctxInfo?.quotedMessage;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke pesan view once, lalu ketik *.open*`,
          quoted: msg,
        });
        break;
      }

      const fakeMsg = {
        key: {
          remoteJid: jid,
          fromMe: false,
          id: quotedId,
          participant: ctxInfo?.participant || jid,
        },
        message: quotedMsg,
      };

      const vo = extractViewOnce(fakeMsg);
      if (!vo) {
        await safeSend(sock, jid, {
          text: `⚠️ Bukan view once atau sudah expired.`,
          quoted: msg,
        });
        break;
      }

      await processViewOnce(sock, { ...vo, chatJid: jid }, msg);
      break;
    }

    //------(.tag) - CEK STATUS BOT AUTO TAG ALL MEMBERS------
    case '.tag': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ .tag hanya bisa di grup!' });
        break;
      }

      const isActive = tagStates.get(jid) === true;
      const groupMeta = await sock.groupMetadata(jid);
      const count = groupMeta.participants.length;

      await safeSend(sock, jid, {
        text: `📊 *Status Bot Auto-Tag*\n\n` +
              `📌 Grup: ${groupMeta.subject}\n` +
              `👥 Member: ${count} orang\n` +
              `🔔 Status: ${isActive ? '✅ AKTIF' : '❌ NONAKTIF'}\n` +
              `👻 Mode: INVISIBLE (tanpa @)\n\n` +
              `${isActive ? '🔄 .tagoff untuk matikan' : '🔄 .tagon untuk aktifkan'}`,
      });
      break;
    }

    //------(.tagon) - AKTIFKAN BOT AUTO TAG ALL MEMBERS (INVISIBLE)------
    case '.tagon': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ .tagon hanya bisa di grup!' });
        break;
      }

      tagStates.set(jid, true);
      saveTagStates();

      const groupMeta = await sock.groupMetadata(jid);
      const count = groupMeta.participants.length;

      await safeSend(sock, jid, {
        text: `🔔 *Bot Auto-Tag ALL AKTIF!*\n\n` +
              `📌 Setiap pesan BOT akan otomatis ngetag *${count}* member\n` +
              `👻 TAPI *TANPA* @ muncul di chat!\n` +
              `🚫 Matikan dengan *.tagoff*`,
      });
      break;
    }

    //------(.tagoff) - MATIKAN BOT AUTO TAG ALL MEMBERS------
    case '.tagoff': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ .tagoff hanya bisa di grup!' });
        break;
      }

      tagStates.set(jid, false);
      saveTagStates();

      await safeSend(sock, jid, {
        text: `🔕 *Bot Auto-Tag ALL NONAKTIF!*\n\n` +
              `📌 Pesan BOT akan dikirim normal tanpa tag.\n` +
              `🔄 Aktifkan lagi dengan *.tagon*`,
      });
      break;
    }

    //------(.dloff) - MATIKAN AUTO-DOWNLOAD LINK DI CHAT INI (GRUP/PRIBADI)------
    case '.dloff': {
      dlOffStates.set(jid, true);
      saveDlOffStates();
      await safeSend(sock, jid, {
        text: `🔕 *Auto-download link DIMATIKAN* di chat ini.\n\n` +
              `📌 Link TikTok/IG/X/FB/YouTube yang dikirim di sini gak bakal auto-download lagi.\n` +
              `💡 *.dl <link>* tetap bisa dipakai manual.\n` +
              `🔄 Aktifkan lagi dengan *.dlon*`,
        quoted: msg,
      });
      break;
    }

    //------(.dlon) - AKTIFKAN LAGI AUTO-DOWNLOAD LINK DI CHAT INI------
    case '.dlon': {
      dlOffStates.delete(jid);
      saveDlOffStates();
      await safeSend(sock, jid, {
        text: `🔔 *Auto-download link AKTIF* lagi di chat ini.\n\n` +
              `📌 Kirim link TikTok/IG/X/FB/YouTube langsung auto-download.`,
        quoted: msg,
      });
      break;
    }

    //------(.dlstatus) - CEK STATUS AUTO-DOWNLOAD DI CHAT INI------
    case '.dlstatus': {
      const enabled = isAutoDownloadEnabled(jid);
      await safeSend(sock, jid, {
        text: `📊 *Status Auto-Download di chat ini:*\n` +
              `${enabled ? '✅ AKTIF' : '❌ NONAKTIF'}\n\n` +
              `${enabled ? '🔄 .dloff untuk matikan' : '🔄 .dlon untuk aktifkan'}`,
        quoted: msg,
      });
      break;
    }

    //------(.sticker) - MANUAL STICKER (REPLY FOTO/VIDEO)-------
    case '.sticker': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke foto/video, lalu ketik *.sticker*`,
          quoted: msg,
        });
        break;
      }

      const isImage = !!quotedMsg?.imageMessage;
      const isVideo = !!quotedMsg?.videoMessage;
      const isSticker = !!quotedMsg?.stickerMessage;

      if (isSticker) {
        await safeSend(sock, jid, {
          text: `⚠️ Ini sudah stiker. Pake *.toimage* atau *.tovideo* kalo mau balikin.`,
          quoted: msg,
        });
        break;
      }

      if (!isImage && !isVideo) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke *foto* atau *video*, bukan pesan lain.`,
          quoted: msg,
        });
        break;
      }

      const mediaMsg = {
        key: {
          remoteJid: jid,
          fromMe: false,
          id: quotedId,
          participant: ctxInfo?.participant || jid,
        },
        message: quotedMsg,
      };

      try {
        await safeSend(sock, jid, {
          text: `🎨 Membuat stiker...`,
          quoted: msg,
        });

        const buffer = await downloadMediaMessage(
          mediaMsg,
          'buffer',
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || buffer.length === 0) {
          throw new Error('Buffer kosong');
        }

        await sendSticker(sock, jid, buffer, msg, isVideo);
        log.ok(`✅ Sticker created from ${isImage ? 'image' : 'video'}`);

      } catch (e) {
        log.err(`Sticker creation failed: ${e.message}`);
        await safeSend(sock, jid, {
          text: `❌ Gagal buat stiker: ${e.message}`,
          quoted: msg,
        });
      }
      break;
    }

    //------(.toimage) - CONVERT STICKER KE GAMBAR------
    case '.toimage': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke stiker, lalu ketik *.toimage*`,
          quoted: msg,
        });
        break;
      }

      if (!quotedMsg?.stickerMessage) {
        await safeSend(sock, jid, {
          text: `⚠️ Pesan yang di-reply bukan stiker.`,
          quoted: msg,
        });
        break;
      }

      const stickerMsg = {
        key: {
          remoteJid: jid,
          fromMe: false,
          id: quotedId,
          participant: ctxInfo?.participant || jid,
        },
        message: quotedMsg,
      };

      await convertStickerToMedia(sock, jid, stickerMsg, 'image');
      break;
    }

    //------(.tovideo) - CONVERT STICKER KE VIDEO------
    case '.tovideo': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke stiker, lalu ketik *.tovideo*`,
          quoted: msg,
        });
        break;
      }

      if (!quotedMsg?.stickerMessage) {
        await safeSend(sock, jid, {
          text: `⚠️ Pesan yang di-reply bukan stiker.`,
          quoted: msg,
        });
        break;
      }

      const stickerMsg = {
        key: {
          remoteJid: jid,
          fromMe: false,
          id: quotedId,
          participant: ctxInfo?.participant || jid,
        },
        message: quotedMsg,
      };

      await convertStickerToMedia(sock, jid, stickerMsg, 'video');
      break;
    }

    //------(.dl) - DOWNLOAD MANUAL DARI LINK-------
    case '.dl': {
      const arg = text.slice(4).trim();
      const urlMatch = arg.match(URL_REGEX);
      if (!urlMatch) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *.dl <link>*\n\nContoh: .dl https://vt.tiktok.com/xxxxx`,
          quoted: msg,
        });
        break;
      }

      const url = urlMatch[0];
      const platform = detectPlatform(url);
      if (!platform) {
        await safeSend(sock, jid, {
          text: `⚠️ Link tidak dikenali. Yang didukung: TikTok, Instagram, X/Twitter, Facebook, YouTube.`,
          quoted: msg,
        });
        break;
      }

      log.info(`📥 .dl request: ${platform} from ${jid}`);
      const statusMsg = await safeSend(sock, jid, { text: '⏳ Lagi download, tunggu sebentar...', quoted: msg });

      try {
        await runDownloader(sock, jid, url, platform, msg);
        if (statusMsg) { try { await sock.sendMessage(jid, { delete: statusMsg.key }); } catch (_) {} }
        log.ok(`✅ Download berhasil untuk ${platform}`);
      } catch (err) {
        log.err(`Download error: ${err.message}`);
        const errorText = `⚠️ Download gagal:\n\n${(err.message || 'unknown error').slice(0, 400)}`;
        if (statusMsg) {
          try { await sock.sendMessage(jid, { text: errorText, edit: statusMsg.key }); }
          catch (_) { await safeSend(sock, jid, { text: errorText, quoted: msg }); }
        } else {
          await safeSend(sock, jid, { text: errorText, quoted: msg });
        }
      }
      break;
    }

    //------(.reminder) - REPLY PESAN + DETIK, FORWARD OTOMATIS------
    case '.reminder': {
      const argParts = text.trim().split(/\s+/);
      const secArg = parseInt(argParts[1], 10);

      const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
      const quotedId  = ctxInfo?.stanzaId;
      const quotedMsg = ctxInfo?.quotedMessage;

      if (!quotedMsg || !quotedId) {
        await safeSend(sock, jid, {
          text:
            `⚠️ Reply ke pesan (foto/video/audio/sticker/teks) yang mau dijadwalkan, lalu ketik *.reminder <detik>*\n\n` +
            `Contoh: .reminder 600  (600 detik = 10 menit)`,
          quoted: msg,
        });
        break;
      }

      if (!secArg || secArg <= 0) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *.reminder <detik>*\n\nContoh: .reminder 600`,
          quoted: msg,
        });
        break;
      }

      try {
        const content = await captureQuotedContent(sock, jid, quotedId, quotedMsg, ctxInfo);
        const intervalMs = secArg * 1000;
        const r = addReminder(jid, content, intervalMs);
        await safeSend(sock, jid, {
          text:
            `⏰ *Reminder #${r.id} diset!*\n` +
            `🔁 Diulang tiap ${secArg} detik, terus-menerus\n` +
            `📅 Kirim pertama: ${formatDueAt(r.dueAt)}\n` +
            `📎 Tipe: ${content.type}\n\n` +
            `_Stop kapan aja: .delremind ${r.id}_`,
          quoted: msg,
        });
      } catch (e) {
        await safeSend(sock, jid, { text: `❌ Gagal simpan reminder: ${e.message}`, quoted: msg });
      }
      break;
    }

    //------(.reminders) - LIST REMINDER AKTIF------
    case '.reminders': {
      const list = listReminders(jid);
      if (!list.length) {
        await safeSend(sock, jid, { text: '📋 Tidak ada reminder aktif di chat ini.' });
        break;
      }
      const body = list.map((r) => {
        const preview = r.content.type === 'text'
          ? r.content.text
          : `[${r.content.type}]${r.content.text ? ' ' + r.content.text : ''}`;
        return `#${r.id} - tiap ${r.intervalMs / 1000}d - berikutnya ${formatDueAt(r.dueAt)}\n   ${preview}`;
      }).join('\n\n');
      await safeSend(sock, jid, {
        text: `⏰ *Reminder Aktif (${list.length})*\n\n${body}\n\n_Hapus: .delremind <id>_`,
      });
      break;
    }

    //------(.delremind) - BATALKAN REMINDER------
    case '.delremind': {
      const idArg = parseInt(text.slice(11).trim(), 10);
      if (!idArg) {
        await safeSend(sock, jid, { text: `⚠️ Format: *.delremind <id>*` });
        break;
      }
      const ok = cancelReminder(idArg, jid);
      await safeSend(sock, jid, {
        text: ok ? `🗑️ Reminder #${idArg} dibatalkan.` : `⚠️ Reminder #${idArg} tidak ditemukan.`,
      });
      break;
    }

    // .set — TAMBAH AUTO REPLY
    default: {
      if (!text.startsWith('.set') && !text.startsWith('.del') && text !== '.listauto') break;

      if (!isPrivateJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ Auto-reply hanya tersedia di private chat.' });
        break;
      }

      if (text === '.listauto') {
        const keys = Object.keys(autoReplies);
        if (keys.length === 0) {
          await safeSend(sock, jid, { text: '📋 Belum ada auto-reply.\n\nGunakan *.set trigger | balasan* untuk menambah.' });
          break;
        }
        const list = keys.map((k, i) => {
          const e = autoReplies[k];
          const trigLabel = k.startsWith('__photo__') ? `[foto:${k.slice(9, 17)}]` : k;
          const valLabel  = e.type === 'photo' ? `[foto] ${e.caption || ''}` : e.value;
          return `${i + 1}. *${trigLabel}* -> ${valLabel}`;
        }).join('\n');
        await safeSend(sock, jid, { text: `📋 *Daftar Auto-Reply (${keys.length}):*\n\n${list}\n\n_Hapus: .del <trigger>_` });
        break;
      }

      if (text.startsWith('.del')) {
        const trigger = text.slice(4).trim().toLowerCase();
        if (!trigger) {
          await safeSend(sock, jid, { text: '⚠️ Format: *.del trigger*' });
          break;
        }
        if (!autoReplies[trigger]) {
          await safeSend(sock, jid, { text: `⚠️ Trigger *${trigger}* tidak ditemukan.` });
          break;
        }
        if (autoReplies[trigger].type === 'photo') {
          try { fs.unlinkSync(path.join(PHOTO_STORE_DIR, autoReplies[trigger].value)); } catch (_) {}
        }
        delete autoReplies[trigger];
        saveAutoReplies(autoReplies);
        await safeSend(sock, jid, { text: `🗑️ Auto-reply *${trigger}* dihapus.` });
        break;
      }

      const setArg = text.slice(4).trim();
      const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId  = ctxInfo?.stanzaId;
      const selfPhoto = msg.message?.imageMessage || null;

      let trigger = null;
      let replyEntry = null;

      if (quotedMsg) {
        const qText  = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || null;
        const qPhoto = quotedMsg?.imageMessage || null;

        if (qPhoto) {
          const fakeMsg = {
            key    : { remoteJid: jid, fromMe: false, id: quotedId, participant: ctxInfo?.participant || jid },
            message: quotedMsg,
          };
          try {
            const buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            trigger = photoHash(buf);
            const tFile = path.join(PHOTO_STORE_DIR, `trigger_${trigger.slice(9)}.jpg`);
            fs.writeFileSync(tFile, buf);
          } catch (e) {
            await safeSend(sock, jid, { text: '❌ Gagal download foto trigger: ' + e.message });
            break;
          }
        } else if (qText) {
          trigger = qText.trim().toLowerCase();
        }

        if (selfPhoto) {
          try {
            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const fname = `reply_${Date.now()}.jpg`;
            fs.writeFileSync(path.join(PHOTO_STORE_DIR, fname), buf);
            replyEntry = { type: 'photo', value: fname, caption: selfPhoto.caption || '' };
          } catch (e) {
            await safeSend(sock, jid, { text: '❌ Gagal simpan foto balasan: ' + e.message });
            break;
          }
        } else {
          replyEntry = { type: 'text', value: setArg };
        }

      } else {
        if (selfPhoto) {
          trigger = setArg.toLowerCase();
          try {
            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const fname = `reply_${Date.now()}.jpg`;
            fs.writeFileSync(path.join(PHOTO_STORE_DIR, fname), buf);
            replyEntry = { type: 'photo', value: fname, caption: msg.message?.imageMessage?.caption?.replace(/^\.set\s*/i,'').replace(trigger,'').trim() || '' };
          } catch (e) {
            await safeSend(sock, jid, { text: '❌ Gagal simpan foto: ' + e.message });
            break;
          }
        } else {
          const sep = setArg.indexOf('|');
          if (sep === -1) {
            await safeSend(sock, jid, {
              text:
                '⚠️ *Format .set:*\n\n' +
                '*1. Trigger teks → balas teks:*\n   .set halo | hai juga!\n\n' +
                '*2. Trigger teks → balas foto:*\n   [kirim foto] caption: .set halo\n\n' +
                '*3. Trigger foto → balas teks:*\n   [reply foto] .set balasan kamu\n\n' +
                '*4. Trigger foto → balas foto:*\n   [reply foto] kirim .set [dengan foto]',
            });
            break;
          }
          trigger    = setArg.slice(0, sep).trim().toLowerCase();
          replyEntry = { type: 'text', value: setArg.slice(sep + 1).trim() };
        }
      }

      if (!trigger) {
        await safeSend(sock, jid, { text: '⚠️ Trigger tidak boleh kosong.' });
        break;
      }
      if (!replyEntry || (!replyEntry.value)) {
        await safeSend(sock, jid, { text: '⚠️ Balasan tidak boleh kosong.' });
        break;
      }

      autoReplies[trigger] = replyEntry;
      saveAutoReplies(autoReplies);

      const trigLabel = trigger.startsWith('__photo__') ? '[foto]' : `*${trigger}*`;
      const valLabel  = replyEntry.type === 'photo' ? '📸 foto' : replyEntry.value;
      log.ok(`Auto-reply set: "${trigger}" -> ${valLabel}`);
      await safeSend(sock, jid, {
        text: `✅ *Auto-reply disimpan!*

📌 Trigger : ${trigLabel}
💬 Balasan : ${valLabel}`,
        quoted: msg,
      });
      break;
    }
  }
}

// ============================================================
// MESSAGES.UPSERT
// ============================================================
async function handleUpsert(sock, { messages, type }) {
  if (type !== 'notify') return;

  for (const msg of messages) {
    try {
      const jid = msg.key?.remoteJid || '';
      const fromMe = !!msg.key?.fromMe;
      const msgKeys = Object.keys(msg.message || {}).join(',');

      if (isJidBroadcast(jid)) continue;
      if (jid === 'status@broadcast') continue;

      // Hitung umur pesan — pesan lama (tertunda saat bot idle) gak perlu
      // di-auto-download/auto-reply, tapi command (.ping dll) tetap jalan.
      const msgTimestamp = (msg.messageTimestamp?.low ?? msg.messageTimestamp) || 0;
      const msgAgeMs = msgTimestamp > 0 ? Date.now() - msgTimestamp * 1000 : 0;
      const isStale = msgAgeMs > 90_000; // > 90 detik = pesan lama/tertunda

      if (isStale) {
        log.dim(`⏭️ Pesan lama (${Math.round(msgAgeMs / 1000)}d) dari ${jid}, skip heavy processing`);
      }

      log.dim(`MSG jid=${jid} fromMe=${fromMe} keys=${msgKeys}`);

      // ──────────────────────────────────────────────────────
      // 🔔 BOT AUTO TAG ALL MEMBERS (INVISIBLE)
      // ──────────────────────────────────────────────────────
      if (isGroupJid(jid) && fromMe && tagStates.get(jid) === true) {
        try {
          const isPlainText = !!(msg.message?.conversation || msg.message?.extendedTextMessage?.text);
          const isImage = !!msg.message?.imageMessage;
          const isVideo = !!msg.message?.videoMessage;
          let msgText = msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption ||
                        null;

          if (msgText && !msgText.startsWith('.')) {
            const groupMeta = await sock.groupMetadata(jid);
            const participants = groupMeta.participants.map(p => p.id);

            if (participants.length > 0) {
              if (isPlainText) {
                // Edit pesan teks langsung di tempat (tanpa hapus)
                await sock.sendMessage(jid, {
                  text: msgText,
                  mentions: participants,
                  edit: msg.key,
                });
                log.dim(`🔔 Bot auto-tag all (edit teks, invisible) in ${jid} (${participants.length} members)`);
              } else if (isImage || isVideo) {
                // Coba edit caption foto/video langsung di tempat (tanpa hapus)
                try {
                  const mediaKey     = isImage ? 'imageMessage' : 'videoMessage';
                  const origContent  = msg.message[mediaKey];

                  const editedMessage = {
                    [mediaKey]: {
                      ...origContent,
                      caption: msgText,
                      contextInfo: {
                        ...(origContent.contextInfo || {}),
                        mentionedJid: participants,
                      },
                    },
                  };

                  await sock.relayMessage(jid, {
                    protocolMessage: {
                      key: msg.key,
                      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
                      editedMessage,
                    },
                  }, {});

                  log.dim(`🔔 Bot auto-tag all (edit caption, invisible) in ${jid} (${participants.length} members)`);
                } catch (editErr) {
                  log.warn(`Edit caption gagal, fallback delete+resend: ${editErr.message}`);
                  await sock.sendMessage(jid, { delete: msg.key });
                  await sock.sendMessage(jid, {
                    text: msgText,
                    mentions: participants,
                  });
                  log.dim(`🔔 Bot auto-tag all (delete+resend fallback) in ${jid} (${participants.length} members)`);
                }
              }
              continue;
            }
          }
        } catch (e) {
          log.err(`Bot auto-tag error: ${e.message}`);
        }
      }

      // ── Cek view once ──────────────────────────────────
      const vo = extractViewOnce(msg);

      if (vo && !fromMe) {
        log.info(`View once detected in ${jid}`);
        if (CONFIG.AUTO_REACT) await reactToMessage(sock, msg, '👁️');
        await safeSend(sock, jid, {
          text: `👁️ *View Once terdeteksi!* Tipe: ${vo.type}`,
          quoted: msg,
        });
        continue;
      }

      // ──────────────────────────────────────────────────────
      // 📥 AUTO DOWNLOAD LINK (TikTok, Instagram, X, Facebook, YouTube)
      // Aktif untuk semua pesan (termasuk dari akun bot sendiri / fromMe),
      // biar bot bisa dipakai langsung dari akun itu sendiri.
      // ──────────────────────────────────────────────────────
      if (CONFIG.AUTO_DOWNLOAD_LINKS && isAutoDownloadEnabled(jid) && !isStale) {
        const bodyText = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || ''
        ).trim();

        // Jangan bentrok sama command (.dl, dst) — itu ditangani di handleCommand
        if (bodyText && !bodyText.startsWith('.')) {
          const urlMatch = bodyText.match(URL_REGEX);
          if (urlMatch) {
            const url = urlMatch[0];
            const platform = detectPlatform(url);

            if (platform && !isRecentlyProcessed(url)) {
              log.info(`📥 Auto-download: ${platform} from ${jid}${fromMe ? ' (self)' : ''}`);
              const statusMsg = await safeSend(sock, jid, {
                text: '⏳ Lagi download, tunggu sebentar...',
                quoted: msg,
              });

              try {
                await runDownloader(sock, jid, url, platform, msg);
                if (statusMsg) { try { await sock.sendMessage(jid, { delete: statusMsg.key }); } catch (_) {} }
                log.ok(`✅ Auto-download berhasil untuk ${platform}`);
              } catch (err) {
                log.err(`Auto-download error: ${err.message}`);
                const errorText = `⚠️ Download gagal:\n\n${(err.message || 'unknown error').slice(0, 400)}`;
                if (statusMsg) {
                  try { await sock.sendMessage(jid, { text: errorText, edit: statusMsg.key }); }
                  catch (_) { await safeSend(sock, jid, { text: errorText, quoted: msg }); }
                } else {
                  await safeSend(sock, jid, { text: errorText, quoted: msg });
                }
              }
              continue;
            }
          }
        }
      }

      // ── Auto-reply (hanya private, bukan fromMe) ─────────
      if (!fromMe && isPrivateJid(jid)) {
        const incomingText = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || ''
        ).trim().toLowerCase();

        const incomingPhoto = msg.message?.imageMessage || null;

        let arEntry = null;

        if (incomingPhoto && !isStale) {
          try {
            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const key = photoHash(buf);
            if (autoReplies[key]) arEntry = { key, entry: autoReplies[key] };
          } catch (_) {}
        }

        if (!arEntry && incomingText && autoReplies[incomingText]) {
          arEntry = { key: incomingText, entry: autoReplies[incomingText] };
        }

        if (arEntry) {
          log.dim(`Auto-reply hit: "${arEntry.key}"`);
          await sendAutoReply(sock, jid, arEntry.entry, msg);
          continue;
        }
      }

      // ── Command ──────────────────────────────────────────
      const cmdText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        null;
      if (fromMe && (!cmdText || !cmdText.trim().startsWith('.'))) continue;

      if (cmdText && cmdText.trim().startsWith('.')) {
        log.dim(`CMD from ${jid}: ${cmdText.trim()}`);
        await handleCommand(sock, msg, cmdText.trim());
      }

    } catch (err) {
      log.err(`handleUpsert error: ${err.message}`);
    }
  }
}

// ============================================================
// WEB SERVER (liat QR dari browser: /qr)
// ============================================================
let lastQR = null; // di-set di listener connection.update pas ada QR baru, di-clear pas connect

const app = express();

app.get('/qr', async (req, res) => {
  if (!lastQR) return res.send('Belum ada QR atau udah connect.');
  try {
    const png = await QRCode.toBuffer(lastQR, { width: 400 });
    res.type('png').send(png);
  } catch (err) {
    log.err(`Route /qr error: ${err.message}`);
    res.status(500).send('Gagal generate QR.');
  }
});

app.listen(CONFIG.WEB_PORT, () => {
  log.ok(`🌐 QR web server jalan di http://localhost:${CONFIG.WEB_PORT}/qr`);
});

// ============================================================
// MAIN BOT
// ============================================================
let reconnectCount = 0;
let isConnecting = false;

async function startBot() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    console.log(chalk.cyan(`
╔═══════════════════════════════════════════════════════════╗
║   📸  WhatsApp Bot - View Once + Sticker + Downloader     ║
║   Version : ${CONFIG.VERSION}                                       ║
║   ✨ .sticker | .toimage | .tovideo | .tag | .dl         ║
╚═══════════════════════════════════════════════════════════╝
`));

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_FOLDER);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: true,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25_000,       // Ping WA server tiap 25 detik biar koneksi gak mati
      retryRequestDelayMs: 2_000,        // Retry lebih cepat kalau ada request gagal
      getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isOnline, receivedPendingNotifications } = update;
      if (qr) {
        lastQR = qr;
        qrcode.generate(qr, { small: true });
        log.info(`Scan QR di atas (atau buka http://localhost:${CONFIG.WEB_PORT}/qr).`);
      }
      if (connection === 'connecting') {
        log.info('🔄 Menghubungkan ke WhatsApp...');
      }
      if (connection === 'open') {
        reconnectCount = 0; isConnecting = false;
        lastQR = null; // udah connect, QR lama gak valid lagi
        botSock = sock;
        log.ok(`✅ Bot connected!`);
        log.info('📥 Menunggu pesan...');

        // Jadwalkan ulang reminder yang belum punya timer aktif (mis. abis restart)
        for (const r of reminders.values()) {
          if (!r.timer) scheduleReminder(r);
        }
      }
      if (receivedPendingNotifications) {
        log.ok('📬 Pending notifications synced — koneksi fully ready.');
      }
      if (connection === 'close') {
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log.err('Logged out. Hapus auth_info dan restart.');
          return;
        }
        if (reconnectCount >= CONFIG.MAX_RECONNECT) {
          log.err(`Reconnect limit reached.`);
          process.exit(1);
        }
        reconnectCount++;
        log.warn(`Reconnect ${reconnectCount}/${CONFIG.MAX_RECONNECT}...`);
        setTimeout(startBot, CONFIG.RECONNECT_DELAY_MS);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', (payload) => {
      handleUpsert(sock, payload).catch(err => {
        log.err(`messages.upsert error: ${err.message}`);
      });
    });

    return sock;

  } catch (err) {
    isConnecting = false;
    log.err(`startBot error: ${err.message}`);
    if (reconnectCount < CONFIG.MAX_RECONNECT) {
      reconnectCount++;
      setTimeout(startBot, CONFIG.RECONNECT_DELAY_MS);
    } else { process.exit(1); }
  }
}

// ============================================================
// GUARD
// ============================================================
process.on('unhandledRejection', (reason) => {
  log.err(`unhandledRejection: ${reason.message || reason}`);
});
process.on('uncaughtException', (err) => {
  log.err(`uncaughtException: ${err.message}`);
});
process.on('SIGINT', () => { log.warn('SIGINT. Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { log.warn('SIGTERM. Shutting down...'); process.exit(0); });

startBot();
