const mongoose = require('mongoose');
const EmailAccount = require('../models/EmailAccount');
const EmailSent = require('../models/EmailSent');
const MailboxMessage = require('../models/MailboxMessage');
const { logActivity } = require('../services/activityLogService');
const { fetchMailboxMessagesBatch, canFetchLifetimeForAccount } = require('../services/mailService');
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

function mapSentRow(row) {
  return {
    id: String(row._id),
    source: 'sent',
    direction: 'outbound',
    from: row.from || '',
    to: row.to || '',
    cc: '',
    subject: row.subject || '',
    snippet: String(row.body || '').slice(0, 200),
    body: row.body || '',
    bodyHtml: '',
    date: row.sentAt || row.createdAt || null,
    status: row.status || 'sent',
    error: row.error || '',
    accountId: row.accountId ? String(row.accountId) : null,
    templateId: row.templateId ? String(row.templateId) : null
  };
}

function mapMailboxRow(row, includeBody = false) {
  const base = {
    id: String(row._id),
    source: 'mailbox',
    direction: row.direction || 'unknown',
    from: row.from || '',
    to: row.to || '',
    cc: row.cc || '',
    subject: row.subject || '',
    snippet: row.snippet || '',
    date: row.internalDate || row.createdAt || null,
    accountId: String(row.accountId),
    threadId: row.threadId || '',
    provider: row.provider || 'unknown'
  };
  if (includeBody) {
    base.body = row.body || '';
    base.bodyHtml = row.bodyHtml || '';
  }
  return base;
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

    const [sentCounts, receivedCounts, mailboxSentCounts] = await Promise.all([
      EmailSent.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
        { $group: { _id: '$accountId', count: { $sum: 1 } } }
      ]),
      MailboxMessage.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)), direction: 'inbound' } },
        { $group: { _id: '$accountId', count: { $sum: 1 } } }
      ]),
      MailboxMessage.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)), direction: 'outbound' } },
        { $group: { _id: '$accountId', count: { $sum: 1 } } }
      ])
    ]);

    const sentByAccount = Object.fromEntries(sentCounts.map((c) => [String(c._id || ''), c.count]));
    const receivedByAccount = Object.fromEntries(receivedCounts.map((c) => [String(c._id || ''), c.count]));
    const mailboxSentByAccount = Object.fromEntries(
      mailboxSentCounts.map((c) => [String(c._id || ''), c.count])
    );

    return res.json({
      accounts: accounts.map((a) => ({
        ...a.toSafeJSON(),
        allowed: isAllowedFlag(a),
        usable: isAllowedFlag(a),
        canSync: canFetchLifetimeForAccount(a),
        counts: {
          received: receivedByAccount[String(a._id)] || 0,
          sentApp: sentByAccount[String(a._id)] || 0,
          sentMailbox: mailboxSentByAccount[String(a._id)] || 0,
          sent:
            (sentByAccount[String(a._id)] || 0) + (mailboxSentByAccount[String(a._id)] || 0)
        }
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list inbox accounts' });
  }
}

/** GET /email/inbox/:accountId/messages?folder=received|sent|all */
async function listInboxMessages(req, res) {
  try {
    const userId = req.user.userId;
    const account = await getOwnedAccount(userId, req.params.accountId, res);
    if (!account) return undefined;

    const { page, limit, skip } = parsePaging(req.query);
    const folder = String(req.query.folder || 'all').trim().toLowerCase();
    const search = String(req.query.search || '').trim();
    const searchRx = search ? new RegExp(escapeRegex(search), 'i') : null;

    let items = [];

    if (folder === 'received' || folder === 'all') {
      const filter = {
        userId,
        accountId: account._id,
        direction: 'inbound'
      };
      if (searchRx) {
        filter.$or = [
          { from: searchRx },
          { to: searchRx },
          { subject: searchRx },
          { snippet: searchRx }
        ];
      }
      const rows = await MailboxMessage.find(filter)
        .sort({ internalDate: -1, createdAt: -1 })
        .limit(folder === 'received' ? limit : 500)
        .skip(folder === 'received' ? skip : 0);
      items = items.concat(rows.map((r) => mapMailboxRow(r)));
    }

    if (folder === 'sent' || folder === 'all') {
      const mergeCap = folder === 'sent' ? Math.min(500, skip + limit) : 500;
      const sentFilter = { userId, accountId: account._id };
      if (searchRx) {
        sentFilter.$or = [{ from: searchRx }, { to: searchRx }, { subject: searchRx }];
      }
      const sentRows = await EmailSent.find(sentFilter)
        .sort({ createdAt: -1 })
        .limit(mergeCap);
      items = items.concat(sentRows.map(mapSentRow));

      const mbFilter = {
        userId,
        accountId: account._id,
        direction: 'outbound'
      };
      if (searchRx) {
        mbFilter.$or = [
          { from: searchRx },
          { to: searchRx },
          { subject: searchRx },
          { snippet: searchRx }
        ];
      }
      const mbRows = await MailboxMessage.find(mbFilter)
        .sort({ internalDate: -1, createdAt: -1 })
        .limit(mergeCap);
      items = items.concat(mbRows.map((r) => mapMailboxRow(r)));
    }

    items.sort(sortByDateDesc);

    let total = items.length;
    if (folder === 'received') {
      const filter = { userId, accountId: account._id, direction: 'inbound' };
      if (searchRx) {
        filter.$or = [
          { from: searchRx },
          { to: searchRx },
          { subject: searchRx },
          { snippet: searchRx }
        ];
      }
      total = await MailboxMessage.countDocuments(filter);
      items = items.slice(0, limit);
    } else if (folder === 'sent') {
      const sentFilter = { userId, accountId: account._id };
      if (searchRx) {
        sentFilter.$or = [{ from: searchRx }, { to: searchRx }, { subject: searchRx }];
      }
      const mbFilter = { userId, accountId: account._id, direction: 'outbound' };
      if (searchRx) {
        mbFilter.$or = [
          { from: searchRx },
          { to: searchRx },
          { subject: searchRx },
          { snippet: searchRx }
        ];
      }
      const [sentTotal, mbTotal] = await Promise.all([
        EmailSent.countDocuments(sentFilter),
        MailboxMessage.countDocuments(mbFilter)
      ]);
      total = sentTotal + mbTotal;
      items = items.slice(skip, skip + limit);
    } else {
      total = items.length;
      items = items.slice(skip, skip + limit);
    }

    return res.json({
      account: {
        ...account.toSafeJSON(),
        allowed: isAllowedFlag(account),
        usable: isAllowedFlag(account),
        canSync: canFetchLifetimeForAccount(account)
      },
      folder,
      page,
      limit,
      total,
      messages: items
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list inbox messages' });
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
    for (const msg of batch.messages) {
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
  syncInboxAccount
};
