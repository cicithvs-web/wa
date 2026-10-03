'use strict';

const fs   = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { CONFIG, URL_REGEX, OWNER_ONLY_COMMANDS, log, stats, logger, isGroupJid, isPrivateJid } = require('./config');
const { safeSend } = require('./helpers');
const { extractViewOnce, processViewOnce, getLastViewOnce, getViewOnceById } = require('./viewonce');
const { tagStates, saveTagStates } = require('./tag');
const { dlOffStates, saveDlOffStates, isAutoDownloadEnabled } = require('./dl-toggle');
const { sendSticker, convertStickerToMedia, convertMediaToAudio } = require('./sticker');
const { detectPlatform, runDownloader } = require('./downloader');
const { captureQuotedContent, addReminder, cancelReminder, listReminders, formatDueAt } = require('./reminders');
const { autoReplies, saveAutoReplies, photoHash, PHOTO_STORE_DIR } = require('./autoreply');
const { getPrefix, setPrefix } = require('./prefix');
const {
  getWelcomeState, setWelcomeEnabled, setWelcomeMsg, setByeMsg,
  DEFAULT_WELCOME, DEFAULT_BYE,
} = require('./welcome');
const {
  aiConfig, saveAiConfig, isAiEnabled, setAiEnabled,
  clearHistory, DEFAULT_SYSTEM_PROMPT, askStatelessAI, extractDocumentText,
} = require('./ai');

//----------COMMAND HANDLER----------
async function handleCommand(sock, msg, text) {
  const jid = msg.key?.remoteJid;
  const p = getPrefix();
  if (!jid || !text?.startsWith(p)) return;

  // Pisahkan command dan argumen
  const fullCmd = text.trim().split(/\s+/)[0];          // misal "#help" atau ".dl"
  const cmd     = fullCmd.slice(p.length).toLowerCase(); // misal "help" atau "dl"
  const args    = text.trim().slice(fullCmd.length).trim(); // sisanya setelah command

  // Guard: command sensitif hanya bisa dipakai fromMe (owner)
  // List ada di src/config.js -> OWNER_ONLY_COMMANDS (gampang ubah)
  if (OWNER_ONLY_COMMANDS.has(cmd)) {
    const fromMe = !!msg.key?.fromMe;
    if (!fromMe) {
      await safeSend(sock, jid, {
        text: `Owner only.`,
        quoted: msg,
      });
      return;
    }
  }

  switch (cmd) {

    // ============================================================
    // INFORMASI
    // ============================================================
    case 'help':
      await safeSend(sock, jid, {
        text:
          `╭─「 *WhatsApp Bot* 」\n` +
          `│\n` +

          `├─ *Media*\n` +
          `│  ├ • *${p}open*\n` +
          `│  ├ • *${p}sticker*\n` +
          `│  ├ • *${p}toimage*\n` +
          `│  ├ • *${p}tovideo*\n` +
          `│  ├ • *${p}tomp3* / *${p}toaudio*\n` +
          `│  └ • *${p}tovn*\n` +
          `│\n` +

          `├─ *Downloader*\n` +
          `│  ├ • Kirim link *(Auto)*\n` +
          `│  ├ • *${p}dl <link>*\n` +
          `│  ├ • *${p}dlon* / *${p}dloff*\n` +
          `│  └ • *${p}dlstatus*\n` +
          `│\n` +

          `├─ *Scheduler*\n` +
          `│  ├ • *Reply pesan* + *${p}reminder <detik>*\n` +
          `│  ├ • *${p}reminders*\n` +
          `│  └ • *${p}delremind <id>*\n` +
          `│\n` +

          `├─ *Grup*\n` +
          `│  ├ • *${p}welcome* / *${p}welon* / *${p}weloff*\n` +
          `│  ├ • *${p}setwelcome <pesan>*\n` +
          `│  ├ • *${p}setbye <pesan>*\n` +
          `│  ├ • *${p}tag* / *${p}tagon* / *${p}tagoff*\n` +
          `│  ├ • *${p}hidetag <pesan>*\n` +
          `│  └ • Placeholder: {name} {group} {count}\n` +
          `│\n` +

          `├─ *AI Chat*\n` +
          `│  ├ • *${p}ask <pertanyaan>*\n` +
          `│  ├ • *${p}ai* / *${p}aion* / *${p}aioff*\n` +
          `│  ├ • *${p}setai key|model|url*\n` +
          `│  ├ • *${p}aisystem <prompt>*\n` +
          `│  └ • *${p}newchat* (reset memory)\n` +
          `│\n` +

          `├─ *Sistem*\n` +
          `│  ├ • *${p}status*\n` +
          `│  ├ • *${p}ping*\n` +
          `│  ├ • *${p}uptime*\n` +
          `│  └ • *${p}setprefix <prefix>*\n` +
          `│\n` +

          `╰─ *Version ${CONFIG.VERSION}* | Prefix: *${p}*`,
      });
      break;

    case 'status': {
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
          `│  ├ Prefix        : ${p}\n` +
          `│  └ Version     : ${CONFIG.VERSION}\n` +
          `│\n` +
          `╰─ Bot Berjalan Normal`,
      });
      break;
    }

    case 'ping':
      await safeSend(sock, jid, { text: '🏓 Pong! Bot aktif.' });
      break;

    case 'uptime':
      await safeSend(sock, jid, { text: `⏱️ *Uptime:* ${stats.uptime()}` });
      break;

    // ============================================================
    // MEDIA — VIEW ONCE
    // ============================================================
    case 'open': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedId = ctxInfo?.stanzaId;
      const quotedMsg = ctxInfo?.quotedMessage;

      let voData = null;
      let targetMsg = null;

      // 1. Reply langsung ke pesan view once
      if (quotedId && quotedMsg) {
        const fakeMsg = {
          key: {
            remoteJid: jid,
            fromMe: false,
            id: quotedId,
            participant: ctxInfo?.participant || jid,
          },
          message: quotedMsg,
        };
        const extracted = extractViewOnce(fakeMsg);
        if (extracted) {
          voData = { ...extracted, chatJid: jid };
          targetMsg = fakeMsg;
        } else {
          // Cek cache berdasarkan ID pesan yang di-reply
          const byId = getViewOnceById(quotedId);
          if (byId) {
            voData = { ...byId.vo, chatJid: jid, buffer: byId.buffer };
            targetMsg = byId.msg;
          }
        }
      }

      // 2. Tanpa reply → ambil VO terakhir di chat ini
      if (!voData) {
        const lastVo = getLastViewOnce(jid);
        if (lastVo) {
          voData = { ...lastVo.vo, chatJid: jid, buffer: lastVo.buffer };
          targetMsg = lastVo.msg;
        }
      }

      if (!voData) {
        await safeSend(sock, jid, {
          text: `⚠️ Tidak ada pesan view once yang ditemukan di chat ini.\n\nReply ke pesan view once atau ketik *${p}open* langsung setelah menerima view once.`,
          quoted: msg,
        });
        break;
      }

      await processViewOnce(sock, voData, msg, targetMsg);
      break;
    }

    // ============================================================
    // GRUP — AUTO TAG
    // ============================================================
    case 'tag': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}tag hanya bisa di grup!` });
        break;
      }

      const isActive = tagStates.get(jid) === true;
      const groupMeta = await sock.groupMetadata(jid);
      const count = groupMeta.participants.length;

      await safeSend(sock, jid, {
        text: `*Auto-Tag:* ${isActive ? 'ON' : 'OFF'}\n${groupMeta.subject} (${count} member)\n\n${isActive ? `${p}tagoff untuk matikan` : `${p}tagon untuk aktifkan`}`,
      });
      break;
    }

    case 'tagon': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}tagon hanya bisa di grup!` });
        break;
      }

      tagStates.set(jid, true);
      saveTagStates();

      const groupMeta = await sock.groupMetadata(jid);
      const count = groupMeta.participants.length;

      await safeSend(sock, jid, {
        text: `Auto-Tag *ON* — ${count} member ditag invisible.\nMatikan: *${p}tagoff*`,
      });
      break;
    }

    case 'tagoff': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}tagoff hanya bisa di grup!` });
        break;
      }

      tagStates.set(jid, false);
      saveTagStates();

      await safeSend(sock, jid, {
        text: `Auto-Tag *OFF*.\nAktifkan: *${p}tagon*`,
      });
      break;
    }

    case 'hidetag': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}hidetag hanya bisa di grup!`, quoted: msg });
        break;
      }

      const groupMeta = await sock.groupMetadata(jid);
      const participants = groupMeta.participants.map(pt => pt.id);
      if (participants.length === 0) {
        await safeSend(sock, jid, { text: `⚠️ Tidak ada member yang bisa di-tag.`, quoted: msg });
        break;
      }

      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;

      let tagText = args.trim();
      if (!tagText && quotedMsg) {
        tagText =
          quotedMsg.conversation ||
          quotedMsg.extendedTextMessage?.text ||
          quotedMsg.imageMessage?.caption ||
          quotedMsg.videoMessage?.caption ||
          '';
      }

      if (!tagText) {
        tagText = '📢 *Announcement*';
      }

      const replyTarget = (quotedMsg && ctxInfo?.stanzaId) ? {
        key: {
          remoteJid: jid,
          fromMe: ctxInfo?.participant ? ctxInfo.participant === sock.user?.id : false,
          id: ctxInfo.stanzaId,
          participant: ctxInfo?.participant || jid,
        },
        message: quotedMsg,
      } : null;

      await safeSend(sock, jid, {
        text: tagText,
        mentions: participants,
        ...(replyTarget ? { quoted: replyTarget } : {}),
      });
      break;
    }

    // ============================================================
    // GRUP — WELCOME / GOODBYE
    // ============================================================
    case 'welcome': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}welcome hanya bisa di grup!` });
        break;
      }
      const ws = getWelcomeState(jid);
      const groupMeta = await sock.groupMetadata(jid);
      await safeSend(sock, jid, {
        text:
          `*Welcome/Goodbye:* ${ws?.enabled ? 'ON' : 'OFF'}\nGrup: ${groupMeta.subject}\n\n` +
          `*Welcome:*\n${ws?.welcomeMsg || DEFAULT_WELCOME}\n\n` +
          `*Goodbye:*\n${ws?.byeMsg || DEFAULT_BYE}\n\n` +
          `Placeholder: {name} {group} {count}\n` +
          `${p}setwelcome / ${p}setbye — ubah pesan\n` +
          `${ws?.enabled ? `${p}weloff — matikan` : `${p}welon — aktifkan`}`,
      });
      break;
    }

    case 'welon': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}welon hanya bisa di grup!` });
        break;
      }
      setWelcomeEnabled(jid, true);
      await safeSend(sock, jid, {
        text: `Welcome/Goodbye *ON*.\nMatikan: *${p}weloff*`,
      });
      break;
    }

    case 'weloff': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}weloff hanya bisa di grup!` });
        break;
      }
      setWelcomeEnabled(jid, false);
      await safeSend(sock, jid, {
        text: `Welcome/Goodbye *OFF*.\nAktifkan: *${p}welon*`,
      });
      break;
    }

    case 'setwelcome': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}setwelcome hanya bisa di grup!` });
        break;
      }
      if (!args) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *${p}setwelcome <pesan>*\n\n` +
                `Placeholder:\n• {name} — nama/nomor member\n• {group} — nama grup\n• {count} — jumlah member\n\n` +
                `Contoh:\n${p}setwelcome Halo {name}! Selamat datang di {group} 🎉\nKamu member ke-{count}`,
          quoted: msg,
        });
        break;
      }
      setWelcomeMsg(jid, args);
      await safeSend(sock, jid, {
        text: `Pesan welcome diperbarui.\n\n${args}`,
        quoted: msg,
      });
      break;
    }

    case 'setbye': {
      if (!isGroupJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ ${p}setbye hanya bisa di grup!` });
        break;
      }
      if (!args) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *${p}setbye <pesan>*\n\n` +
                `Placeholder:\n• {name} — nama/nomor member\n• {group} — nama grup\n• {count} — jumlah member\n\n` +
                `Contoh:\n${p}setbye Bye bye {name} 👋`,
          quoted: msg,
        });
        break;
      }
      setByeMsg(jid, args);
      await safeSend(sock, jid, {
        text: `Pesan goodbye diperbarui.\n\n${args}`,
        quoted: msg,
      });
      break;
    }

    // ============================================================
    // DOWNLOADER
    // ============================================================
    case 'dloff': {
      dlOffStates.set(jid, true);
      saveDlOffStates();
      await safeSend(sock, jid, {
        text: `Auto-download *OFF*.\n*${p}dl <link>* tetap bisa manual.\nAktifkan: *${p}dlon*`,
        quoted: msg,
      });
      break;
    }

    case 'dlon': {
      dlOffStates.delete(jid);
      saveDlOffStates();
      await safeSend(sock, jid, {
        text: `Auto-download *ON*.`,
        quoted: msg,
      });
      break;
    }

    case 'dlstatus': {
      const enabled = isAutoDownloadEnabled(jid);
      await safeSend(sock, jid, {
        text: `Auto-Download: *${enabled ? 'ON' : 'OFF'}*`,
        quoted: msg,
      });
      break;
    }

    case 'dl': {
      const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId  = ctxInfo?.stanzaId;

      let urlMatch = args.match(URL_REGEX);
      let targetQuoted = msg;

      if (!urlMatch && quotedMsg) {
        const quotedText =
          quotedMsg.conversation ||
          quotedMsg.extendedTextMessage?.text ||
          quotedMsg.imageMessage?.caption ||
          quotedMsg.videoMessage?.caption ||
          '';
        urlMatch = quotedText.match(URL_REGEX);
        if (urlMatch && quotedId) {
          targetQuoted = {
            key: {
              remoteJid: jid,
              fromMe: ctxInfo?.participant ? ctxInfo.participant === sock.user?.id : false,
              id: quotedId,
              participant: ctxInfo?.participant || jid,
            },
            message: quotedMsg,
          };
        }
      }

      if (!urlMatch) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *${p}dl <link>*\nAtau reply ke pesan berisi link lalu ketik *${p}dl*`,
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

      log.info(`📥 ${p}dl request: ${platform} from ${jid}`);
      const statusMsg = await safeSend(sock, jid, { text: '⏳ Lagi download, tunggu sebentar...', quoted: msg });

      try {
        await runDownloader(sock, jid, url, platform, targetQuoted);
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

    // ============================================================
    // STICKER
    // ============================================================
    case 'sticker': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke foto/video, lalu ketik *${p}sticker*`,
          quoted: msg,
        });
        break;
      }

      const isImage = !!quotedMsg?.imageMessage;
      const isVideo = !!quotedMsg?.videoMessage;
      const isSticker = !!quotedMsg?.stickerMessage;

      if (isSticker) {
        await safeSend(sock, jid, {
          text: `⚠️ Ini sudah stiker. Pake *${p}toimage* atau *${p}tovideo* kalo mau balikin.`,
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

    case 'toimage': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke stiker, lalu ketik *${p}toimage*`,
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

    case 'tovideo': {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      if (!quotedId || !quotedMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke stiker, lalu ketik *${p}tovideo*`,
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

    case 'tomp3':
    case 'toaudio':
    case 'tovn': {
      const isVn = cmd === 'tovn';
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId = ctxInfo?.stanzaId;

      let targetMsg = null;
      let hasMedia = false;

      if (msg.message?.videoMessage || msg.message?.audioMessage) {
        targetMsg = msg;
        hasMedia = true;
      } else if (quotedMsg && (quotedMsg.videoMessage || quotedMsg.audioMessage)) {
        targetMsg = {
          key: {
            remoteJid: jid,
            fromMe: false,
            id: quotedId,
            participant: ctxInfo?.participant || jid,
          },
          message: quotedMsg,
        };
        hasMedia = true;
      }

      if (!hasMedia || !targetMsg) {
        await safeSend(sock, jid, {
          text: `⚠️ Reply ke *video* atau *audio*, lalu ketik *${p}${cmd}*`,
          quoted: msg,
        });
        break;
      }

      try {
        await safeSend(sock, jid, {
          text: `⏳ Mengonversi ke ${isVn ? 'Voice Note' : 'Audio MP3'}...`,
          quoted: msg,
        });

        const buffer = await downloadMediaMessage(
          targetMsg,
          'buffer',
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || buffer.length === 0) {
          throw new Error('Buffer media kosong');
        }

        const outAudio = await convertMediaToAudio(buffer, isVn);

        if (isVn) {
          await safeSend(sock, jid, {
            audio: outAudio,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            quoted: msg,
          });
        } else {
          await safeSend(sock, jid, {
            audio: outAudio,
            mimetype: 'audio/mpeg',
            fileName: 'audio.mp3',
            quoted: msg,
          });
        }

        log.ok(`✅ Converted media to ${isVn ? 'VN' : 'MP3'} (${(outAudio.length / 1024).toFixed(1)} KB)`);
      } catch (e) {
        log.err(`Audio convert failed: ${e.message}`);
        await safeSend(sock, jid, {
          text: `❌ Gagal convert audio: ${e.message}`,
          quoted: msg,
        });
      }
      break;
    }

    // ============================================================
    // SCHEDULER / REMINDER
    // ============================================================
    case 'reminder': {
      const secArg = parseInt(args.split(/\s+/)[0], 10);

      const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
      const quotedId  = ctxInfo?.stanzaId;
      const quotedMsg = ctxInfo?.quotedMessage;

      if (!quotedMsg || !quotedId) {
        await safeSend(sock, jid, {
          text:
            `⚠️ Reply ke pesan (foto/video/audio/sticker/teks) yang mau dijadwalkan, lalu ketik *${p}reminder <detik>*\n\n` +
            `Contoh: ${p}reminder 600  (600 detik = 10 menit)`,
          quoted: msg,
        });
        break;
      }

      if (!secArg || secArg <= 0) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *${p}reminder <detik>*\n\nContoh: ${p}reminder 600`,
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
            `Reminder #${r.id} diset.\n` +
            `Tiap ${secArg}d | tipe: ${content.type}\n` +
            `Pertama: ${formatDueAt(r.dueAt)}\n\n` +
            `Stop: *${p}delremind ${r.id}*`,
          quoted: msg,
        });
      } catch (e) {
        await safeSend(sock, jid, { text: `❌ Gagal simpan reminder: ${e.message}`, quoted: msg });
      }
      break;
    }

    case 'reminders': {
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
        text: `*Reminder Aktif (${list.length})*\n\n${body}\n\nHapus: *${p}delremind <id>*`,
      });
      break;
    }

    case 'delremind': {
      const idArg = parseInt(args, 10);
      if (!idArg) {
        await safeSend(sock, jid, { text: `⚠️ Format: *${p}delremind <id>*` });
        break;
      }
      const ok = cancelReminder(idArg, jid);
      await safeSend(sock, jid, {
        text: ok ? `🗑️ Reminder #${idArg} dibatalkan.` : `⚠️ Reminder #${idArg} tidak ditemukan.`,
      });
      break;
    }

    // ============================================================
    // SISTEM — SET PREFIX
    // ============================================================
    case 'setprefix': {
      if (!args) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *${p}setprefix <prefix_baru>*\n\n` +
                `Contoh:\n• ${p}setprefix #\n• ${p}setprefix !\n• ${p}setprefix r\n• ${p}setprefix 7\n\n` +
                `Prefix sekarang: *${p}*`,
          quoted: msg,
        });
        break;
      }
      const newPrefix = args.split(/\s+/)[0];
      if (newPrefix.length > 5) {
        await safeSend(sock, jid, { text: `⚠️ Prefix terlalu panjang! Maksimal 5 karakter.`, quoted: msg });
        break;
      }
      try {
        const oldPrefix = p;
        setPrefix(newPrefix);
        await safeSend(sock, jid, {
          text: `Prefix diubah: *${oldPrefix}* → *${newPrefix}*\nGunakan *${newPrefix}help* untuk menu.`,
          quoted: msg,
        });
      } catch (e) {
        await safeSend(sock, jid, { text: `❌ Gagal ubah prefix: ${e.message}`, quoted: msg });
      }
      break;
    }

    // ============================================================
    // AUTO REPLY
    // ============================================================
    case 'listauto': {
      if (!isPrivateJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ Auto-reply hanya tersedia di private chat.' });
        break;
      }
      const keys = Object.keys(autoReplies);
      if (keys.length === 0) {
        await safeSend(sock, jid, { text: `📋 Belum ada auto-reply.\n\nGunakan *${p}set trigger | balasan* untuk menambah.` });
        break;
      }
      const list = keys.map((k, i) => {
        const e = autoReplies[k];
        const trigLabel = k.startsWith('__photo__') ? `[foto:${k.slice(9, 17)}]` : k;
        const valLabel  = e.type === 'photo' ? `[foto] ${e.caption || ''}` : e.value;
        return `${i + 1}. *${trigLabel}* -> ${valLabel}`;
      }).join('\n');
      await safeSend(sock, jid, { text: `📋 *Daftar Auto-Reply (${keys.length}):*\n\n${list}\n\n_Hapus: ${p}del <trigger>_` });
      break;
    }

    case 'del': {
      if (!isPrivateJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ Auto-reply hanya tersedia di private chat.' });
        break;
      }
      const trigger = args.trim().toLowerCase();
      if (!trigger) {
        await safeSend(sock, jid, { text: `⚠️ Format: *${p}del trigger*` });
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

    case 'set': {
      if (!isPrivateJid(jid)) {
        await safeSend(sock, jid, { text: '⚠️ Auto-reply hanya tersedia di private chat.' });
        break;
      }

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
          replyEntry = { type: 'text', value: args };
        }

      } else {
        if (selfPhoto) {
          trigger = args.toLowerCase();
          try {
            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const fname = `reply_${Date.now()}.jpg`;
            fs.writeFileSync(path.join(PHOTO_STORE_DIR, fname), buf);
            replyEntry = { type: 'photo', value: fname, caption: args.replace(new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim() || '' };
          } catch (e) {
            await safeSend(sock, jid, { text: '❌ Gagal simpan foto: ' + e.message });
            break;
          }
        } else {
          const sep = args.indexOf('|');
          if (sep === -1) {
            await safeSend(sock, jid, {
              text:
                `⚠️ *Format ${p}set:*\n\n` +
                `*1. Trigger teks → balas teks:*\n   ${p}set halo | hai juga!\n\n` +
                `*2. Trigger teks → balas foto:*\n   [kirim foto] caption: ${p}set halo\n\n` +
                `*3. Trigger foto → balas teks:*\n   [reply foto] ${p}set balasan kamu\n\n` +
                `*4. Trigger foto → balas foto:*\n   [reply foto] kirim ${p}set [dengan foto]`,
            });
            break;
          }
          trigger    = args.slice(0, sep).trim().toLowerCase();
          replyEntry = { type: 'text', value: args.slice(sep + 1).trim() };
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
        text: `Auto-reply disimpan.\nTrigger: ${trigLabel}\nBalasan: ${valLabel}`,
        quoted: msg,
      });
      break;
    }

    // ============================================================
    // AI CHAT
    // ============================================================
    case 'ask': {
      const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      const quotedId  = ctxInfo?.stanzaId;

      const replyTargetMsg = (quotedMsg && quotedId) ? {
        key: {
          remoteJid: jid,
          fromMe: ctxInfo?.participant ? ctxInfo.participant === sock.user?.id : false,
          id: quotedId,
          participant: ctxInfo?.participant || jid,
        },
        message: quotedMsg,
      } : msg;

      let promptText = args.trim();
      let docContent = null;
      let docName = null;

      // Kalau reply ke dokumen (ZIP / PDF / teks) → ekstrak isinya
      const quotedDoc = quotedMsg?.documentMessage;
      if (quotedDoc && quotedId) {
        docName = quotedDoc.fileName || 'unknown';
        const docCaption = quotedDoc.caption || '';
        try {
          await safeSend(sock, jid, { text: `⏳ Membaca *${docName}*...`, quoted: msg });
          const docBuf = await downloadMediaMessage(replyTargetMsg, 'buffer', {}, {
            logger, reuploadRequest: sock.updateMediaMessage,
          });
          const extracted = await extractDocumentText(docBuf, docName);
          if (extracted) {
            docContent = extracted.length > 100_000
              ? extracted.slice(0, 100_000) + '\n\n[...dipotong]'
              : extracted;
          } else {
            await safeSend(sock, jid, {
              text: `⚠️ Tidak ada teks yang bisa dibaca dari *${docName}*.`,
              quoted: msg,
            });
            break;
          }
          if (!promptText && docCaption) promptText = docCaption;
        } catch (e) {
          log.err(`ask doc read error: ${e.message}`);
          await safeSend(sock, jid, {
            text: `❌ Gagal membaca *${docName}*: ${e.message}`,
            quoted: msg,
          });
          break;
        }
      }

      let quotedText = null;
      if (quotedMsg && !quotedDoc) {
        quotedText =
          quotedMsg.conversation ||
          quotedMsg.extendedTextMessage?.text ||
          quotedMsg.imageMessage?.caption ||
          quotedMsg.videoMessage?.caption ||
          null;
      }

      if (docContent) {
        promptText = promptText
          ? `[Isi file ${docName}]:\n${docContent}\n\n[Pertanyaan/Instruksi]: ${promptText}`
          : `Berikut isi file ${docName}:\n\n${docContent}\n\nJelaskan atau rangkum isi file tersebut.`;
      } else if (quotedText) {
        promptText = promptText
          ? `[Pesan yang di-reply]: "${quotedText}"\n\n[Pertanyaan/Instruksi]: ${promptText}`
          : `Jawab, jelaskan, atau tanggapi pesan berikut:\n"${quotedText}"`;
      }

      if (!promptText) {
        await safeSend(sock, jid, {
          text: `⚠️ Format: *${p}ask <pertanyaan>*\nAtau reply ke pesan/file (ZIP/PDF/teks) lalu ketik *${p}ask <instruksi>*`,
          quoted: msg,
        });
        break;
      }

      await askStatelessAI(sock, jid, promptText, replyTargetMsg);
      break;
    }

    case 'ai': {
      const enabled = isAiEnabled(jid);
      const hasConfig = !!(aiConfig.apiKey && aiConfig.model && aiConfig.baseUrl);
      const masked = aiConfig.apiKey
        ? aiConfig.apiKey.slice(0, 6) + '...' + aiConfig.apiKey.slice(-4)
        : '(belum diset)';

      await safeSend(sock, jid, {
        text:
          `*AI Chat:* ${enabled ? 'ON' : 'OFF'} | Config: ${hasConfig ? 'OK' : 'belum lengkap'}\n` +
          `Key: ${masked}\n` +
          `Model: ${aiConfig.model || '-'}\n` +
          `URL: ${aiConfig.baseUrl || '-'}\n\n` +
          `*System Prompt:*\n${(aiConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT).slice(0, 300)}${(aiConfig.systemPrompt || '').length > 300 ? '...' : ''}\n\n` +
          `${p}aion / ${p}aioff — toggle\n` +
          `${p}setai — konfigurasi\n` +
          `${p}aisystem — ubah prompt\n` +
          `${p}newchat — reset memory`,
      });
      break;
    }

    case 'aion': {
      if (!aiConfig.apiKey || !aiConfig.model || !aiConfig.baseUrl) {
        await safeSend(sock, jid, {
          text: `⚠️ AI belum dikonfigurasi!\n\nGunakan:\n*${p}setai <apikey>|<model>|<baseurl>*\n\nContoh:\n${p}setai sk-xxx|gpt-4o|https://api.openai.com/v1`,
          quoted: msg,
        });
        break;
      }
      if (!isPrivateJid(jid)) {
        await safeSend(sock, jid, { text: `⚠️ AI auto-reply hanya tersedia di *private chat* (biar token gak habis 😅)` });
        break;
      }
      setAiEnabled(jid, true);
      await safeSend(sock, jid, {
        text: `AI Chat *ON* — Model: *${aiConfig.model}*\nBisa baca: teks, foto, dokumen.\nMatikan: *${p}aioff* | Reset: *${p}newchat*`,
        quoted: msg,
      });
      break;
    }

    case 'aioff': {
      setAiEnabled(jid, false);
      await safeSend(sock, jid, {
        text: `AI Chat *OFF*.\nAktifkan: *${p}aion*`,
        quoted: msg,
      });
      break;
    }

    case 'setai': {
      if (!args) {
        const masked = aiConfig.apiKey
          ? aiConfig.apiKey.slice(0, 6) + '...' + aiConfig.apiKey.slice(-4)
          : '(kosong)';

        await safeSend(sock, jid, {
          text:
            `*Konfigurasi AI*\n\n` +
            `Key: ${masked}\nModel: ${aiConfig.model || '-'}\nURL: ${aiConfig.baseUrl || '-'}\n\n` +
            `Format: *${p}setai <key>|<model>|<url>*\nPakai *-* untuk skip field.\n\n` +
            `Contoh:\n` +
            `${p}setai sk-xxx|gpt-4o|https://api.openai.com/v1\n` +
            `${p}setai -|grok-3|-`,
          quoted: msg,
        });
        break;
      }

      const parts = args.split('|').map(s => s.trim());
      if (parts.length !== 3) {
        await safeSend(sock, jid, {
          text: `⚠️ Format harus 3 bagian dipisah *|*\n\n*${p}setai <apikey>|<model>|<baseurl>*\n\nGunakan *-* untuk skip.`,
          quoted: msg,
        });
        break;
      }

      const [newKey, newModel, newUrl] = parts;
      let changed = [];

      if (newKey && newKey !== '-') {
        aiConfig.apiKey = newKey;
        changed.push('🔑 API Key');
      }
      if (newModel && newModel !== '-') {
        aiConfig.model = newModel;
        changed.push(`🧠 Model → *${newModel}*`);
      }
      if (newUrl && newUrl !== '-') {
        // Bersihkan trailing slash
        aiConfig.baseUrl = newUrl.replace(/\/+$/, '');
        changed.push(`🌐 Base URL → ${aiConfig.baseUrl}`);
      }

      if (changed.length === 0) {
        await safeSend(sock, jid, { text: '⚠️ Tidak ada yang diubah.', quoted: msg });
        break;
      }

      saveAiConfig();
      await safeSend(sock, jid, {
        text: `AI config diperbarui.\n${changed.join('\n')}\n\nAktifkan: *${p}aion*`,
        quoted: msg,
      });
      break;
    }

    case 'aisystem': {
      if (!args) {
        await safeSend(sock, jid, {
          text:
            `*System Prompt AI*\n\n${aiConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT}\n\n` +
            `Ubah: *${p}aisystem <prompt>*\nReset: *${p}aisystem reset*`,
          quoted: msg,
        });
        break;
      }

      if (args.toLowerCase() === 'reset') {
        aiConfig.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        saveAiConfig();
        await safeSend(sock, jid, { text: `System prompt direset.`, quoted: msg });
        break;
      }

      aiConfig.systemPrompt = args;
      saveAiConfig();
      await safeSend(sock, jid, {
        text: `System prompt diperbarui.\n\n${args.slice(0, 500)}${args.length > 500 ? '...' : ''}`,
        quoted: msg,
      });
      break;
    }

    case 'newchat': {
      clearHistory(jid);
      await safeSend(sock, jid, {
        text: `Memory AI direset. Percakapan baru.`,
        quoted: msg,
      });
      break;
    }

    default:
      break;
  }
}

module.exports = { handleCommand };
