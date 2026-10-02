'use strict';

const fs   = require('fs');
const path = require('path');
const { log } = require('./config');

const WELCOME_FILE = path.join(__dirname, '..', 'welcome_state.json');

// { [jid]: { enabled: bool, welcomeMsg: string, byeMsg: string } }
let welcomeStates = {};

// Load dari file
try {
  if (fs.existsSync(WELCOME_FILE)) {
    welcomeStates = JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8'));
  }
} catch (_) {}

function saveWelcomeStates() {
  try {
    fs.writeFileSync(WELCOME_FILE, JSON.stringify(welcomeStates, null, 2), 'utf8');
  } catch (e) {
    log.err(`Save welcome states error: ${e.message}`);
  }
}

const DEFAULT_WELCOME = 'Halo {name} 👋\nSelamat datang di *{group}*!\nKamu member ke-{count} 🎉';
const DEFAULT_BYE     = 'Sampai jumpa {name} 👋\nTelah meninggalkan *{group}*';

function getWelcomeState(jid) {
  return welcomeStates[jid] || null;
}

function ensureState(jid) {
  if (!welcomeStates[jid]) {
    welcomeStates[jid] = {
      enabled: false,
      welcomeMsg: DEFAULT_WELCOME,
      byeMsg: DEFAULT_BYE,
    };
  }
  return welcomeStates[jid];
}

function setWelcomeEnabled(jid, enabled) {
  ensureState(jid).enabled = enabled;
  saveWelcomeStates();
}

function setWelcomeMsg(jid, msg) {
  ensureState(jid).welcomeMsg = msg;
  saveWelcomeStates();
}

function setByeMsg(jid, msg) {
  ensureState(jid).byeMsg = msg;
  saveWelcomeStates();
}

/**
 * Format template welcome/bye dengan placeholder:
 *   {name}  — nama/nomor member (dengan @)
 *   {group} — nama grup
 *   {count} — jumlah member sekarang
 */
function formatWelcomeMsg(template, { name, group, count }) {
  return template
    .replace(/{name}/gi, name)
    .replace(/{group}/gi, group)
    .replace(/{count}/gi, String(count));
}

/**
 * Listener untuk event Baileys group-participants.update
 */
async function handleGroupParticipantsUpdate(sock, { id, participants, action }) {
  try {
    if (action !== 'add' && action !== 'remove') return;

    const state = getWelcomeState(id);
    if (!state || !state.enabled) return;

    // Ambil metadata grup (nama grup, jumlah member)
    let groupName = 'Grup';
    let memberCount = 0;
    try {
      const groupMeta = await sock.groupMetadata(id);
      groupName = groupMeta.subject || 'Grup';
      memberCount = groupMeta.participants?.length || 0;
    } catch (e) {
      log.dim(`Gagal ambil metadata grup untuk welcome: ${e.message}`);
    }

    const template = action === 'add'
      ? (state.welcomeMsg || DEFAULT_WELCOME)
      : (state.byeMsg || DEFAULT_BYE);

    for (const participant of participants) {
      // Abaikan jika yang join/leave adalah bot sendiri
      const botId = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
      if (participant === botId || participant === sock.user?.id) continue;

      const participantNumber = participant.split('@')[0];
      const mentionText = `@${participantNumber}`;

      const text = formatWelcomeMsg(template, {
        name: mentionText,
        group: groupName,
        count: memberCount,
      });

      await sock.sendMessage(id, {
        text,
        mentions: [participant],
      });
      log.info(`[WELCOME] ${action === 'add' ? 'Welcome' : 'Goodbye'} dikirim untuk ${participantNumber} di ${groupName}`);
    }
  } catch (err) {
    log.err(`handleGroupParticipantsUpdate error: ${err.message}`);
  }
}

module.exports = {
  getWelcomeState,
  setWelcomeEnabled,
  setWelcomeMsg,
  setByeMsg,
  formatWelcomeMsg,
  saveWelcomeStates,
  handleGroupParticipantsUpdate,
  DEFAULT_WELCOME,
  DEFAULT_BYE,
};
