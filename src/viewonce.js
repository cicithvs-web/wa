'use strict';

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { CONFIG, log, stats, logger } = require('./config');
const { safeSend, reactToMessage } = require('./helpers');

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

//----------VIEW ONCE CACHE STORE----------
const viewOnceStore = new Map(); // msgId -> { vo, msg, buffer, timestamp }
const lastViewOncePerChat = new Map(); // jid -> { vo, msg, buffer, timestamp }

function saveViewOnce(sock, msg) {
  const vo = extractViewOnce(msg);
  if (!vo) return null;

  const id = msg.key?.id;
  const jid = msg.key?.remoteJid;
  const entry = { vo, msg, buffer: null, timestamp: Date.now() };

  if (id) viewOnceStore.set(id, entry);
  if (jid) lastViewOncePerChat.set(jid, entry);

  // Pre-download media di background agar saat .open dipanggil media langsung siap
  if (sock) {
    downloadMediaMessage(
      msg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    ).then((buf) => {
      if (buf && buf.length > 0) {
        entry.buffer = buf;
        log.dim(`Pre-downloaded VO ${id} (${(buf.length / 1024).toFixed(1)} KB)`);
      }
    }).catch((err) => {
      log.dim(`Pre-download VO failed: ${err.message}`);
    });
  }

  // Jaga ukuran cache agar tidak menumpuk di memori
  if (viewOnceStore.size > 100) {
    const oldestKey = viewOnceStore.keys().next().value;
    viewOnceStore.delete(oldestKey);
  }

  return vo;
}

function getLastViewOnce(jid) {
  return lastViewOncePerChat.get(jid) || null;
}

function getViewOnceById(id) {
  return viewOnceStore.get(id) || null;
}

//----------PROCESS VIEW ONCE----------
async function processViewOnce(sock, data, triggerMsg = null, targetMsg = null) {
  const { type, media, msg, chatJid } = data;
  const mimetype = media.mimetype || (type === 'audio' ? 'audio/ogg; codecs=opus' : `${type}/unknown`);

  log.info(`View Once → type: ${type} | chat: ${chatJid}`);

  const quoted = triggerMsg || targetMsg || msg;

  try {
    const buffer = data.buffer || await downloadMediaMessage(
      targetMsg || msg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    if (!buffer || buffer.length === 0) throw new Error('Buffer kosong');

    stats.inc(type);
    log.ok(`Downloaded ${type} (${(buffer.length / 1024).toFixed(1)} KB)`);

    const origCaption = media.caption ? `\n💬 *Caption:* ${media.caption}` : '';
    const caption = `🔓 *View Once (${type})*\n📦 Size: ${(buffer.length / 1024).toFixed(1)} KB${origCaption}`;
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

    if (CONFIG.AUTO_REACT && triggerMsg) {
      await reactToMessage(sock, triggerMsg, '🔓');
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

module.exports = {
  extractViewOnce,
  processViewOnce,
  saveViewOnce,
  getLastViewOnce,
  getViewOnceById,
};
