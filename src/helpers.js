'use strict';

const { log } = require('./config');

async function safeSend(sock, jid, content) {
  try {
    return await sock.sendMessage(jid, content);
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
