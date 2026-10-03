'use strict';

const { log } = require('./config');

async function safeSend(sock, jid, content, options = {}) {
  try {
    const opts = { ...options };
    const payload = { ...content };
    if (payload.quoted) {
      if (!opts.quoted) opts.quoted = payload.quoted;
      delete payload.quoted;
    }
    return await sock.sendMessage(jid, payload, opts);
  } catch (e) {
    log.warn(`safeSend failed to ${jid}: ${e.message}`);
    return null;
  }
}

async function reactToMessage(sock, msg, emoji = '👁️') {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: emoji, key: msg.key },
    });
  } catch (_) {}
}

module.exports = { safeSend, reactToMessage };
