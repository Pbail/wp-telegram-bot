const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs/promises');
const path = require('path');
const qrcode = require('qrcode');
const WaSession = require('../models/WaSession');
const Template = require('../models/Template');
const ChatState = require('../models/ChatState');
const User = require('../models/User');
const logger = require('../config/logger');

// Holds live whatsapp-web.js Client instances in memory, keyed by sessionId.
// Auth data lives on the LOCAL DISK (LocalAuth) under AUTH_DATA_PATH, not in MongoDB.
// This makes restore on process restart fast and reliable, and keeps MongoDB usage
// limited to lightweight metadata (numbers, templates, chat state).
const liveClients = new Map(); // sessionId -> Client instance

const AUTH_DATA_PATH = path.join(__dirname, '..', 'wwebjs_auth');

const PUPPETEER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

function makeSessionId(telegramId) {
  return `${telegramId}_${Date.now()}`;
}

function localSessionFolder(sessionId) {
  return path.join(AUTH_DATA_PATH, `session-${sessionId}`);
}

/**
 * If the process was ever force-killed (crash, kill -9, terminal closed without
 * Ctrl+C) Chromium can leave lock files behind that prevent it from reusing the
 * same profile on next launch, causing a silent fresh-QR requirement even though
 * the actual session data is fine. Clearing these before every launch is safe.
 */
async function cleanStaleLockFiles(sessionId) {
  const folder = localSessionFolder(sessionId);
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const f of lockFiles) {
    try { await fs.rm(path.join(folder, f), { force: true }); } catch (_) { /* ignore, file may not exist */ }
  }
}

/** Deletes the on-disk auth folder for a session, so dead sessions don't pile up on the server. */
async function removeLocalSessionFolder(sessionId) {
  try {
    await fs.rm(localSessionFolder(sessionId), { recursive: true, force: true });
  } catch (err) {
    console.error(`[Cleanup] Failed to remove local session folder for ${sessionId}:`, err.message);
  }
}

/**
 * Create + start a brand new WhatsApp client for a Telegram user.
 * Calls back with QR data URLs until login succeeds, then with the final phone number.
 */
async function startNewSession(telegramId, { onQr, onReady, onAuthFail, onDisconnected }) {
  const sessionId = makeSessionId(telegramId);

  await WaSession.create({ telegramId: String(telegramId), sessionId, status: 'pending' });
  await cleanStaleLockFiles(sessionId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: AUTH_DATA_PATH }),
    puppeteer: { headless: true, args: PUPPETEER_ARGS }
  });

  liveClients.set(sessionId, client);

  client.on('qr', async (qr) => {
    const dataUrl = await qrcode.toDataURL(qr);
    onQr(sessionId, dataUrl);
  });

  client.on('ready', async () => {
    const number = client.info?.wid?.user || 'unknown';
    await WaSession.updateOne(
      { sessionId },
      { status: 'active', phoneNumber: number, lastActiveAt: new Date() }
    );
    onReady(sessionId, number);
    attachAutoReply(client, telegramId, sessionId);
    await logger.log(`Session Login\nUser: ${telegramId}\nNumber: ${number}\nSession: ${sessionId}`);
  });

  client.on('auth_failure', async (msg) => {
    await WaSession.updateOne({ sessionId }, { status: 'dead' });
    liveClients.delete(sessionId);
    await removeLocalSessionFolder(sessionId);
    onAuthFail(sessionId, msg);
    await logger.log(`Auth Failure\nUser: ${telegramId}\nSession: ${sessionId}\nReason: ${msg}`);
  });

  client.on('disconnected', async (reason) => {
    await WaSession.updateOne({ sessionId }, { status: 'dead' });
    liveClients.delete(sessionId);
    await removeLocalSessionFolder(sessionId);
    onDisconnected(sessionId, reason);
    await logger.log(`Session Disconnected\nUser: ${telegramId}\nSession: ${sessionId}\nReason: ${reason}\n(local session data deleted)`);
  });

  client.initialize();

  return sessionId;
}

/** Restore all sessions marked 'active' in DB when the bot process boots. */
async function restoreAllActiveSessions() {
  const sessions = await WaSession.find({ status: 'active' });

  for (const s of sessions) {
    try {
      await cleanStaleLockFiles(s.sessionId);

      const client = new Client({
        authStrategy: new LocalAuth({ clientId: s.sessionId, dataPath: AUTH_DATA_PATH }),
        puppeteer: { headless: true, args: PUPPETEER_ARGS }
      });

      liveClients.set(s.sessionId, client);

      // If a QR is requested during a "restore", it means the local session data is
      // missing/invalid (e.g. it never belonged to this server, or WhatsApp logged
      // it out on the phone side) -> auto mark it dead instead of hanging forever.
      client.on('qr', async () => {
        await WaSession.updateOne({ sessionId: s.sessionId }, { status: 'dead' });
        liveClients.delete(s.sessionId);
        try { await client.destroy(); } catch (_) {}
        await removeLocalSessionFolder(s.sessionId);
        await logger.log(`Session Invalid on Restore\nNumber: ${s.phoneNumber}\nNo valid local session found - marked dead automatically. Please Login Wp again.`);
      });

      client.on('ready', async () => {
        await WaSession.updateOne({ sessionId: s.sessionId }, { lastActiveAt: new Date() });
        attachAutoReply(client, s.telegramId, s.sessionId);
        await logger.log(`Session Restored\nUser: ${s.telegramId}\nNumber: ${s.phoneNumber}`);
      });

      client.on('disconnected', async (reason) => {
        await WaSession.updateOne({ sessionId: s.sessionId }, { status: 'dead' });
        liveClients.delete(s.sessionId);
        await removeLocalSessionFolder(s.sessionId);
        await logger.log(`Session Disconnected\nUser: ${s.telegramId}\nNumber: ${s.phoneNumber}\nReason: ${reason}\n(local session data deleted)`);
      });

      client.initialize();
    } catch (err) {
      console.error(`[Restore] Failed to restore session ${s.sessionId}:`, err.message);
      await logger.log(`Restore Failed\nSession: ${s.sessionId}\nError: ${err.message}`);
    }
  }
  console.log(`[Restore] Attempted restore for ${sessions.length} session(s)`);
}

const attachedSessions = new Set(); // prevents duplicate listeners if 'ready' fires more than once on the same client

/** Only real 1-to-1 WhatsApp chats should trigger auto-reply - never groups, channels/newsletters, or status broadcasts. */
function isIndividualChat(chatId) {
  return typeof chatId === 'string' && (chatId.endsWith('@c.us') || chatId.endsWith('@lid'));
}

/**
 * Greeting-based auto reply:
 *  - First ever message (or call) from a WhatsApp contact -> send the user's ACTIVE
 *    template (images + message + files) as a greeting, remember its message id.
 *  - Every message/call from that same contact afterwards -> quote-reply the original
 *    greeting message with "Check this."
 */
function attachAutoReply(client, telegramId, sessionId) {
  if (attachedSessions.has(sessionId)) return; // already attached, e.g. 'ready' fired again on reconnect
  attachedSessions.add(sessionId);

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      if (!isIndividualChat(msg.from)) return; // skip groups/@g.us, channels/@newsletter, status@broadcast
      await handleIncoming(client, telegramId, sessionId, msg.from);
    } catch (err) {
      console.error('[AutoReply] message error:', err.message);
      await logger.log(`Auto-Reply Error\nSession: ${sessionId}\nError: ${err.message}`);
    }
  });

  client.on('call', async (call) => {
    try {
      if (!isIndividualChat(call.from)) return;
      await handleIncoming(client, telegramId, sessionId, call.from);
    } catch (err) {
      console.error('[AutoReply] call error:', err.message);
      await logger.log(`Auto-Reply Call Error\nSession: ${sessionId}\nError: ${err.message}`);
    }
  });
}

const VERBOSE = process.env.VERBOSE_LOGS !== 'false'; // default on, helps debugging; set VERBOSE_LOGS=false in .env to quiet it down later

async function handleIncoming(client, telegramId, sessionId, chatId) {
  if (VERBOSE) await logger.log(`WA Event Received\nSession: ${sessionId}\nFrom: ${chatId}`);

  const user = await User.findOne({ telegramId: String(telegramId) });
  if (!user || !user.autoReplyEnabled) {
    if (VERBOSE) await logger.log(`Auto Reply is OFF - ignoring message from ${chatId}`);
    return; // auto reply not started by the user yet
  }

  // Make sure a ChatState doc exists for this contact (first time we've ever seen them).
  const existing = await ChatState.findOneAndUpdate(
    { sessionId, chatId },
    { $setOnInsert: { telegramId: String(telegramId), sessionId, chatId, greeted: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const isNewContact = (Date.now() - new Date(existing.createdAt).getTime()) < 5000;
  if (isNewContact) {
    await logger.log(`New WhatsApp Contact\nSession: ${sessionId}\nContact: ${chatId}`);
  }

  // Atomically CLAIM the "send greeting" job. Only the one event that actually flips
  // greeted false -> true is allowed to send. Any concurrent/duplicate event (e.g. a
  // message and a call arriving within milliseconds of each other) sees greeted already
  // true and falls straight through to the quote-reply branch instead of double-sending.
  const claimed = await ChatState.findOneAndUpdate(
    { sessionId, chatId, greeted: false },
    { $set: { greeted: true } },
    { new: false }
  );

  if (claimed) {
    const template = await Template.findOne({ telegramId: String(telegramId), active: true });
    if (!template) {
      await logger.log(`No Active Template found for user ${telegramId} - cannot greet ${chatId}. Set one Active in Show All Template.`);
      await ChatState.updateOne({ sessionId, chatId }, { greeted: false }); // give up the claim so a later message can retry
      return;
    }

    const firstMsgId = await sendGreeting(client, chatId, template);
    await ChatState.updateOne({ sessionId, chatId }, { greetingMsgId: firstMsgId || '' });
    if (VERBOSE) await logger.log(`Greeting sent to ${chatId} (template: ${template.name || 'unnamed'})`);
    return;
  }

  // Already greeted (or being greeted right now by a concurrent event) -> quote-reply "Check this."
  const state = await ChatState.findOne({ sessionId, chatId });
  if (state && state.greetingMsgId) {
    try {
      await client.sendMessage(chatId, 'Check this.', { quotedMessageId: state.greetingMsgId });
      if (VERBOSE) await logger.log(`"Check this." quote-reply sent to ${chatId}`);
      return;
    } catch (err) {
      await logger.log(`Quote-reply failed (${err.message}) for ${chatId}, greetingMsgId=${state.greetingMsgId}`);
    }
  } else if (VERBOSE) {
    await logger.log(`No greetingMsgId stored yet for ${chatId} - sending "Check this." without quote`);
  }

  await client.sendMessage(chatId, 'Check this.');
  if (VERBOSE) await logger.log(`"Check this." sent to ${chatId} (no quote)`);
}

/**
 * Sends all images + caption + files of a template, returns the id of the first media
 * message sent (used for quoting later).
 *
 * For speed: every attachment is downloaded/converted from Telegram IN PARALLEL first
 * (this is the slow, network-bound part), then sent to WhatsApp one at a time in order
 * (WhatsApp Web's browser page handles sends more reliably one-by-one). Downloaded
 * media is also cached in memory (see telegramFileToMedia), so greeting the 2nd, 3rd,
 * 100th new contact with the same template skips the Telegram download entirely.
 */
/**
 * whatsapp-web.js has changed the shape of the object returned by sendMessage() across
 * versions — usually it's sent.id._serialized, but some versions/message types expose
 * it differently. Try every known shape; if none match, log the actual object shape
 * once so we can see exactly what this installed version returns.
 */
async function extractMsgId(sent, context) {
  if (!sent) {
    try { await logger.log(`DEBUG: sendMessage() returned no value for ${context} (message likely still delivered, just no id in response)`); } catch (_) {}
    return null;
  }
  if (sent.id && sent.id._serialized) return sent.id._serialized;
  if (sent._data && sent._data.id && sent._data.id._serialized) return sent._data.id._serialized;
  if (typeof sent.id === 'string') return sent.id;
  if (sent._serialized) return sent._serialized;

  // Nothing matched — log what we actually got so the real shape is visible in the log group.
  try {
    await logger.log(`DEBUG: could not extract message id (${context}). Keys: ${Object.keys(sent).join(', ')} | id keys: ${sent.id ? Object.keys(sent.id).join(', ') : 'no id field'}`);
  } catch (_) {}
  return null;
}

/**
 * Fallback for when sendMessage()'s return value didn't give us a usable id (this
 * happens for some contact types, e.g. @lid privacy IDs, in some whatsapp-web.js
 * versions — the message still gets delivered, just the response object is unreliable).
 * We simply ask WhatsApp for the actual last message in that chat right after sending.
 */
async function fetchLastMessageId(client, chatId) {
  try {
    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 1 });
    if (msgs && msgs.length > 0 && msgs[msgs.length - 1].id && msgs[msgs.length - 1].id._serialized) {
      return msgs[msgs.length - 1].id._serialized;
    }
  } catch (err) {
    await logger.log(`Could not fetch fallback last-message id for ${chatId}: ${err.message}`);
  }
  return null;
}

async function sendGreeting(client, chatId, template) {
  let firstMsgId = null;

  const imagePrep = await Promise.all(
    template.images.map((img) =>
      telegramFileToMedia(img.telegramFileId, { fileName: 'image.jpg', fallbackMime: 'image/jpeg' })
        .then((media) => ({ ok: true, media }))
        .catch((error) => ({ ok: false, error }))
    )
  );

  const filePrep = await Promise.all(
    template.files.map((f) =>
      buildFileMedia(f)
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({ ok: false, error }))
    )
  );

  if (template.images.length > 0) {
    for (let i = 0; i < imagePrep.length; i++) {
      const p = imagePrep[i];
      if (!p.ok) {
        await logger.log(`Failed to prepare image #${i + 1} for ${chatId}: ${p.error.message}`);
        continue;
      }
      try {
        const caption = i === 0 ? (template.message || undefined) : undefined;
        const sent = await client.sendMessage(chatId, p.media, { caption });
        if (!firstMsgId) firstMsgId = await extractMsgId(sent, `image #${i + 1}`);
      } catch (err) {
        await logger.log(`Failed to send image #${i + 1} to ${chatId}: ${err.message}`);
      }
    }
  } else if (template.message) {
    try {
      const sent = await client.sendMessage(chatId, template.message);
      firstMsgId = await extractMsgId(sent, 'greeting text');
    } catch (err) {
      await logger.log(`Failed to send greeting text to ${chatId}: ${err.message}`);
    }
  }

  for (let i = 0; i < filePrep.length; i++) {
    const p = filePrep[i];
    if (!p.ok) {
      await logger.log(`Failed to prepare file #${i + 1} for ${chatId}: ${p.error.message}`);
      continue;
    }
    try {
      const sent = await client.sendMessage(chatId, p.media, p.sendOptions);
      if (!firstMsgId) firstMsgId = await extractMsgId(sent, `file #${i + 1}`);
    } catch (err) {
      await logger.log(`Failed to send file #${i + 1} to ${chatId}: ${err.message}`);
    }
  }

  // If none of the sendMessage() responses gave us a usable id, fall back to asking
  // WhatsApp directly for the last message in this chat (reliable regardless of the
  // exact reason the response object didn't have one).
  if (!firstMsgId && (template.images.length > 0 || template.files.length > 0 || template.message)) {
    firstMsgId = await fetchLastMessageId(client, chatId);
  }

  return firstMsgId;
}

/** Picks the right mimetype fallback + WhatsApp send options (e.g. voice-note flag) per template file type. */
async function buildFileMedia(f) {
  let opts = { fileName: f.fileName || undefined };
  let sendOptions = {};

  if (f.type === 'voice') {
    opts.fallbackMime = 'audio/ogg; codecs=opus';
    opts.fileName = f.fileName || 'voice-note.ogg';
    sendOptions.sendAudioAsVoice = true; // renders as a playable WhatsApp voice note, not a generic file
  } else if (f.type === 'audio') {
    opts.fallbackMime = 'audio/mpeg';
  } else if (f.type === 'video') {
    opts.fallbackMime = 'video/mp4';
  } else {
    opts.fallbackMime = 'application/octet-stream';
  }

  const media = await telegramFileToMedia(f.telegramFileId, opts);
  return { media, sendOptions };
}

/**
 * whatsapp-web.js needs raw file bytes. We fetch the file from Telegram's Bot API
 * using the stored file_id, then wrap it as MessageMedia. `botInstance` is injected
 * at startup via setBotInstance() so this module can call Telegram's API.
 *
 * IMPORTANT: Telegram's file server always responds with
 * `content-type: application/octet-stream` regardless of the real file type, so we
 * cannot trust the HTTP header. Instead we guess the mimetype from the file's
 * extension (which Telegram does preserve in the download path).
 */
const EXT_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.oga': 'audio/ogg; codecs=opus', '.ogg': 'audio/ogg; codecs=opus', '.opus': 'audio/ogg; codecs=opus',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.txt': 'text/plain'
};

let botInstance = null;
function setBotInstance(bot) {
  botInstance = bot;
}

// Caches the downloaded+converted media by Telegram file_id, so greeting the 2nd,
// 3rd... Nth new WhatsApp contact with the same template skips re-downloading from
// Telegram entirely — a big speed win once a template has been used a few times.
const mediaCache = new Map(); // fileId -> { mimeType, base64, fileName }

async function telegramFileToMedia(fileId, opts = {}) {
  const cached = mediaCache.get(fileId);
  if (cached) {
    return new MessageMedia(cached.mimeType, cached.base64, cached.fileName);
  }

  const link = await botInstance.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  const buffer = Buffer.from(await res.arrayBuffer());

  const urlPath = new URL(link.href).pathname; // e.g. /file/bot<token>/voice/file_1.oga
  let ext = urlPath.includes('.') ? urlPath.slice(urlPath.lastIndexOf('.')) : '';
  if (!ext && opts.fileName && opts.fileName.includes('.')) {
    ext = opts.fileName.slice(opts.fileName.lastIndexOf('.'));
  }

  const mimeType = EXT_MIME_MAP[ext.toLowerCase()] || opts.fallbackMime || 'application/octet-stream';
  const fileName = opts.fileName || `file${ext || ''}`;
  const base64 = buffer.toString('base64');

  mediaCache.set(fileId, { mimeType, base64, fileName });

  return new MessageMedia(mimeType, base64, fileName);
}

function getLiveSessionIds() {
  return Array.from(liveClients.keys());
}

/**
 * Gracefully closes every live WhatsApp client (Puppeteer/Chromium) so its session
 * profile finishes writing to disk before the process exits. Without this, killing
 * the Node process (Ctrl+C, restart, deploy) can force-kill Chromium mid-write and
 * corrupt the local session, forcing a fresh QR login every single restart.
 * IMPORTANT: uses destroy(), never logout() — this only pauses the session, it does
 * not log the WhatsApp account out.
 */
async function shutdownAllSessions() {
  const entries = Array.from(liveClients.entries());
  await Promise.all(entries.map(async ([sessionId, client]) => {
    try {
      await client.destroy();
      console.log(`[Shutdown] Closed session ${sessionId} cleanly`);
    } catch (err) {
      console.error(`[Shutdown] Failed to close session ${sessionId}:`, err.message);
    }
  }));
}

async function logoutSession(sessionId) {
  const client = liveClients.get(sessionId);
  if (client) {
    try { await client.logout(); } catch (_) { /* ignore */ }
    try { await client.destroy(); } catch (_) { /* ignore */ }
    liveClients.delete(sessionId);
  }
  attachedSessions.delete(sessionId);
  await WaSession.updateOne({ sessionId }, { status: 'dead' });
  await removeLocalSessionFolder(sessionId); // clean up local disk, nothing left behind for a dead session
}

function cancelPendingSession(sessionId) {
  const client = liveClients.get(sessionId);
  if (client) {
    client.destroy().catch(() => {});
    liveClients.delete(sessionId);
  }
  attachedSessions.delete(sessionId);
  WaSession.deleteOne({ sessionId, status: 'pending' }).catch(() => {});
  removeLocalSessionFolder(sessionId).catch(() => {});
}

module.exports = {
  startNewSession,
  restoreAllActiveSessions,
  logoutSession,
  cancelPendingSession,
  setBotInstance,
  getLiveSessionIds,
  shutdownAllSessions
};
