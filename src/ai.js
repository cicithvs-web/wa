'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { log, logger, isPrivateJid } = require('./config');
const { safeSend } = require('./helpers');

// ============================================================
// FILES
// ============================================================
const AI_CONFIG_FILE = path.join(__dirname, '..', 'ai_config.json');
const AI_STATE_FILE  = path.join(__dirname, '..', 'ai_state.json');
const AI_MEMORY_FILE = path.join(__dirname, '..', 'ai_memory.json');

const MAX_MEMORY = 50;  // max pesan per chat yang disimpan

// ============================================================
// DEFAULT SYSTEM PROMPT
// ============================================================
const DEFAULT_SYSTEM_PROMPT =
  'Kamu adalah asisten AI yang ramah dan membantu di WhatsApp. ' +
  'Jawab dalam bahasa yang sama dengan pengguna. ' +
  'Gunakan format WhatsApp: *bold*, _italic_, ```code```, ~strikethrough~. ' +
  'Jawab dengan ringkas tapi lengkap. ' +
  'Jika ditanya tentang gambar, analisis dengan detail.';

// ============================================================
// LOAD CONFIG
// ============================================================
let aiConfig = {
  apiKey: '',
  model: '',
  baseUrl: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

try {
  if (fs.existsSync(AI_CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
    aiConfig = { ...aiConfig, ...data };
  }
} catch (_) {}

function saveAiConfig() {
  try {
    fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(aiConfig, null, 2), 'utf8');
  } catch (e) {
    log.err(`Save AI config error: ${e.message}`);
  }
}

// ============================================================
// LOAD STATE (per-JID on/off)
// ============================================================
let aiStates = {}; // { [jid]: true/false }

try {
  if (fs.existsSync(AI_STATE_FILE)) {
    aiStates = JSON.parse(fs.readFileSync(AI_STATE_FILE, 'utf8'));
  }
} catch (_) {}

function saveAiStates() {
  try {
    fs.writeFileSync(AI_STATE_FILE, JSON.stringify(aiStates), 'utf8');
  } catch (e) {
    log.err(`Save AI states error: ${e.message}`);
  }
}

function isAiEnabled(jid) {
  return aiStates[jid] === true;
}

function setAiEnabled(jid, enabled) {
  aiStates[jid] = enabled;
  saveAiStates();
}

// ============================================================
// LOAD MEMORY (per-JID conversation history)
// ============================================================
let aiMemory = {}; // { [jid]: [ { role, content }, ... ] }

try {
  if (fs.existsSync(AI_MEMORY_FILE)) {
    aiMemory = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, 'utf8'));
  }
} catch (_) {}

function saveAiMemory() {
  try {
    fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(aiMemory), 'utf8');
  } catch (e) {
    log.err(`Save AI memory error: ${e.message}`);
  }
}

function getHistory(jid) {
  return aiMemory[jid] || [];
}

function addToHistory(jid, role, content) {
  if (!aiMemory[jid]) aiMemory[jid] = [];
  aiMemory[jid].push({ role, content });

  // Trim kalau kebanyakan
  if (aiMemory[jid].length > MAX_MEMORY) {
    aiMemory[jid] = aiMemory[jid].slice(-MAX_MEMORY);
  }

  saveAiMemory();
}

function clearHistory(jid) {
  delete aiMemory[jid];
  saveAiMemory();
}

// ============================================================
// BUILD MESSAGES ARRAY FOR API
// ============================================================
function buildMessages(jid, userContent) {
  const messages = [];

  // System prompt
  const sysPrompt = aiConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  messages.push({ role: 'system', content: sysPrompt });

  // History
  const history = getHistory(jid);
  for (const entry of history) {
    messages.push({ role: entry.role, content: entry.content });
  }

  // Current message
  if (typeof userContent === 'string') {
    messages.push({ role: 'user', content: userContent });
  } else {
    // Multi-modal (image + text)
    messages.push({ role: 'user', content: userContent });
  }

  return messages;
}

// ============================================================
// EXTRACT TEXT FROM DOCUMENT
// ============================================================
async function extractDocumentText(buffer, fileName) {
  const name = fileName.toLowerCase();

  const textExtensions = [
    '.txt', '.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.css',
    '.py', '.java', '.c', '.cpp', '.cs', '.php', '.go', '.rs',
    '.sql', '.xml', '.yaml', '.yml', '.md', '.sh', '.bat', '.env',
    '.log', '.csv', '.ini', '.toml', '.cfg',
  ];

  if (textExtensions.some(ext => name.endsWith(ext))) {
    return buffer.toString('utf8');
  }

  if (name.endsWith('.pdf')) {
    try {
      const pdf = require('pdf-parse');
      const data = await pdf(buffer);
      return data.text;
    } catch (e) {
      return `[Gagal baca PDF: ${e.message}]`;
    }
  }

  return null; // format tidak didukung
}

// ============================================================
// CALL AI API
// ============================================================
async function callAI(messages) {
  if (!aiConfig.apiKey || !aiConfig.model || !aiConfig.baseUrl) {
    throw new Error('AI belum dikonfigurasi. Gunakan perintah setai.');
  }

  // Pastikan baseUrl tidak ada trailing slash
  const baseUrl = aiConfig.baseUrl.replace(/\/+$/, '');

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model: aiConfig.model,
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120_000, // 2 menit timeout
    }
  );

  const result = response.data;
  const answer = result?.choices?.[0]?.message?.content || '';

  if (!answer) {
    throw new Error('AI tidak memberikan respons');
  }

  return answer;
}

// ============================================================
// CLEAN ANSWER (markdown)
// ============================================================
function cleanAnswer(text) {
  // OpenAI-style **bold** → WhatsApp-style *bold*
  return text.replace(/\*\*/g, '*');
}

// ============================================================
// HANDLE AI MESSAGE (dipanggil dari handler.js)
// ============================================================
async function handleAiMessage(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || !isPrivateJid(jid)) return false;
  if (!isAiEnabled(jid)) return false;
  if (!aiConfig.apiKey || !aiConfig.model || !aiConfig.baseUrl) return false;

  try {
    // Tentukan tipe pesan
    const textContent =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      null;

    const imageMsg  = msg.message?.imageMessage || null;
    const docMsg    = msg.message?.documentMessage || null;
    const stickerMsg = msg.message?.stickerMessage || null;

    // Abaikan pesan tanpa konten yang bisa diproses
    if (!textContent && !imageMsg && !docMsg) return false;

    // Tampilkan typing indicator
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);

    let userContent = null;
    let memorySummary = null;

    // === FOTO ===
    if (imageMsg) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger,
          reuploadRequest: sock.updateMediaMessage,
        });
        const base64 = buffer.toString('base64');
        const mime = imageMsg.mimetype || 'image/jpeg';
        const caption = imageMsg.caption || 'Apa yang ada di gambar ini?';

        // Multi-modal content
        userContent = [
          { type: 'text', text: caption },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ];

        memorySummary = `[Kirim Foto]: ${caption}`;
      } catch (e) {
        log.err(`AI foto download error: ${e.message}`);
        await safeSend(sock, jid, { text: '❌ Gagal membaca foto.' });
        return true;
      }
    }

    // === DOKUMEN ===
    else if (docMsg) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger,
          reuploadRequest: sock.updateMediaMessage,
        });
        const fileName = docMsg.fileName || 'unknown';
        const caption = docMsg.caption || '';

        // Cek apakah dokumen itu sebenarnya foto/gambar
        const imgExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        if (imgExts.some(ext => fileName.toLowerCase().endsWith(ext))) {
          const base64 = buffer.toString('base64');
          const mime = docMsg.mimetype || 'image/jpeg';

          userContent = [
            { type: 'text', text: caption || 'Apa yang ada di gambar ini?' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ];
          memorySummary = `[Kirim Gambar HD]: ${fileName}`;
        } else {
          // Coba ekstrak teks
          const extractedText = await extractDocumentText(buffer, fileName);

          if (extractedText === null) {
            await safeSend(sock, jid, {
              text: `⚠️ Format file *${fileName}* belum didukung.\nYang didukung: TXT, PDF, JS, PY, JSON, HTML, CSS, dan file kode/teks lainnya.`,
            });
            return true;
          }

          // Truncate kalau terlalu panjang (max ~15k chars agar tidak melebihi token limit)
          const truncated = extractedText.length > 15000
            ? extractedText.slice(0, 15000) + '\n\n[...dipotong karena terlalu panjang]'
            : extractedText;

          userContent = `FILE: ${fileName}${caption ? ' — ' + caption : ''}\n\n${truncated}`;
          memorySummary = `[Kirim File: ${fileName}]: ${caption || '(tanpa caption)'}`;
        }
      } catch (e) {
        log.err(`AI doc download error: ${e.message}`);
        await safeSend(sock, jid, { text: '❌ Gagal membaca dokumen.' });
        return true;
      }
    }

    // === TEKS BIASA ===
    else if (textContent) {
      userContent = textContent;
      memorySummary = textContent;
    }

    if (!userContent) return false;

    // Simpan pesan user ke memory (versi ringkasan)
    addToHistory(jid, 'user', memorySummary || (typeof userContent === 'string' ? userContent : '[media]'));

    // Build messages & call API
    const messages = buildMessages(jid, userContent);
    const rawAnswer = await callAI(messages);
    const answer = cleanAnswer(rawAnswer);

    // Simpan jawaban AI ke memory
    addToHistory(jid, 'assistant', answer);

    // Kirim jawaban — split kalau panjang
    await sendLongWhatsApp(sock, jid, answer, msg);

    // Stop typing
    await sock.sendPresenceUpdate('available', jid);

    log.ok(`🤖 AI replied to ${jid} (${(typeof userContent === 'string' ? 'text' : 'media')})`);
    return true;

  } catch (err) {
    log.err(`AI handleAiMessage error: ${err.message}`);

    // Stop typing
    try { await sock.sendPresenceUpdate('available', jid); } catch (_) {}

    let errorMsg = '❌ AI error: ' + (err.message || 'Unknown error');

    // Handle spesifik error dari API
    if (err.response?.status === 401) {
      errorMsg = '❌ API key tidak valid. Cek ulang dengan perintah setai.';
    } else if (err.response?.status === 429) {
      errorMsg = '⚠️ Rate limit tercapai. Coba lagi nanti.';
    } else if (err.response?.status === 404) {
      errorMsg = '❌ Model tidak ditemukan. Cek ulang nama model.';
    } else if (err.code === 'ECONNABORTED') {
      errorMsg = '⏱️ AI timeout (>2 menit). Coba pertanyaan lebih pendek.';
    }

    await safeSend(sock, jid, { text: errorMsg, quoted: msg });
    return true;
  }
}

// ============================================================
// SEND LONG MESSAGE (split kalau >4000 chars)
// ============================================================
async function sendLongWhatsApp(sock, jid, text, quotedMsg) {
  const LIMIT = 4000;

  if (text.length <= LIMIT) {
    await safeSend(sock, jid, { text, quoted: quotedMsg });
    return;
  }

  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  let codeBlockOpen = false;
  let codeLang = '';

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      codeBlockOpen = !codeBlockOpen;
      if (codeBlockOpen) {
        codeLang = line.trim().replace(/`/g, '');
      } else {
        codeLang = '';
      }
    }

    if (current.length + line.length + 1 > LIMIT) {
      if (codeBlockOpen) {
        current += '\n```';
      }
      chunks.push(current);
      if (codeBlockOpen) {
        current = '```' + codeLang + '\n' + line + '\n';
      } else {
        current = line + '\n';
      }
    } else {
      current += line + '\n';
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current);
  }

  for (let i = 0; i < chunks.length; i++) {
    const suffix = (i < chunks.length - 1) ? '\n\n_...bersambung_' : '';
    await safeSend(sock, jid, {
      text: chunks[i] + suffix,
      ...(i === 0 ? { quoted: quotedMsg } : {}),
    });
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  aiConfig,
  saveAiConfig,
  isAiEnabled,
  setAiEnabled,
  getHistory,
  addToHistory,
  clearHistory,
  handleAiMessage,
  DEFAULT_SYSTEM_PROMPT,
};
