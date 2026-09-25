'use strict';

const fs = require('fs');
const { log } = require('./config');

const TAG_STATE_FILE = './tag_state.json';
const tagStates = new Map();

function loadTagStates() {
  try {
    if (fs.existsSync(TAG_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TAG_STATE_FILE, 'utf8'));
      for (const [key, value] of Object.entries(data)) {
        tagStates.set(key, value);
      }
      log.ok(`✅ Loaded ${tagStates.size} tag states`);
    }
  } catch (_) {}
}

function saveTagStates() {
  try {
    const data = Object.fromEntries(tagStates);
    fs.writeFileSync(TAG_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

loadTagStates();

module.exports = { tagStates, saveTagStates };
