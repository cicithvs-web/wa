const https = require("https");
const fs = require("fs");
const path = require("path");

const BIN_DIR = path.join(__dirname, "bin");
const BIN_PATH = path.join(BIN_DIR, "yt-dlp");
const DOWNLOAD_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

function download(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Terlalu banyak redirect"));

    https
      .get(url, { headers: { "User-Agent": "node" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(download(res.headers.location, dest, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Gagal download, status: ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

(async () => {
  try {
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log("Mengunduh yt-dlp standalone binary...");
    await download(DOWNLOAD_URL, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    console.log("yt-dlp berhasil disiapkan di:", BIN_PATH);
  } catch (err) {
    console.error("Gagal menyiapkan yt-dlp:", err.message);
    console.error("Coba download manual dan taruh di folder bin/yt-dlp, lalu chmod +x");
    process.exit(1);
  }
})();
