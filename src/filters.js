'use strict';

// ============================================================
// IMAGE FILTERS (sharp)
// ============================================================
// Reply foto + command (.blur, .grayscale, dst) -> bot olah fotonya.
// Support kombinasi: ".blur grayscale" -> dua filter sekaligus.
// ============================================================

const sharp = require('sharp');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { log, stats, logger } = require('./config');
const { safeSend } = require('./helpers');

// ============================================================
// DEFINISI FILTER
// ============================================================
// value: fungsi (sharpInstance, arg) -> sharpInstance
// arg:   parse dari args command (mis. .blur 15 -> arg = "15")
const FILTERS = {
  blur: {
    desc: 'Blur foto',
    apply: (img, arg) => {
      const sigma = Math.min(50, Math.max(0.3, parseFloat(arg) || 8));
      return img.blur(sigma);
    },
  },
  grayscale: {
    desc: 'Hitam-putih',
    apply: (img) => img.grayscale(),
  },
  flip: {
    desc: 'Mirror horizontal',
    apply: (img) => img.flop(),
  },
  flipv: {
    desc: 'Balik vertikal',
    apply: (img) => img.flip(),
  },
  rotate: {
    desc: 'Putar foto (derajat)',
    apply: (img, arg) => {
      const deg = parseFloat(arg);
      return img.rotate(Number.isFinite(deg) ? deg : 90);
    },
  },
  crop: {
    desc: 'Crop square tengah',
    // apply tidak dipakai langsung — crop butuh ukuran asli,
    // ditangani khusus via applyCrop() di applyFilters
    apply: (img) => img,
  },
  dark: {
    desc: 'Gelapkan',
    apply: (img, arg) => {
      const mul = Math.min(1, Math.max(0.1, parseFloat(arg) || 0.6));
      return img.linear(mul, 0);
    },
  },
  bright: {
    desc: 'Cerahkan',
    apply: (img, arg) => {
      const mul = Math.min(3, Math.max(1, parseFloat(arg) || 1.4));
      return img.linear(mul, 0);
    },
  },
};

// crop butuh ukuran asli, jadi ditangani terpisah
async function applyCrop(img, buffer) {
  const meta = await sharp(buffer).metadata();
  const size = Math.min(meta.width || 512, meta.height || 512);
  return img.resize(size, size, { fit: 'cover', position: 'centre' });
}

// ============================================================
// APPLY FILTERS (urutan sesuai input user)
// ============================================================
async function applyFilters(buffer, filterNames, argsMap) {
  let img = sharp(buffer);

  for (const name of filterNames) {
    const f = FILTERS[name];
    if (!f) continue;

    if (name === 'crop') {
      img = await applyCrop(img, buffer);
    } else {
      img = f.apply(img, argsMap[name]);
    }
  }

  return img.png().toBuffer();
}

// ============================================================
// HANDLER UTAMA
// ============================================================
async function handleImageFilter(sock, msg, filterNames, argsMap = {}) {
  const jid = msg.key?.remoteJid;
  if (!jid) return false;

  try {
    // Ambil foto: dari pesan langsung ATAU pesan yang di-reply
    const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = ctxInfo?.quotedMessage || null;
    const ownImage  = msg.message?.imageMessage || null;
    const quotedImage = quotedMsg?.imageMessage || null;

    if (!ownImage && !quotedImage) {
      await safeSend(sock, jid, {
        text:
          `⚠️ Reply ke *foto* dengan command filter ya.\n\n` +
          `Contoh: reply foto → *.blur* atau *.blur 15*\n` +
          `Bisa digabung: *.blur grayscale*\n\n` +
          `Filter: ${Object.keys(FILTERS).join(', ')}`,
        quoted: msg,
      });
      return false;
    }

    // Reaksi "lagi proses"
    await safeSend(sock, jid, { react: { text: '⏳', key: msg.key } });

    // Download foto (dari pesan sendiri atau quoted)
    const targetMsg = ownImage ? msg : { key: { remoteJid: jid, id: ctxInfo.stanzaId, fromMe: false, participant: ctxInfo.participant }, message: quotedMsg };
    const buffer = await downloadMediaMessage(
      targetMsg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );

    if (!buffer || buffer.length === 0) {
      throw new Error('Buffer foto kosong');
    }

    log.info(`Filter ${filterNames.join('+')} pada foto ${(buffer.length / 1024).toFixed(1)} KB`);

    // Apply filters
    const result = await applyFilters(buffer, filterNames, argsMap);

    // Kirim hasil
    const caption = `🎨 Filter: ${filterNames.join(' + ')}`;
    await sock.sendMessage(jid, { image: result, caption, mimetype: 'image/png' });
    stats.inc('image');

    // Reaksi sukses
    await safeSend(sock, jid, { react: { text: '✅', key: msg.key } });
    log.ok(`✅ Filter ${filterNames.join('+')} berhasil`);
    return true;

  } catch (e) {
    log.err(`Filter error: ${e.message}`);
    await safeSend(sock, jid, {
      text: `❌ Gagal apply filter: ${e.message}`,
      quoted: msg,
    }).catch(() => {});
    return false;
  }
}

// ============================================================
// PARSE COMMAND FILTER (support kombinasi + argumen per filter)
// ============================================================
// primaryCmd = filter dari nama command (mis. cmd 'blur' dari '.blur').
// Angka selalu menempel ke filter yang muncul TEPAT SEBELUMNYA,
// termasuk primaryCmd. Jadi '.rotate grayscale 45' -> 45 untuk grayscale,
// dan '.rotate 45 grayscale' -> 45 untuk rotate.
function parseFilterCommand(argsStr, primaryCmd = null) {
  const tokens = String(argsStr || '').trim().split(/\s+/).filter(Boolean);
  const names = primaryCmd ? [primaryCmd] : [];
  const args = {};
  let lastFilter = primaryCmd;

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (FILTERS[lower]) {
      if (!names.includes(lower)) names.push(lower);
      lastFilter = lower;
    } else if (/^-?\d+(\.\d+)?$/.test(tok) && lastFilter) {
      args[lastFilter] = tok;
    }
  }

  return { names, args };
}

module.exports = { FILTERS, handleImageFilter, parseFilterCommand };
