'use strict';

const pino  = require('pino');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

//----------CONFIG----------
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
  AUTO_DOWNLOAD_LINKS: true,
  WEB_PORT           : process.env.PORT || 3000, // port buat endpoint /qr
};

//----------DOWNLOADER PATHS----------
const ROOT_DIR    = path.join(__dirname, '..');
const YTDLP_BIN  = path.join(ROOT_DIR, 'bin', 'yt-dlp');
const COOKIES_DIR = path.join(ROOT_DIR, 'cookies');
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

//----------INIT DIRS----------
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

module.exports = {
  CONFIG, YTDLP_BIN, COOKIES_DIR, COOKIES_MAP, URL_REGEX, DL_UA,
  logger, log, stats,
  isGroupJid, isPrivateJid,
};
