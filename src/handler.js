'use strict';

const fs   = require('fs');
const path = require('path');
const {
  downloadMediaMessage,
  isJidBroadcast,
  proto,
} = require('@whiskeysockets/baileys');
const { CONFIG, URL_REGEX, log, stats, logger, isGroupJid, isPrivateJid } = require('./config');
const { safeSend, reactToMessage } = require('./helpers');
const { extractViewOnce, saveViewOnce } = require('./viewonce');
const { isAutoDownloadEnabled } = require('./dl-toggle');
const { autoReplies, photoHash, sendAutoReply, saveAutoReplies, PHOTO_STORE_DIR } = require('./autoreply');
const { detectPlatform, runDownloader, isRecentlyProcessed } = require('./downloader');
const { tagStates } = require('./tag');
const { handleCommand } = require('./commands');
const { getPrefix } = require('./prefix');
const { handleAiMessage } = require('./ai');

// ============================================================
// MESSAGES.UPSERT
// ============================================================
async function handleUpsert(sock, { messages, type }) {
  if (type !== 'notify' && type !== 'append') return;

  for (const msg of messages) {
    try {
      const jid = msg.key?.remoteJid || '';
      const fromMe = !!msg.key?.fromMe;
      const msgKeys = Object.keys(msg.message || {}).join(',');

      if (isJidBroadcast(jid)) continue;
      if (jid === 'status@broadcast') continue;

      // Hitung umur pesan — pesan lama (tertunda saat bot idle) gak perlu diproses
      const msgTimestamp = (msg.messageTimestamp?.low ?? msg.messageTimestamp) || 0;
      const msgAgeMs = msgTimestamp > 0 ? Date.now() - msgTimestamp * 1000 : 0;
      const isStale = msgAgeMs > 90_000; // > 90 detik = pesan lama/tertunda

      if (isStale) {
        log.dim(`⏭️ Pesan lama (${Math.round(msgAgeMs / 1000)}d) dari ${jid}, skip`);
        continue;
      }

      const prefix = getPrefix();
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

          if (msgText && !msgText.startsWith(prefix)) {
            const groupMeta = await sock.groupMetadata(jid);
            const participants = groupMeta.participants.map(pt => pt.id);

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
        saveViewOnce(sock, msg);
        if (CONFIG.AUTO_REACT) await reactToMessage(sock, msg, '👁️');
        await safeSend(sock, jid, {
          text: `👁️ *View Once terdeteksi!* Tipe: ${vo.type}\n💡 Ketik *${prefix}open* untuk membuka.`,
          quoted: msg,
        });
        continue;
      }

      // ──────────────────────────────────────────────────────
      // 📥 AUTO DOWNLOAD LINK (TikTok, Instagram, X, Facebook, YouTube)
      // ──────────────────────────────────────────────────────
      if (CONFIG.AUTO_DOWNLOAD_LINKS && isAutoDownloadEnabled(jid) && !isStale) {
        const bodyText = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || ''
        ).trim();

        // Jangan bentrok sama command — itu ditangani di handleCommand
        if (bodyText && !bodyText.startsWith(prefix)) {
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

      // ── AI Auto-Reply (private, bukan fromMe, bukan command) ──
      if (!fromMe && isPrivateJid(jid)) {
        const aiText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text || '';

        // Jangan proses kalau ini command bot
        if (!aiText.trim().startsWith(prefix)) {
          const handled = await handleAiMessage(sock, msg);
          if (handled) continue;
        }
      }

      // ── Command ──────────────────────────────────────────
      const cmdText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        null;
      if (fromMe && (!cmdText || !cmdText.trim().startsWith(prefix))) continue;

      if (cmdText && cmdText.trim().startsWith(prefix)) {
        log.dim(`CMD from ${jid}: ${cmdText.trim()}`);
        await handleCommand(sock, msg, cmdText.trim());
      }

    } catch (err) {
      log.err(`handleUpsert error: ${err.message}`);
    }
  }
}

module.exports = { handleUpsert };
