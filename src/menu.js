'use strict';

// ============================================================
// INTERACTIVE MENU (WhatsApp native flow: list + quick reply)
// ============================================================
// Kirim pesan interaktif dengan tombol quick reply & list dropdown.
// Semua fungsi punya fallback teks biasa kalau relay interaktif gagal.
// ============================================================

const {
  generateWAMessageFromContent,
  proto,
  prepareWAMessageMedia,
} = require('@whiskeysockets/baileys');
const { CONFIG, log } = require('./config');
const { safeSend } = require('./helpers');

// ============================================================
// KATEGORI MENU
// ============================================================
const MENU_CATEGORIES = ['media', 'downloader', 'scheduler', 'grup', 'ai', 'autoreply', 'system'];

const CATEGORY_TITLES = {
  media:      '📸 Media',
  downloader: '📥 Downloader',
  scheduler:  '⏰ Scheduler',
  grup:       '👥 Grup',
  ai:         '🤖 AI Chat',
  autoreply:  '💬 Auto-Reply',
  system:     '⚙️ System',
};

// ============================================================
// CORE: kirim pesan native flow interaktif
// ============================================================
async function sendNativeFlow(sock, jid, { text, footer, buttons, quoted = null }) {
  // buttons: [{ id, text, type: 'quick_reply' | 'list', rows?: [{ id, title, description }] }]
  try {
    const quickReply = buttons.filter(b => b.type === 'quick_reply');
    const listBtn    = buttons.find(b => b.type === 'list');

    const nativeFlowButtons = [];

    if (listBtn && Array.isArray(listBtn.rows)) {
      nativeFlowButtons.push({
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: listBtn.text || 'Pilih',
          sections: [
            {
              title: listBtn.title || 'Menu',
              rows: listBtn.rows.map(r => ({
                id: r.id,
                title: r.title,
                description: r.description || '',
              })),
            },
          ],
        }),
      });
    }

    for (const b of quickReply) {
      nativeFlowButtons.push({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          id: b.id,
          display_text: b.text,
        }),
      });
    }

    const msgContent = proto.Message.InteractiveMessage.create({
      header: proto.Message.InteractiveMessage.Header.create({
        title: '',
        subtitle: '',
        hasMediaAttachment: false,
      }),
      body: proto.Message.InteractiveMessage.Body.create({ text }),
      footer: proto.Message.InteractiveMessage.Footer.create({ text: footer || CONFIG.BOT_NAME || 'WhatsApp Bot' }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: nativeFlowButtons,
      }),
    });

    // Interactive message TIDAK dibungkus viewOnceMessage (itu untuk media
    // sekali-lihat). Kirim interactiveMessage langsung + messageContextInfo.
    const msg = generateWAMessageFromContent(
      jid,
      proto.Message.fromObject({
        interactiveMessage: msgContent,
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
      }),
      { userJid: jid, quoted: quoted || undefined },
    );

    await sock.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
    });

    return true;
  } catch (err) {
    log.warn(`sendNativeFlow gagal, fallback ke teks: ${err.message}`);
    return false;
  }
}

// ============================================================
// MENU UTAMA
// ============================================================
async function sendMainMenu(sock, jid, quoted = null, fallbackText = null) {
  const p = require('./prefix').getPrefix();
  const text =
    `╔═ *BOT MENU* ═╗\n\n` +
    `Halo! Pilih kategori di tombol *Daftar Menu* 👇\n` +
    `atau ketik *${p}help <kategori>*\n\n` +
    `_Kategori: media, downloader, scheduler, grup, ai, system_`;

  const ok = await sendNativeFlow(sock, jid, {
    text,
    footer: `V${CONFIG.VERSION} · Prefix: ${p}`,
    quoted,
    buttons: [
      {
        type: 'list',
        text: '📜 Daftar Menu',
        title: 'Kategori Perintah',
        rows: [
          { id: 'menu:media',      title: CATEGORY_TITLES.media,      description: 'Sticker, toimage, tovideo, tomp3, open' },
          { id: 'menu:downloader', title: CATEGORY_TITLES.downloader, description: 'Download video/audio dari link' },
          { id: 'menu:scheduler',  title: CATEGORY_TITLES.scheduler,  description: 'Reminder pesan otomatis' },
          { id: 'menu:grup',       title: CATEGORY_TITLES.grup,       description: 'Welcome, tag, hidetag' },
          { id: 'menu:ai',         title: CATEGORY_TITLES.ai,         description: 'AI chat & konfigurasi' },
          { id: 'menu:autoreply',  title: CATEGORY_TITLES.autoreply,  description: 'Auto-reply dengan tombol (owner)' },
          { id: 'menu:system',     title: CATEGORY_TITLES.system,     description: 'Status, ping, uptime, prefix' },
        ],
      },
      { type: 'quick_reply', id: 'menu:status',    text: '📊 Status Bot' },
      { type: 'quick_reply', id: 'menu:ping',      text: '🏓 Ping' },
      { type: 'quick_reply', id: 'menu:reminders', text: '📋 Reminders' },
    ],
  });

  if (!ok) {
    // Fallback: teks biasa (pakai help text yang sudah ada)
    if (fallbackText) {
      await safeSend(sock, jid, { text: fallbackText, quoted });
    } else {
      await safeSend(sock, jid, { text, quoted });
    }
  }
}

// ============================================================
// DETAIL KATEGORI
// ============================================================
async function sendCategoryDetail(sock, jid, category, quoted = null) {
  const p = require('./prefix').getPrefix();
  const cat = String(category || '').toLowerCase();

  if (!MENU_CATEGORIES.includes(cat)) {
    await safeSend(sock, jid, {
      text: `⚠️ Kategori tidak dikenal: *${category}*\n\nKategori: ${MENU_CATEGORIES.join(', ')}`,
      quoted,
    });
    return;
  }

  const detailTexts = {
    media:
      `*📸 MEDIA*\n\n` +
      `› *${p}open* — buka view once (reply pesan)\n` +
      `› *${p}sticker* — jadikan sticker (reply/kirim media)\n` +
      `› *${p}toimage* — sticker jadi foto\n` +
      `› *${p}tovideo* — sticker jadi video\n` +
      `› *${p}tomp3* / *${p}toaudio* — video jadi audio\n` +
      `› *${p}tovn* — audio jadi voice note\n\n` +
      `*🏷️ WATERMARK*\n` +
      `› *${p}wm <pesan>* — reply sticker, tambah teks\n\n` +
      `*🎨 IMAGE FILTERS* (reply foto)\n` +
      `› *${p}blur [angka]* — blur (default 8)\n` +
      `› *${p}grayscale* — hitam-putih\n` +
      `› *${p}flip* — mirror horizontal\n` +
      `› *${p}flipv* — balik vertikal\n` +
      `› *${p}rotate [derajat]* — putar (default 90°)\n` +
      `› *${p}crop* — crop square tengah\n` +
      `› *${p}dark / ${p}bright* — gelap/cerah\n` +
      `› Kombinasi: *${p}blur grayscale*`,
    downloader:
      `*📥 DOWNLOADER*\n\n` +
      `› Kirim link — *(Auto)* download langsung\n` +
      `› *${p}dl <link>* — download manual\n` +
      `› *${p}dlon* / *${p}dloff* — toggle auto-download\n` +
      `› *${p}dlstatus* — cek status auto-download`,
    scheduler:
      `*⏰ SCHEDULER*\n\n` +
      `› *Reply pesan* + *${p}reminder <detik>*\n` +
      `› *${p}reminders* — list reminder aktif\n` +
      `› *${p}delremind <id>* — hapus reminder`,
    grup:
      `*👥 GRUP*\n\n` +
      `› *${p}welcome* — preview pesan welcome\n` +
      `› *${p}welon* / *${p}weloff* — toggle welcome/bye\n` +
      `› *${p}setwelcome <pesan>* — set pesan welcome\n` +
      `› *${p}setbye <pesan>* — set pesan bye\n` +
      `› *${p}tag* — tag semua (bot auto-tag on)\n` +
      `› *${p}tagon* / *${p}tagoff* — toggle auto-tag\n` +
      `› *${p}hidetag <pesan>* — tag tanpa tulis nama\n\n` +
      `_Placeholder: {name} {group} {count}_`,
    ai:
      `*🤖 AI CHAT*\n\n` +
      `› *${p}ask <pertanyaan>* — tanya AI sekali\n` +
      `› *${p}ai* — chat AI interaktif\n` +
      `› *${p}aion* / *${p}aioff* — toggle AI auto-reply\n` +
      `› *${p}setai key|model|url* — konfigurasi AI\n` +
      `› *${p}aisystem <prompt>* — set system prompt\n` +
      `› *${p}newchat* — reset memory AI`,
    autoreply:
      `*💬 AUTO-REPLY* _owner only_\n\n` +
      `› *${p}set <trigger> | <balasan>* — set auto-reply\n` +
      `› *${p}set <trigger> | <pesan> | [tombol] <teks>* — balasan dengan tombol (maks 3)\n` +
      `› *${p}listauto* — daftar auto-reply (tap row = hapus)\n` +
      `› *${p}del <trigger>* — hapus auto-reply\n\n` +
      `Contoh tombol:\n${p}set menu | Pilih aksi | [tombol] Status | [tombol] Ping\n\n` +
      `Trigger juga bisa foto (reply foto / kirim foto + caption),\n` +
      `balasan foto: kirim foto caption *${p}set <trigger>*`,
    system:
      `*⚙️ SYSTEM*\n\n` +
      `› *${p}status* — statistik bot\n` +
      `› *${p}ping* — cek bot hidup\n` +
      `› *${p}uptime* — lama bot jalan\n` +
      `› *${p}setprefix <prefix>* — ganti prefix`,
  };

  const body =
    detailTexts[cat] +
    `\n\n_Ketik *${p}menu* untuk kembali ke menu utama._`;

  await safeSend(sock, jid, { text: body, quoted });
}

module.exports = {
  MENU_CATEGORIES,
  CATEGORY_TITLES,
  sendNativeFlow,
  sendMainMenu,
  sendCategoryDetail,
};
