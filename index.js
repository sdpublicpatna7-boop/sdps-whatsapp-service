/**
 * SDPS WhatsApp microservice (Baileys)
 * ------------------------------------
 * Exposes a small HTTP API consumed by the FastAPI backend:
 *   GET  /status        -> { connected, qr, user, bulkProgress, uptimeSec }
 *   POST /disconnect    -> logout + wipe auth + generate fresh QR
 *   POST /reset-session -> force wipe stale session + generate fresh QR
 *   POST /pairing-code  -> { phone } -> { success, pairingCode, phone }
 *   POST /send-text     -> { phone, message, mediaBase64?, mediaMime?, mediaType? }
 *   POST /send-bulk     -> { contacts:[{phone,name}], message, mediaBase64?, mediaMime?, mediaType?, delayMs }
 *   GET  /bulk-progress (via /status.bulkProgress)
 *   POST /stop-bulk
 *
 * Every request must carry the shared secret header `X-WA-Secret`.
 * Bulk sends are paced with a configurable delay (default 2000ms) to reduce
 * WhatsApp ban risk, and support {name} personalisation in the message.
 */
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode";
import pino from "pino";
import { Boom } from "@hapi/boom";
import baileysPkg from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const makeWASocket = baileysPkg.default || baileysPkg.makeWASocket || baileysPkg;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
} = baileysPkg;

const PORT = process.env.PORT || 3001;
const WA_API_SECRET = process.env.WA_API_SECRET || "";
const AUTH_DIR = process.env.WA_AUTH_DIR || "./auth_state";
const DEFAULT_DELAY_MS = parseInt(process.env.WA_BULK_DELAY_MS || "2000", 10);

if (!WA_API_SECRET || WA_API_SECRET === "change-me-secret") {
  console.error("FATAL: WA_API_SECRET must be set to a strong shared secret.");
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// ── Connection state ─────────────────────────────────────────────────────────
let sock = null;
let currentQR = null;      // base64 PNG data URL while waiting to be scanned
let isConnected = false;
let meUser = null;
let starting = false;

let bulkProgress = { total: 0, sent: 0, failed: 0, running: false, errors: [] };
let stopRequested = false;
let disconnecting = false;  // Flag to prevent close handler from interfering during disconnect

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clean up persisted Baileys auth state folder */
function cleanAuthDir() {
  const paths = [
    path.resolve(AUTH_DIR),
    path.join(__dirname, "auth_state"),
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log("[WhatsApp] Cleaned auth state directory:", p);
      }
    } catch (e) {
      console.warn("[WhatsApp] Could not clean auth state at:", p, e.message);
    }
  }
}

/** Normalise an Indian-style phone number to a WhatsApp JID. */
function toJid(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  // 10-digit local number -> prepend India country code.
  if (digits.length === 10) digits = "91" + digits;
  // Handle leading 0 then 10 digits.
  if (digits.length === 11 && digits.startsWith("0")) digits = "91" + digits.slice(1);
  if (digits.length < 11 || digits.length > 15) return null;
  return `${digits}@s.whatsapp.net`;
}

async function startSock() {
  if (starting) {
    console.log("[WhatsApp] startSock already in progress, skipping duplicate call.");
    return;
  }
  starting = true;

  try {
    // 1. Clean up old socket if it exists
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch (e) { /* ok */ }
      try { sock.ws?.close(); } catch (e) { /* ok */ }
      try { sock.end?.(undefined); } catch (e) { /* ok */ }
      sock = null;
    }

    const resolvedAuthDir = path.resolve(AUTH_DIR);
    if (!fs.existsSync(resolvedAuthDir)) {
      fs.mkdirSync(resolvedAuthDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(resolvedAuthDir);

    let version = [2, 3000, 1019143644];
    try {
      if (typeof fetchLatestWaWebVersion === "function") {
        const v = await fetchLatestWaWebVersion();
        if (v?.version) version = v.version;
      } else if (typeof fetchLatestBaileysVersion === "function") {
        const v = await fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
      }
    } catch (e) {
      console.warn("[WhatsApp] Version fetch fallback:", e.message);
    }

    // Browsers.macOS("Desktop") provides the official desktop handshake tuple
    const browserConfig = Browsers?.macOS ? Browsers.macOS("Desktop") : ["Mac OS", "Desktop", "14.4.1"];

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: browserConfig,
      qrTimeout: 60000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 5,
      getMessage: async () => ({ conversation: "" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQR = await qrcode.toDataURL(qr, {
            margin: 2,
            scale: 8,
            color: { dark: "#0f172a", light: "#ffffff" },
          });
          console.log("[WhatsApp] Fresh QR code generated and ready to scan!");
        } catch (e) {
          console.error("[WhatsApp] QR generation error:", e.message);
          currentQR = null;
        }
      }

      if (connection === "open") {
        isConnected = true;
        currentQR = null;
        meUser = sock?.user || null;
        console.log("[WhatsApp] Successfully connected as:", meUser?.id || meUser?.name);
      }

      if (connection === "close") {
        isConnected = false;
        meUser = null;

        if (disconnecting) {
          console.log("[WhatsApp] Socket closed during intentional disconnect/reset.");
          return;
        }

        const boom = new Boom(lastDisconnect?.error);
        const statusCode = boom?.output?.statusCode || lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`[WhatsApp] Connection closed. StatusCode: ${statusCode} (loggedOut=${isLoggedOut})`);

        starting = false;

        if (isLoggedOut) {
          console.log("[WhatsApp] Device was logged out. Cleaning auth directory and generating fresh session...");
          cleanAuthDir();
          currentQR = null;
          await sleep(2000);
          startSock();
        } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          console.log("[WhatsApp] Restart required (handshake/pairing completed). Restarting socket with saved creds...");
          await sleep(1000);
          startSock();
        } else {
          console.log(`[WhatsApp] Connection dropped (status code: ${statusCode}). Reconnecting in 3s...`);
          await sleep(3000);
          startSock();
        }
      }
    });
  } catch (e) {
    console.error("[WhatsApp] startSock error:", e.message);
  } finally {
    starting = false;
  }
}

/** Send a text and/or media message to one JID. */
async function sendMessage(jid, message, media) {
  if (media && media.mediaBase64 && media.mediaType) {
    const buffer = Buffer.from(media.mediaBase64, "base64");
    if (media.mediaType === "image") {
      return sock.sendMessage(jid, { image: buffer, caption: message || "" });
    }
    if (media.mediaType === "video") {
      return sock.sendMessage(jid, { video: buffer, caption: message || "" });
    }
  }
  return sock.sendMessage(jid, { text: message || "" });
}

// ── HTTP API ─────────────────────────────────────────────────────────────────
const app = express();
// 20mb accommodates base64-encoded media (~15mb raw) without allowing memory exhaustion
app.use(express.json({ limit: process.env.WA_BODY_LIMIT || "20mb" }));

// Public keep-alive endpoint (no secret) — for the pinger / uptime monitors.
app.get("/ping", (req, res) => res.json({ status: "alive", connected: isConnected }));

// Shared-secret auth for every other route (timing-safe comparison).
const secretBuf = Buffer.from(WA_API_SECRET);
const secretMatches = (provided) => {
  const providedBuf = Buffer.from(String(provided || ""));
  return (
    providedBuf.length === secretBuf.length &&
    crypto.timingSafeEqual(providedBuf, secretBuf)
  );
};

app.use((req, res, next) => {
  if (!secretMatches(req.headers["x-wa-secret"])) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    qr: currentQR,
    user: meUser ? { id: meUser.id, name: meUser.name } : null,
    bulkProgress,
    uptimeSec: Math.floor(process.uptime()),
  });
});

app.post("/reset-session", async (req, res) => {
  console.log("[WhatsApp] ===== RESET SESSION REQUESTED =====");
  disconnecting = true;
  isConnected = false;
  meUser = null;
  currentQR = null;
  starting = false;

  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (e) { /* ok */ }
    try { sock.ws?.close(); } catch (e) { /* ok */ }
    try { sock.end?.(undefined); } catch (e) { /* ok */ }
    sock = null;
  }

  cleanAuthDir();
  await sleep(1500);

  disconnecting = false;
  startSock();

  // Wait briefly (up to 3s) to return fresh QR immediately if available
  for (let i = 0; i < 6; i++) {
    if (currentQR) break;
    await sleep(500);
  }

  res.json({
    status: "reset_complete",
    message: "Fresh QR session initialized.",
    qr: currentQR,
  });
});

app.post("/disconnect", (req, res, next) => {
  // Disconnect behaves identically to reset-session: wipes stale state & restarts fresh QR
  req.url = "/reset-session";
  app.handle(req, res, next);
});

app.post("/pairing-code", async (req, res) => {
  if (isConnected) {
    return res.status(400).json({ error: "WhatsApp is already connected." });
  }
  const { phone } = req.body || {};
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length === 11 && digits.startsWith("0")) digits = "91" + digits.slice(1);

  if (digits.length < 11 || digits.length > 15) {
    return res.status(400).json({ error: "Invalid mobile number. Please enter a valid 10-digit Indian phone number." });
  }

  if (!sock) {
    await startSock();
    await sleep(2000);
  }

  try {
    if (typeof sock?.requestPairingCode !== "function") {
      return res.status(500).json({ error: "Pairing code is not supported by the current socket." });
    }
    const rawCode = await sock.requestPairingCode(digits);
    const formattedCode = rawCode?.match(/.{1,4}/g)?.join("-") || rawCode;
    console.log(`[WhatsApp] Pairing code generated for ${digits}: ${formattedCode}`);
    res.json({ success: true, pairingCode: formattedCode, rawCode, phone: digits });
  } catch (e) {
    console.error("[WhatsApp] Pairing code generation error:", e.message);
    res.status(500).json({ error: `Could not generate pairing code: ${e.message}` });
  }
});

app.post("/send-text", async (req, res) => {
  if (!isConnected || !sock) return res.status(409).json({ error: "WhatsApp not connected" });
  const { phone, message } = req.body || {};
  const jid = toJid(phone);
  if (!jid) return res.status(400).json({ error: "Invalid phone number" });
  try {
    await sendMessage(jid, message, req.body);
    res.json({ success: true, jid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/send-bulk", async (req, res) => {
  if (!isConnected || !sock) return res.status(409).json({ error: "WhatsApp not connected" });
  if (bulkProgress.running) return res.status(409).json({ error: "A campaign is already running" });

  const { contacts, message, delayMs } = req.body || {};
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: "No contacts provided" });
  }
  const media = {
    mediaBase64: req.body.mediaBase64,
    mediaMime: req.body.mediaMime,
    mediaType: req.body.mediaType,
  };
  const delay = Number.isFinite(delayMs) ? Math.max(500, delayMs) : DEFAULT_DELAY_MS;

  bulkProgress = { total: contacts.length, sent: 0, failed: 0, running: true, errors: [] };
  stopRequested = false;

  // Respond immediately; the campaign runs in the background and is polled via /status.
  res.json({ started: true, total: contacts.length, delayMs: delay });

  (async () => {
    for (let i = 0; i < contacts.length; i++) {
      if (stopRequested) break;
      const c = contacts[i];
      const jid = toJid(c.phone);
      // Per-contact message (e.g. fee reminders) takes precedence; otherwise
      // fall back to the shared campaign message with {name} personalisation.
      const personalised = c.message
        ? c.message
        : (message || "").replace(/\{name\}/g, c.name || "");
      
      const contactMedia = (c.mediaBase64) ? {
        mediaBase64: c.mediaBase64,
        mediaMime: c.mediaMime || "image/jpeg",
        mediaType: c.mediaType || "image"
      } : media;

      if (!jid) {
        bulkProgress.failed++;
        bulkProgress.errors.push(`${c.phone}: invalid number`);
      } else {
        try {
          await sendMessage(jid, personalised, contactMedia);
          bulkProgress.sent++;
        } catch (e) {
          bulkProgress.failed++;
          bulkProgress.errors.push(`${c.phone}: ${e.message}`);
        }
      }
      // Pace the sends (skip the wait after the last one).
      if (i < contacts.length - 1 && !stopRequested) await sleep(delay);
    }
    bulkProgress.running = false;
  })().catch((e) => {
    bulkProgress.running = false;
    bulkProgress.errors.push(`fatal: ${e.message}`);
  });
});

app.post("/stop-bulk", (req, res) => {
  stopRequested = true;
  res.json({ status: "stopping" });
});

app.listen(PORT, () => {
  console.log(`SDPS WhatsApp service listening on :${PORT}`);
  startSock();
  startKeepAlive();
});

// ── Keep-alive: ping self + the backend every ~12 min so neither Render
// instance spins down for inactivity (24x7 warm). ───────────────────────────
function startKeepAlive() {
  const intervalMs = (parseInt(process.env.KEEPALIVE_INTERVAL_SEC || "720", 10)) * 1000;
  const selfUrl = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "").replace(/\/+$/, "");
  const backendUrl = (process.env.BACKEND_URL || "").replace(/\/+$/, "");
  const tick = () => {
    const targets = [];
    if (selfUrl) targets.push(`${selfUrl}/ping`);
    if (backendUrl) targets.push(`${backendUrl}/api/ping`);
    targets.forEach((u) => {
      fetch(u).catch(() => { /* non-fatal */ });
    });
  };
  setInterval(tick, intervalMs);
  console.log(`Keep-alive started — every ${intervalMs / 60000} min`);
}
