'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const qrcode  = require('qrcode-terminal');
const express = require('express');
const QRCode  = require('qrcode'); // beda sama qrcode-terminal, ini buat generate PNG
const chalk  = require('chalk');
const { CONFIG, log, logger } = require('./src/config');
const { handleUpsert } = require('./src/handler');
const { reminders, setBotSock, scheduleReminder } = require('./src/reminders');

// ============================================================
// WEB SERVER (liat QR dari browser: /qr)
// ============================================================
let lastQR = null; // di-set di listener connection.update pas ada QR baru, di-clear pas connect

const app = express();

app.get('/qr', async (req, res) => {
  if (!lastQR) return res.send('Belum ada QR atau udah connect.');
  try {
    const png = await QRCode.toBuffer(lastQR, { width: 400 });
    res.type('png').send(png);
  } catch (err) {
    log.err(`Route /qr error: ${err.message}`);
    res.status(500).send('Gagal generate QR.');
  }
});

app.listen(CONFIG.WEB_PORT, () => {
  log.ok(`🌐 QR web server jalan di http://localhost:${CONFIG.WEB_PORT}/qr`);
});

// ============================================================
// MAIN BOT
// ============================================================
let reconnectCount = 0;
let isConnecting = false;

async function startBot() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    console.log(chalk.cyan(`
╔═══════════════════════════════════════════════════════════╗
║   📸  WhatsApp Bot - View Once + Sticker + Downloader     ║
║   Version : ${CONFIG.VERSION}                                       ║
║   ✨ .sticker | .toimage | .tovideo | .tag | .dl         ║
╚═══════════════════════════════════════════════════════════╝
`));

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_FOLDER);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: true,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25_000,       // Ping WA server tiap 25 detik biar koneksi gak mati
      retryRequestDelayMs: 2_000,        // Retry lebih cepat kalau ada request gagal
      getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isOnline, receivedPendingNotifications } = update;
      if (qr) {
        lastQR = qr;
        qrcode.generate(qr, { small: true });
        log.info(`Scan QR di atas (atau buka http://localhost:${CONFIG.WEB_PORT}/qr).`);
      }
      if (connection === 'connecting') {
        log.info('🔄 Menghubungkan ke WhatsApp...');
      }
      if (connection === 'open') {
        reconnectCount = 0; isConnecting = false;
        lastQR = null; // udah connect, QR lama gak valid lagi
        setBotSock(sock);
        log.ok(`✅ Bot connected!`);
        log.info('📥 Menunggu pesan...');

        // Jadwalkan ulang reminder yang belum punya timer aktif (mis. abis restart)
        for (const r of reminders.values()) {
          if (!r.timer) scheduleReminder(r);
        }
      }
      if (receivedPendingNotifications) {
        log.ok('📬 Pending notifications synced — koneksi fully ready.');
      }
      if (connection === 'close') {
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log.err('Logged out. Hapus auth_info dan restart.');
          return;
        }
        if (reconnectCount >= CONFIG.MAX_RECONNECT) {
          log.err(`Reconnect limit reached.`);
          process.exit(1);
        }
        reconnectCount++;
        log.warn(`Reconnect ${reconnectCount}/${CONFIG.MAX_RECONNECT}...`);
        setTimeout(startBot, CONFIG.RECONNECT_DELAY_MS);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', (payload) => {
      handleUpsert(sock, payload).catch(err => {
        log.err(`messages.upsert error: ${err.message}`);
      });
    });

    return sock;

  } catch (err) {
    isConnecting = false;
    log.err(`startBot error: ${err.message}`);
    if (reconnectCount < CONFIG.MAX_RECONNECT) {
      reconnectCount++;
      setTimeout(startBot, CONFIG.RECONNECT_DELAY_MS);
    } else { process.exit(1); }
  }
}

// ============================================================
// GUARD
// ============================================================
process.on('unhandledRejection', (reason) => {
  log.err(`unhandledRejection: ${reason.message || reason}`);
});
process.on('uncaughtException', (err) => {
  log.err(`uncaughtException: ${err.message}`);
});
process.on('SIGINT', () => { log.warn('SIGINT. Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { log.warn('SIGTERM. Shutting down...'); process.exit(0); });

startBot();
