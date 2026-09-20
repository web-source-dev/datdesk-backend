'use strict';

const { WebSocketServer } = require('ws');
const User = require('../models/User');
const { verifyToken } = require('../utils/jwt');
const { isOriginAllowed, parseAllowedOrigins } = require('../utils/corsOrigins');

const rooms = new Map();

function extractEmail(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  const angle = s.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const bare = s.match(/[^\s<>]+@[^\s<>]+/);
  return bare ? bare[0].toLowerCase() : '';
}

function roomKey(userId) {
  return String(userId || '');
}

function socketsFor(userId) {
  return rooms.get(roomKey(userId));
}

function hasRealtimeListeners(userId) {
  const set = socketsFor(userId);
  return Boolean(set && set.size);
}

function socketOriginAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'chrome-extension:') return true;
    if (host === 'one.dat.com' || host.endsWith('.dat.com')) return true;
  } catch {
    // fall through
  }
  return isOriginAllowed(origin, parseAllowedOrigins());
}

function tokenFromRequest(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = String(url.searchParams.get('token') || '').trim();
    if (q) return q.replace(/^Bearer\s+/i, '');
  } catch {
    // ignore
  }
  const header = String(req.headers?.authorization || '').trim();
  return header.replace(/^Bearer\s+/i, '');
}

async function authenticateSocketToken(rawToken) {
  const token = String(rawToken || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  if (!payload?.userId) return null;
  const user = await User.findById(payload.userId).select('activeSessionId isBanned email role');
  if (!user || user.isBanned) return null;
  if (!payload.sessionId || !user.activeSessionId || payload.sessionId !== user.activeSessionId) {
    return null;
  }
  return {
    userId: String(payload.userId),
    email: payload.email || user.email,
    role: payload.role || user.role
  };
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function emitInboxUpdate(userId, payload) {
  const set = socketsFor(userId);
  if (!set || !set.size) return 0;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const message = {
    type: 'inbox.updated',
    at: new Date().toISOString(),
    reason: payload?.reason || 'update',
    accountId: payload?.accountId ? String(payload.accountId) : '',
    peers: Array.isArray(payload?.peers)
      ? payload.peers.map((p) => extractEmail(p)).filter(Boolean)
      : [],
    messages,
    sentId: payload?.sentId ? String(payload.sentId) : undefined
  };
  let n = 0;
  for (const ws of set) {
    sendJson(ws, message);
    n += 1;
  }
  return n;
}

async function notifyMailboxChanges({ userId, accountId, messages, reason = 'received' } = {}) {
  if (!userId || !accountId) return 0;
  const peers = [];
  for (const msg of messages || []) {
    const from = extractEmail(msg.from);
    const to = extractEmail(msg.to);
    const peer = msg.direction === 'inbound' ? from : to;
    if (peer && !peers.includes(peer)) peers.push(peer);
  }
  if (!peers.length) return 0;
  return emitInboxUpdate(userId, {
    reason,
    accountId,
    peers
  });
}

function addSocket(userId, ws) {
  const key = roomKey(userId);
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(ws);
  try {
    require('./mailboxWatchService').startWatchesForUser(key);
  } catch (err) {
    console.warn('[inbox-realtime] watch start failed:', err?.message || err);
  }
}

function removeSocket(userId, ws) {
  const key = roomKey(userId);
  const set = rooms.get(key);
  if (!set) return;
  set.delete(ws);
  if (!set.size) rooms.delete(key);
}

async function handleInboxSocketRequest(ws, user, data) {
  const requestId = data?.requestId || '';
  const accountId = String(data?.accountId || '');
  const { buildInboxSnapshot, buildInboxConversation } = require('../controllers/inboxController');

  if (data.type === 'hello') {
    sendJson(ws, { type: 'ready', requestId, userId: user.userId, accountId });
    if (!accountId) return;
    const snap = await buildInboxSnapshot(user.userId, accountId, {
      page: 1,
      limit: 25,
      search: data.search || ''
    });
    if (snap.error) {
      sendJson(ws, { type: 'inbox.error', requestId, message: snap.error });
      return;
    }
    sendJson(ws, { type: 'inbox.snapshot', requestId, accountId, ...snap });
    return;
  }

  if (data.type === 'inbox.list') {
    const snap = await buildInboxSnapshot(user.userId, accountId, {
      page: data.page,
      limit: data.limit,
      search: data.search || ''
    });
    if (snap.error) {
      sendJson(ws, { type: 'inbox.error', requestId, message: snap.error });
      return;
    }
    sendJson(ws, { type: 'inbox.snapshot', requestId, accountId, ...snap });
    return;
  }

  const convo = await buildInboxConversation(user.userId, accountId, data.peer || data.id);
  if (convo.error) {
    sendJson(ws, { type: 'inbox.error', requestId, message: convo.error });
    return;
  }
  sendJson(ws, { type: 'inbox.conversation', requestId, accountId, ...convo });
}

function attachInboxRealtime(server) {
  const wss = new WebSocketServer({
    server,
    path: '/email/inbox/realtime',
    verifyClient(info, done) {
      if (!socketOriginAllowed(info.origin || '')) {
        done(false, 403, 'Origin not allowed');
        return;
      }
      done(true);
    }
  });

  wss.on('connection', async (ws, req) => {
    let user = null;
    try {
      user = await authenticateSocketToken(tokenFromRequest(req));
    } catch (err) {
      console.warn('[inbox-realtime] auth failed:', err?.message || err);
    }
    if (!user) {
      sendJson(ws, { type: 'error', code: 'AUTH_FAILED', message: 'Sign in again.' });
      ws.close(4401, 'auth');
      return;
    }

    addSocket(user.userId, ws);
    sendJson(ws, { type: 'ready', userId: user.userId });

    ws.on('message', (raw) => {
      let data = null;
      try {
        data = JSON.parse(String(raw || ''));
      } catch {
        return;
      }
      if (data?.type === 'ping') {
        sendJson(ws, { type: 'pong', at: Date.now() });
        return;
      }
      if (data?.type === 'hello' || data?.type === 'inbox.list' || data?.type === 'inbox.conversation') {
        handleInboxSocketRequest(ws, user, data).catch((err) => {
          sendJson(ws, {
            type: 'inbox.error',
            requestId: data.requestId || '',
            message: err?.message || 'Inbox request failed'
          });
        });
      }
    });

    ws.on('close', () => removeSocket(user.userId, ws));
    ws.on('error', () => removeSocket(user.userId, ws));
  });

  console.log('[inbox-realtime] WebSocket attached at /email/inbox/realtime');
  return wss;
}

module.exports = {
  attachInboxRealtime,
  emitInboxUpdate,
  notifyMailboxChanges,
  hasRealtimeListeners,
  extractEmail
};
