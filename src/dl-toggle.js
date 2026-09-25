'use strict';

const fs = require('fs');
const { log } = require('./config');

const DL_STATE_FILE = './dl_state.json';
const dlOffStates = new Map();

function loadDlOffStates() {
  try {
    if (fs.existsSync(DL_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(DL_STATE_FILE, 'utf8'));
      for (const [key, value] of Object.entries(data)) {
        dlOffStates.set(key, value);
      }
      log.ok(`✅ Loaded ${dlOffStates.size} dl-off states`);
    }
  } catch (_) {}
}

function saveDlOffStates() {
  try {
    const data = Object.fromEntries(dlOffStates);
    fs.writeFileSync(DL_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

function isAutoDownloadEnabled(jid) {
  return dlOffStates.get(jid) !== true;
}

loadDlOffStates();

module.exports = { dlOffStates, saveDlOffStates, isAutoDownloadEnabled };
