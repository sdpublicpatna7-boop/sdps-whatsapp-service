/**
 * SDPS WhatsApp microservice (Baileys)
 * ------------------------------------
 * Exposes a small HTTP API consumed by the FastAPI backend:
 *   GET  /status      -> { connected, qr, user, bulkProgress }
 *   POST /disconnect  -> logout + reset session
 *   POST /send-text   -> { phone, message, mediaBase64?, mediaMime?, mediaType? }
 *   POST /send-bulk   -> { contacts:[{phone,name}], message, mediaBase64?, mediaMime?, mediaType?, delayMs }
 *   GET  /bulk-progress (via /status.bulkProgress)
 *   POST /stop-bulk
 *
 * Every request must carry the shared secret header `X-WA-Secret`.
 * Bulk sends are paced with a configurable delay (default 2000ms) to reduce
 * WhatsApp ban risk, and support {name} personalisation in the message.
 */
import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import fs from "fs";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "baileys";
import { useMongoAuthState } from "./mongoAuthState.js";

const PORT = process.env.PORT || 3001;
const WA_API_SECRET = process.env.WA_API_SECRET || "";
const AUTH_DIR = process.env.WA_AUTH_DIR || "./auth_state";
const MONGODB_URL = process.env.MONGODB_URL || "";
const WA_SESSION_ID = process.env.WA_SESSION_ID || "sdps-main";
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
let removeCredsFn = null; // set when using Mongo-backed auth; used on /disconnect

let bulkProgress = { total: 0, sent: 0, failed: 0, running: false, errors: [] };
let stopRequested = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (starting) return;
  starting = true;
  try {
    let state, saveCreds;

    if (MONGODB_URL) {
      // Preferred path: persists across redeploys without needing a paid
      // Render disk. The same WhatsApp device identity is reused every
      // restart, avoiding repeated "new device" pairings that can trigger
      // WhatsApp's anti-abuse reach-out lock (error 463).
      const mongoState = await useMongoAuthState(MONGODB_URL, WA_SESSION_ID);
      state = mongoState.state;
      saveCreds = mongoState.saveCreds;
      removeCredsFn = mongoState.removeCreds;
      console.log("Using MongoDB-backed auth state (session:", WA_SESSION_ID, ")");
    } else {
      // Fallback: local filesystem. WARNING — on Render's free/starter plan
      // (no persistent disk) this directory is wiped on every deploy/restart,
      // forcing a brand-new device pairing each time, which is exactly the
      // pattern that triggers WhatsApp's anti-abuse reach-out lock (error 463).
      if (!fs.existsSync(AUTH_DIR)) {
        console.warn(
          `WARNING: ${AUTH_DIR} does not exist yet and MONGODB_URL is not set. ` +
          `If this directory is not on a persistent disk, every deploy will ` +
          `force a new QR pairing and may trigger WhatsApp error 463 on sends. ` +
          `Set MONGODB_URL to persist the session in MongoDB instead.`
        );
      }
      const fileState = await useMultiFileAuthState(AUTH_DIR);
      state = fileState.state;
      saveCreds = fileState.saveCreds;
      removeCredsFn = null;
    }

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: ["SDPS Portal", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      // Belt-and-suspenders: skip auto link-preview generation on send.
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          currentQR = await qrcode.toDataURL(qr);
        } catch (e) {
          currentQR = null;
        }
      }
      if (connection === "open") {
        isConnected = true;
        currentQR = null;
        meUser = sock?.user || null;
        console.log("WhatsApp connected as", meUser?.id);
      }
      if (connection === "close") {
        isConnected = false;
        meUser = null;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log("WhatsApp connection closed. loggedOut=", loggedOut, "code=", statusCode);
        starting = false;
        if (!loggedOut) {
          await sleep(3000);
          startSock();
        } else {
          // Session invalidated — clear so a fresh QR is produced on next start.
          currentQR = null;
          sock = null;
        }
      }
    });
  } catch (e) {
    console.error("startSock error:", e.message);
    starting = false; // allow retry on unexpected startup error
  }
  // NOTE: do NOT reset `starting` in a finally block here — the socket lives
  // beyond this function. `starting` is reset inside connection.update "close"
  // to prevent duplicate concurrent sockets during reconnect.
}

/** Send a text and/or media message to one JID. */
async function sendMessage(jid, message, media) {
  // generateLinkPreviewIfAbsent:false skips link-preview generation on send.
  // Note: error 463 ("reach-out time-lock") on cold contacts is fixed by
  // Baileys v7's built-in tctoken/cstoken support, not by this option.
  const opts = { generateLinkPreviewIfAbsent: false };
  if (media && media.mediaBase64 && media.mediaType) {
    const buffer = Buffer.from(media.mediaBase64, "base64");
    if (media.mediaType === "image") {
      return sock.sendMessage(jid, { image: buffer, caption: message || "" }, opts);
    }
    if (media.mediaType === "video") {
      return sock.sendMessage(jid, { video: buffer, caption: message || "" }, opts);
    }
  }
  return sock.sendMessage(jid, { text: message || "" }, opts);
}

// ── HTTP API ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "60mb" }));

// Public keep-alive endpoint (no secret) — for the pinger / uptime monitors.
app.get("/ping", (req, res) => res.json({ status: "alive", connected: isConnected }));

// Shared-secret auth for every other route.
app.use((req, res, next) => {
  if (req.headers["x-wa-secret"] !== WA_API_SECRET) {
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
  });
});

app.post("/disconnect", async (req, res) => {
  // IMPORTANT: sock.logout() tells WhatsApp's servers this device is logging
  // out — it invalidates the session server-side regardless of whether we
  // also erase the local/Mongo creds. That always forces a brand-new device
  // pairing on the next connect. Repeated re-pairing is exactly the pattern
  // that triggers WhatsApp's anti-abuse reach-out lock (error 463), so a
  // logout must be explicit, never an accidental side effect of clicking
  // "disconnect" to fix a stuck connection.
  //
  // Send {"confirm": true} to perform a real logout + erase the saved
  // session (use this only when you intend to re-pair with a fresh QR).
  // Without it, this just closes and reopens the socket using the SAME
  // saved session — safe to click any time, no re-pairing required.
  const hardLogout = req.body && req.body.confirm === true;

  try {
    if (sock) {
      try {
        if (hardLogout) {
          await sock.logout();
        } else {
          sock.end(); // local close only — keeps the session valid
        }
      } catch (e) { /* ignore */ }
    }
    if (hardLogout && removeCredsFn) {
      try { await removeCredsFn(); } catch (e) { /* ignore */ }
    }
  } finally {
    isConnected = false;
    meUser = null;
    currentQR = null;
    sock = null;
    await startSock();
    res.json({
      status: "disconnected",
      sessionWiped: hardLogout,
      note: hardLogout
        ? "Logged out and erased the saved session — scan a new QR code to reconnect."
        : "Closed the connection locally; the saved session was kept and should reconnect automatically without a new QR scan.",
    });
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
      if (!jid) {
        bulkProgress.failed++;
        bulkProgress.errors.push(`${c.phone}: invalid number`);
      } else {
        try {
          await sendMessage(jid, personalised, media);
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
      // global fetch is available on Node 18+
      fetch(u).catch(() => { /* non-fatal */ });
    });
  };
  setInterval(tick, intervalMs);
  console.log(`Keep-alive started — every ${intervalMs / 60000} min`);
}
