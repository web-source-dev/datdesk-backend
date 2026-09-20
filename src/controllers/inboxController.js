const mongoose = require('mongoose');
const EmailAccount = require('../models/EmailAccount');
const EmailSent = require('../models/EmailSent');
const MailboxMessage = require('../models/MailboxMessage');
const { logActivity } = require('../services/activityLogService');
const { fetchMailboxMessagesBatch, canFetchLifetimeForAccount } = require('../services/mailService');
const { notifyMailboxChanges } = require('../services/inboxRealtime');
const { listUserAccounts, isAllowedFlag } = require('../services/emailLimits');

function parsePaging(query, { defaultLimit = 30, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function isObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ''));
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getOwnedAccount(userId, accountId, res) {
  if (!isObjectId(accountId)) {
    res.status(400).json({ message: 'Invalid account id' });
    return null;
  }
  const account = await EmailAccount.findOne({ _id: accountId, userId });
  if (!account) {
    res.status(404).json({ message: 'Email account not found' });
    return null;
  }
  return account;
}

function extractEmail(value) {
  const s = String(value || '').trim().toLowerCase();
  const angle = s.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const bare = s.match(/[^\s<>]+@[^\s<>]+/);
  return bare ? bare[0].toLowerCase() : '';
}

function mapSentRow(row) {
  const to = extractEmail(row.to) || String(row.to || '').trim().toLowerCase();
  return {
    id: String(row._id),
    source: 'sent',
    direction: 'outbound',
    from: row.from || '',
    to,
    cc: row.cc || '',
    subject: row.subject || '',
    snippet: String(row.body || row.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    body: row.body || '',
    bodyHtml: row.bodyHtml || '',
    date: row.sentAt || row.createdAt || null,
    status: row.status || 'sent',
    error: row.error || '',
    accountId: row.accountId ? String(row.accountId) : null,
    templateId: row.templateId ? String(row.templateId) : null,
    peer: to
  };
}

function mapMailboxRow(row, includeBody = false) {
  const from = extractEmail(row.from) || String(row.from || '').trim().toLowerCase();
  const to = extractEmail(row.to) || String(row.to || '').trim().toLowerCase();
  const direction = row.direction || 'unknown';
  const base = {
    id: String(row._id),
    source: 'mailbox',
    direction,
    from: row.from || from,
    to: row.to || to,
    cc: row.cc || '',
    subject: row.subject || '',
    snippet: String(row.snippet || row.body || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    date: row.internalDate || row.createdAt || null,
    accountId: String(row.accountId),
    threadId: row.threadId || '',
    provider: row.provider || 'unknown',
    peer: direction === 'inbound' ? from : to
  };
  if (includeBody) {
    base.body = row.body || '';
    base.bodyHtml = row.bodyHtml || '';
  }
  return base;
}

function peerOfSent(row) {
  return extractEmail(row.to);
}

function peerOfMailbox(row) {
  return row.direction === 'inbound' ? extractEmail(row.from) : extractEmail(row.to);
}

const CHAT_SENT_LIST_FIELDS = 'from to cc subject sentAt createdAt status error accountId templateId';
const CHAT_SENT_THREAD_FIELDS = 'from to cc subject body bodyHtml sentAt createdAt status error accountId templateId';
const CHAT_MAIL_LIST_FIELDS = 'from to cc subject snippet direction internalDate createdAt accountId threadId provider';
const CHAT_MAIL_THREAD_FIELDS = `${CHAT_MAIL_LIST_FIELDS} body bodyHtml`;

async function loadPlatformConversation(userId, accountId, peer) {
  const email = extractEmail(peer);
  if (!email) return [];

  const fromMatch = new RegExp(escapeRegex(email), 'i');
  const [sentRows, inboundRows] = await Promise.all([
    EmailSent.find({ userId, accountId, to: email })
      .select(CHAT_SENT_THREAD_FIELDS)
      .sort({ sentAt: 1, createdAt: 1 })
      .limit(300)
      .lean(),
    MailboxMessage.find({
      userId,
      accountId,
      direction: 'inbound',
      from: fromMatch
    })
      .select(CHAT_MAIL_THREAD_FIELDS)
      .sort({ internalDate: 1, createdAt: 1 })
      .limit(300)
      .lean()
  ]);

  const outbound = sentRows.map(mapSentRow);
  const inbound = inboundRows
    .filter((row) => peerOfMailbox(row) === email)
    .map((row) => mapMailboxRow(row, true));

  return outbound.concat(inbound).sort((a, b) => {
    const ta = new Date(a.date || 0).getTime();
    const tb = new Date(b.date || 0).getTime();
    return ta - tb;
  });
}

async function loadPlatformChats(userId, accountId) {
  const sentRows = await EmailSent.find({ userId, accountId })
    .select(CHAT_SENT_LIST_FIELDS)
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  const peers = [...new Set(sentRows.map(peerOfSent).filter(Boolean))];
  if (!peers.length) return [];

  const inboundRows = await MailboxMessage.find({
    userId,
    accountId,
    direction: 'inbound'
  })
    .select(CHAT_MAIL_LIST_FIELDS)
    .sort({ internalDate: -1, createdAt: -1 })
    .limit(800)
    .lean();

  const byPeer = new Map();
  sentRows.forEach((row) => {
    const peer = peerOfSent(row);
    if (!peer) return;
    const mapped = mapSentRow(row);
    const cur = byPeer.get(peer) || [];
    cur.push(mapped);
    byPeer.set(peer, cur);
  });
  inboundRows.forEach((row) => {
    const peer = peerOfMailbox(row);
    if (!peer || !byPeer.has(peer)) return;
    byPeer.get(peer).push(mapMailboxRow(row, false));
  });

  return [...byPeer.entries()]
    .map(([peer, messages]) => {
      messages.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      const last = messages[messages.length - 1] || {};
      return {
        id: peer,
        source: 'chat',
        peer,
        from: last.from || '',
        to: last.to || peer,
        direction: last.direction || 'outbound',
        subject: last.subject || '',
        snippet: last.snippet || '',
        date: last.date || null,
        status: last.status || 'sent',
        accountId: String(accountId),
        count: messages.length
      };
    })
    .sort(sortByDateDesc);
}

function sortByDateDesc(a, b) {
  const ta = new Date(a.date || 0).getTime();
  const tb = new Date(b.date || 0).getTime();
  return tb - ta;
}

/** GET /email/inbox/accounts */
async function listInboxAccounts(req, res) {
  try {
    const userId = req.user.userId;
    const accounts = await listUserAccounts(userId);

    const [sentCounts, chatCounts] = await Promise.all([
      EmailSent.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
        { $group: { _id: '$accountId', count: { $sum: 1 } } }
      ]),
      EmailSent.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
        { $group: { _id: { accountId: '$accountId', to: '$to' } } },
        { $group: { _id: '$_id.accountId', count: { $sum: 1 } } }
      ])
    ]);

    const sentByAccount = Object.fromEntries(sentCounts.map((c) => [String(c._id || ''), c.count]));
    const chatsByAccount = Object.fromEntries(chatCounts.map((c) => [String(c._id || ''), c.count]));

    return res.json({
      accounts: accounts.map((a) => ({
        ...a.toSafeJSON(),
        allowed: isAllowedFlag(a),
        usable: isAllowedFlag(a),
        canSync: canFetchLifetimeForAccount(a),
        counts: {
          chats: chatsByAccount[String(a._id)] || 0,
          received: 0,
          sentApp: sentByAccount[String(a._id)] || 0,
          sentMailbox: 0,
          sent: sentByAccount[String(a._id)] || 0
        }
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list inbox accounts' });
  }
}

async function buildInboxSnapshot(userId, accountId, query = {}) {
  const account = await EmailAccount.findOne({ _id: accountId, userId });
  if (!account) return { error: 'Email account not found' };

  const { page, limit, skip } = parsePaging(query);
  const search = String(query.search || '').trim().toLowerCase();

  let chats = await loadPlatformChats(userId, account._id);
  if (search) {
    chats = chats.filter((chat) => {
      const hay = [chat.peer, chat.subject, chat.snippet, chat.from, chat.to]
        .join(' ')
        .toLowerCase();
      return hay.includes(search);
    });
  }

  return {
    account: {
      ...account.toSafeJSON(),
      allowed: isAllowedFlag(account),
      usable: isAllowedFlag(account),
      canSync: canFetchLifetimeForAccount(account)
    },
    folder: 'chats',
    page,
    limit,
    total: chats.length,
    messages: chats.slice(skip, skip + limit)
  };
}

async function buildInboxConversation(userId, accountId, peerValue) {
  const account = await EmailAccount.findOne({ _id: accountId, userId });
  if (!account) return { error: 'Email account not found' };
  const peer = extractEmail(peerValue);
  if (!peer) return { error: 'Recipient email is required' };

  const thread = await loadPlatformConversation(userId, account._id, peer);
  if (!thread.length) return { error: 'No platform conversation with this email' };
  const last = thread[thread.length - 1];
  return {
    peer,
    message: {
      ...last,
      source: 'chat',
      peer,
      to: peer
    },
    thread
  };
}

/** GET /email/inbox/:accountId/messages — platform chats only */
async function listInboxMessages(req, res) {
  try {
    const userId = req.user.userId;
    const data = await buildInboxSnapshot(userId, req.params.accountId, req.query);
    if (data.error) {
      const status = /not found/i.test(data.error) ? 404 : 400;
      return res.status(status).json({ message: data.error });
    }
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list inbox messages' });
  }
}

/** GET /email/inbox/:accountId/conversation?peer= */
async function getInboxConversation(req, res) {
  try {
    const userId = req.user.userId;
    const data = await buildInboxConversation(userId, req.params.accountId, req.query.peer);
    if (data.error) {
      const status = /not found/i.test(data.error) ? 404 : 400;
      return res.status(status).json({ message: data.error });
    }
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load conversation' });
  }
}

/** GET /email/inbox/messages/:id?source=mailbox|sent */
async function getInboxMessage(req, res) {
  try {
    const userId = req.user.userId;
    const source = String(req.query.source || 'mailbox').trim().toLowerCase();

    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid message id' });
    }

    if (source === 'sent') {
      const row = await EmailSent.findOne({ _id: req.params.id, userId });
      if (!row) return res.status(404).json({ message: 'Message not found' });
      const message = mapSentRow(row);
      return res.json({ message, thread: [message] });
    }

    const row = await MailboxMessage.findOne({ _id: req.params.id, userId });
    if (!row) return res.status(404).json({ message: 'Message not found' });
    const message = mapMailboxRow(row, true);
    let thread = [message];
    if (row.threadId) {
      const rows = await MailboxMessage.find({
        userId,
        accountId: row.accountId,
        threadId: row.threadId
      })
        .sort({ internalDate: 1, createdAt: 1 })
        .limit(40);
      if (rows.length) thread = rows.map((item) => mapMailboxRow(item, true));
    }
    return res.json({ message, thread });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load message' });
  }
}

/** POST /email/inbox/:accountId/sync */
async function syncInboxAccount(req, res) {
  try {
    const userId = req.user.userId;
    const account = await EmailAccount.findOne({
      _id: req.params.accountId,
      userId
    }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');
    if (!account) return res.status(404).json({ message: 'Email account not found' });

    if (!canFetchLifetimeForAccount(account)) {
      return res.status(400).json({
        message: 'Sync is not supported for this account type',
        code: 'UNSUPPORTED_METHOD'
      });
    }

    const maxMessages = Math.min(100, Math.max(1, Number(req.body?.maxMessages) || 50));
    const pageToken = String(req.body?.pageToken || '');

    const batch = await fetchMailboxMessagesBatch(account, { maxMessages, pageToken });
    const provider = batch.provider || (account.method === 'oauth' ? 'gmail' : 'imap');

    let upserted = 0;
    const fresh = [];
    for (const msg of batch.messages) {
      const existed = await MailboxMessage.exists({
        accountId: account._id,
        providerMessageId: msg.providerMessageId
      });
      await MailboxMessage.findOneAndUpdate(
        { accountId: account._id, providerMessageId: msg.providerMessageId },
        {
          $set: {
            userId,
            accountId: account._id,
            provider,
            ...msg,
            syncedAt: new Date()
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      upserted += 1;
      if (!existed) fresh.push(msg);
    }
    if (fresh.length) {
      notifyMailboxChanges({
        userId,
        accountId: account._id,
        messages: fresh,
        reason: 'received'
      }).catch((err) => {
        console.warn('[inbox] realtime notify failed:', err?.message || err);
      });
    }

    await logActivity({
      userId,
      actorEmail: req.user?.email || '',
      action: 'email.inbox_sync',
      category: 'email',
      status: 'success',
      message: `Synced ${upserted} messages for ${account.email}`,
      meta: {
        accountId: String(account._id),
        accountEmail: account.email,
        provider,
        upserted,
        nextPageToken: batch.nextPageToken || ''
      },
      req
    });

    const [received, sentApp, sentMailbox] = await Promise.all([
      MailboxMessage.countDocuments({ accountId: account._id, direction: 'inbound' }),
      EmailSent.countDocuments({ accountId: account._id }),
      MailboxMessage.countDocuments({ accountId: account._id, direction: 'outbound' })
    ]);

    return res.json({
      message: `Synced ${upserted} messages`,
      upserted,
      nextPageToken: batch.nextPageToken || '',
      hasMore: Boolean(batch.nextPageToken),
      provider,
      counts: {
        received,
        sentApp,
        sentMailbox,
        sent: sentApp + sentMailbox
      }
    });
  } catch (error) {
    await logActivity({
      userId: req.user?.userId,
      actorEmail: req.user?.email || '',
      action: 'email.inbox_sync',
      category: 'email',
      status: 'failure',
      message: error.message || 'Inbox sync failed',
      meta: { accountId: req.params.accountId },
      req
    });
    return res.status(500).json({
      message: error.message || 'Failed to sync inbox',
      code: error.code || 'SYNC_FAILED'
    });
  }
}

module.exports = {
  listInboxAccounts,
  listInboxMessages,
  getInboxMessage,
  getInboxConversation,
  syncInboxAccount,
  buildInboxSnapshot,
  buildInboxConversation
};
