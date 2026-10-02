'use strict';

const fs   = require('fs');
const path = require('path');

const PREFIX_FILE = path.join(__dirname, '..', 'prefix.json');
let currentPrefix = '.';

// Load dari file kalau ada
try {
  if (fs.existsSync(PREFIX_FILE)) {
    const data = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf8'));
    if (data.prefix && typeof data.prefix === 'string') {
      currentPrefix = data.prefix;
    }
  }
} catch (_) {}

function getPrefix() {
  return currentPrefix;
}

function setPrefix(newPrefix) {
  if (!newPrefix || typeof newPrefix !== 'string') {
    throw new Error('Prefix harus berupa teks');
  }
  if (newPrefix.length > 5) {
    throw new Error('Prefix terlalu panjang! Maksimal 5 karakter');
  }
  currentPrefix = newPrefix;
  fs.writeFileSync(PREFIX_FILE, JSON.stringify({ prefix: newPrefix }), 'utf8');
}

module.exports = { getPrefix, setPrefix };
