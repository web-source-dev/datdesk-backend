'use strict';

/**
 * Live mailbox watch for users who are currently connected over the socket.
 * IMAP IDLE waits for a new message, saves only that message, then pushes it.
 */
const EmailAccount = require('../models/EmailAccount');
const MailboxMessage = require('../models/MailboxMessage');
const {
  canFetchLifetimeForAccount,
  getOAuthAccessToken,
  normalizeParsedMail,
  resolveImapSettings
} = require('./mailService');

const watches = new Map();
let started = false;

function accountKey(accountId) {
  return String(accountId || '');
}

function isFatalAuthError(err) {
  const msg = String(err?.message || err || '');
  return /unauthorized|insufficient authentication scopes|gmail api has not been used|invalid_grant|imap login failed|authentication failed|invalid credentials/i.test(
    msg
  );
}

function envelopeAddresses(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => String(item?.address || item?.email || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ');
}

function toSocketMessage(account, msg) {
  const { extractEmail } = require('./inboxRealtime');
  const from = extractEmail(msg.from) || String(msg.from || '').toLowerCase();
  const to = extractEmail(msg.to) || String(msg.to || '').toLowerCase();
  const peer = msg.direction === 'inbound' ? from : to;
  return {
    id: msg.providerMessageId,
    source: 'mailbox',
    direction: msg.direction || 'inbound',
    from: msg.from || from,
    to: msg.to || to,
    subject: msg.subject || '',
    snippet: msg.snippet || '',
    body: msg.body || '',
    bodyHtml: msg.bodyHtml || '',
    date: msg.internalDate || new Date().toISOString(),
    accountId: String(account._id),
    peer,
    status: 'received'
  };
}

function pushLive(account, messages) {
  if (!messages?.length) return 0;
  const { emitInboxUpdate, extractEmail } = require('./inboxRealtime');
  const peers = [
    ...new Set(
      messages
        .map((msg) =>
          msg.direction === 'inbound' ? extractEmail(msg.from) : extractEmail(msg.to)
        )
        .filter(Boolean)
    )
  ];
  emitInboxUpdate(account.userId, {
    reason: 'received',
    accountId: account._id,
    peers,
    messages: messages.map((msg) => toSocketMessage(account, msg))
  });
  return messages.length;
}

async function saveLiveMessages(account, messages, { notify = true } = {}) {
  const fresh = [];
  const provider = account.method === 'oauth' ? 'gmail' : 'imap';
  for (const msg of messages || []) {
    if (!msg?.providerMessageId) continue;
    const existed = await MailboxMessage.exists({
      accountId: account._id,
      providerMessageId: msg.providerMessageId
    });
    await MailboxMessage.findOneAndUpdate(
      { accountId: account._id, providerMessageId: msg.providerMessageId },
      {
        $set: {
          userId: account.userId,
          accountId: account._id,
          provider,
          ...msg,
          syncedAt: new Date()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (!existed) fresh.push(msg);
  }
  if (!fresh.length) return 0;
  if (notify) {
    pushLive(account, fresh);
    console.log(`[mailbox-watch] +${fresh.length} ${account.email} → ${fresh.map((m) => m.from || m.to).join(', ')}`);
  }
  return fresh.length;
}

async function resolveWatchAuth(account) {
  if (account.method === 'oauth') {
    const accessToken = await getOAuthAccessToken(account);
    return {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: account.email,
        accessToken
      }
    };
  }
  const settings = resolveImapSettings(account);
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: {
      user: settings.user,
      pass: settings.pass
    }
  };
}

function fromImapEnvelope(account, msg) {
  const from = envelopeAddresses(msg.envelope?.from);
  const to = envelopeAddresses(msg.envelope?.to);
  const subject = String(msg.envelope?.subject || '').slice(0, 1000);
  return {
    providerMessageId: `imap:INBOX:${msg.uid}`,
    threadId: '',
    labelIds: ['INBOX'],
    direction: 'inbound',
    from,
    to,
    cc: envelopeAddresses(msg.envelope?.cc),
    subject,
    snippet: subject,
    body: '',
    bodyHtml: '',
    internalDate: msg.internalDate ? new Date(msg.internalDate) : new Date()
  };
}

async function fetchNewImapMessages(client, account, fromSeq, toSeq) {
  if (toSeq < fromSeq) return 0;
  const { simpleParser } = require('mailparser');
  const preview = [];
  try {
    for await (const msg of client.fetch(`${fromSeq}:${toSeq}`, {
      uid: true,
      envelope: true,
      internalDate: true
    })) {
      const quick = fromImapEnvelope(account, msg);
      preview.push({ uid: msg.uid, quick });
      pushLive(account, [quick]);
    }
  } catch (err) {
    console.warn('[mailbox-watch] envelope fetch failed', account.email, err?.message || err);
  }
  if (preview.length) {
    saveLiveMessages(
      account,
      preview.map((row) => row.quick),
      { notify: false }
    ).catch(() => {});
  }

  const full = [];
  try {
    const uids = preview.map((row) => row.uid).filter(Boolean);
    if (!uids.length) return preview.length;
    for (const uid of uids) {
      try {
        const msg = await client.fetchOne(
          uid,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            source: { start: 0, maxLength: 80_000 }
          },
          { uid: true }
        );
        if (!msg) continue;
        const parsed = await simpleParser(msg.source || '');
        if (!parsed.date && msg.internalDate) parsed.date = msg.internalDate;
        const normalized = await normalizeParsedMail(parsed, {
          providerMessageId: `imap:INBOX:${uid}`,
          direction: 'inbound',
          labelIds: ['INBOX']
        });
        if (!normalized.from) normalized.from = envelopeAddresses(msg.envelope?.from);
        if (!normalized.to) normalized.to = envelopeAddresses(msg.envelope?.to);
        if (!normalized.subject) normalized.subject = String(msg.envelope?.subject || '');
        if (!normalized.internalDate && msg.internalDate) {
          normalized.internalDate = new Date(msg.internalDate);
        }
        full.push(normalized);
        pushLive(account, [normalized]);
      } catch (err) {
        console.warn('[mailbox-watch] skip message', account.email, uid, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[mailbox-watch] body fetch failed', account.email, err?.message || err);
  }
  if (full.length) {
    saveLiveMessages(account, full, { notify: false }).catch(() => {});
  }
  return preview.length || full.length;
}

function getEntry(account) {
  const key = accountKey(account._id);
  const current = watches.get(key);
  if (current) return current;
  const entry = {
    accountId: key,
    userId: String(account.userId),
    email: account.email,
    client: null,
    reconnectTimer: null,
    lastExists: 0,
    backoffMs: 4000,
    failures: 0,
    starting: false,
    stopping: false,
    fatal: false
  };
  watches.set(key, entry);
  return entry;
}

function stopWatch(accountId, { silent } = {}) {
  const key = accountKey(accountId);
  const entry = watches.get(key);
  if (!entry) return;
  entry.stopping = true;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.client) {
    try {
      entry.client.close();
    } catch {
      // ignore
    }
  }
  watches.delete(key);
  if (!silent) console.log('[mailbox-watch] stopped', entry.email);
}

function scheduleReconnect(account, entry) {
  if (entry.stopping || entry.fatal) return;
  if (entry.failures >= 4) {
    entry.fatal = true;
    console.warn('[mailbox-watch] giving up on', account.email, '(will retry when you open Inbox again)');
    return;
  }
  if (entry.reconnectTimer) return;
  const delay = entry.backoffMs;
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    startWatchForAccount(account).catch(() => {});
  }, delay);
  entry.backoffMs = Math.min(60_000, Math.round(entry.backoffMs * 2));
}

async function startWatchForAccount(account) {
  if (!account || !canFetchLifetimeForAccount(account)) return;
  const entry = getEntry(account);
  if (entry.stopping || entry.fatal) return;
  if (entry.starting) return;
  if (entry.client) return;

  entry.starting = true;
  entry.email = account.email;
  try {
    const { ImapFlow } = require('imapflow');
    const conn = await resolveWatchAuth(account);
    const client = new ImapFlow({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
      auth: conn.auth,
      logger: false,
      emitLogs: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 25 * 60_000,
      disableCompression: true,
      tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: conn.host }
    });

    client.on('error', () => {});

    await client.connect();
    await client.mailboxOpen('INBOX');
    entry.client = client;
    entry.lastExists = Number(client.mailbox?.exists || 0);
    entry.backoffMs = 4000;
    entry.failures = 0;

    client.on('exists', (data) => {
      const count = Number(data?.count || client.mailbox?.exists || 0);
      const prev = Number(data?.prevCount != null ? data.prevCount : entry.lastExists);
      entry.lastExists = count;
      if (count <= prev) return;
      fetchNewImapMessages(client, account, prev + 1, count).catch((err) => {
        console.warn('[mailbox-watch] live fetch failed', account.email, err?.message || err);
      });
    });

    client.on('close', () => {
      entry.client = null;
      if (entry.stopping || entry.fatal) return;
      entry.failures += 1;
      scheduleReconnect(account, entry);
    });

    console.log(`[mailbox-watch] listening for new mail on ${account.email}`);
  } catch (err) {
    entry.failures += 1;
    if (isFatalAuthError(err)) {
      entry.fatal = true;
      console.warn('[mailbox-watch] skipped', account.email, '— mailbox login is invalid or IMAP is off');
      return;
    }
    if (entry.failures === 1) {
      console.warn('[mailbox-watch] could not watch', account.email, err?.message || err);
    }
    scheduleReconnect(account, entry);
  } finally {
    entry.starting = false;
  }
}

async function startWatchesForUser(userId) {
  if (!userId) return;
  const accounts = await EmailAccount.find({ userId })
    .select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc')
    .limit(8);
  for (const account of accounts) {
    const entry = watches.get(accountKey(account._id));
    if (entry?.fatal) {
      entry.fatal = false;
      entry.failures = 0;
      entry.backoffMs = 4000;
      entry.stopping = false;
    }
    startWatchForAccount(account).catch(() => {});
  }
}

function startMailboxWatch() {
  if (started) return;
  started = true;
  console.log('[mailbox-watch] ready — watches start when a user opens Inbox');
}

function stopMailboxWatch() {
  started = false;
  for (const key of [...watches.keys()]) stopWatch(key, { silent: true });
}

module.exports = {
  startMailboxWatch,
  stopMailboxWatch,
  startWatchesForUser,
  startWatchForAccount,
  stopWatch
};
