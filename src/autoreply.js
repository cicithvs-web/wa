'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { log } = require('./config');
const { safeSend } = require('./helpers');
const { sendNativeFlow } = require('./menu');

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

const autoReplies = loadAutoReplies();
log.info(`Auto-reply loaded: ${Object.keys(autoReplies).length} entri`);

// Hash foto untuk dijadikan trigger key
function photoHash(buffer) {
  return '__photo__' + crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

// Kirim balasan auto-reply (teks, foto, atau dengan tombol)
// entry.buttons: [{ id, text }] (opsional, maks 3 quick reply)
async function sendAutoReply(sock, jid, entry, quotedMsg) {
  try {
    const buttons = Array.isArray(entry.buttons) ? entry.buttons.slice(0, 3) : [];
    const quoted  = quotedMsg || undefined;

    if (entry.type === 'text') {
      if (buttons.length > 0) {
        const ok = await sendNativeFlow(sock, jid, {
          text: entry.value,
          footer: entry.footer || '',
          quoted: quotedMsg,
          buttons: buttons.map(b => ({ type: 'quick_reply', id: b.id, text: b.text })),
        });
        if (ok) return;
        // Fallback: kirim teks + daftar tombol dalam teks
        const btnList = buttons.map(b => `› ${b.text}`).join('\n');
        await safeSend(sock, jid, { text: `${entry.value}\n\n${btnList}`, quoted });
        return;
      }
      await safeSend(sock, jid, { text: entry.value, quoted });

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

module.exports = { autoReplies, saveAutoReplies, photoHash, sendAutoReply, PHOTO_STORE_DIR };
