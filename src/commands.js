'use strict';

const fs   = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { CONFIG, URL_REGEX, log, stats, logger, isGroupJid, isPrivateJid } = require('./config');
const { safeSend } = require('./helpers');
const { extractViewOnce, processViewOnce } = require('./viewonce');
const { tagStates, saveTagStates } = require('./tag');
const { dlOffStates, saveDlOffStates, isAutoDownloadEnabled } = require('./dl-toggle');
const { sendSticker, convertStickerToMedia } = require('./sticker');
const { detectPlatform, runDownloader } = require('./downloader');
const { captureQuotedContent, addReminder, cancelReminder, listReminders, formatDueAt } = require('./reminders');
const { autoReplies, saveAutoReplies, photoHash, PHOTO_STORE_DIR } = require('./autoreply');

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

    //------(.dloff) - MATIKAN AUTO-DOWNLOAD LINK DI CHAT INI------
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

    // .set / .del / .listauto — AUTO REPLY
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

module.exports = { handleCommand };
