'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { log, logger } = require('./config');
const { safeSend } = require('./helpers');

const REMIND_STATE_FILE = './reminders.json';
const REMIND_MEDIA_DIR  = './reminder_media';
if (!fs.existsSync(REMIND_MEDIA_DIR)) fs.mkdirSync(REMIND_MEDIA_DIR, { recursive: true });

const reminders = new Map(); // id -> { id, jid, content, dueAt, intervalMs, createdAt, timer }
let reminderIdCounter = 1;
let botSock = null;

function setBotSock(sock) { botSock = sock; }

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

module.exports = {
  reminders, setBotSock, scheduleReminder,
  captureQuotedContent, addReminder, cancelReminder, listReminders, formatDueAt,
};
