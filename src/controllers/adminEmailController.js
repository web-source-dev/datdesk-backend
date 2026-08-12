const mongoose = require('mongoose');
const User = require('../models/User');
const EmailAccount = require('../models/EmailAccount');
const EmailSent = require('../models/EmailSent');
const EmailTemplate = require('../models/EmailTemplate');
const MailboxMessage = require('../models/MailboxMessage');
const ActivityLog = require('../models/ActivityLog');
const { logActivity } = require('../services/activityLogService');
const { fetchGmailMessagesBatch } = require('../services/mailService');

function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function isObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ''));
}

async function getUserOr404(userId, res) {
  if (!isObjectId(userId)) {
    res.status(400).json({ message: 'Invalid user id' });
    return null;
  }
  const user = await User.findById(userId).select('-password');
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  return user;
}

/** GET /admin/users/:userId — basic profile + email stats */
async function getUserDetail(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;

    const [accountCount, sentCount, templateCount, mailboxCount, recentActivity] = await Promise.all([
      EmailAccount.countDocuments({ userId: user._id }),
      EmailSent.countDocuments({ userId: user._id }),
      EmailTemplate.countDocuments({ userId: user._id }),
      MailboxMessage.countDocuments({ userId: user._id }),
      ActivityLog.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10)
    ]);

    return res.json({
      user: {
        _id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        isBanned: user.isBanned,
        plan: user.plan,
        label: user.label,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      stats: {
        connectedAccounts: accountCount,
        sentEmails: sentCount,
        templates: templateCount,
        mailboxMessages: mailboxCount
      },
      recentActivity: recentActivity.map((a) => a.toSafeJSON())
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load user' });
  }
}

/** GET /admin/users/:userId/email-accounts */
async function listUserEmailAccounts(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;

    const accounts = await EmailAccount.find({ userId: user._id }).sort({
      isDefault: -1,
      connectedAt: -1
    });

    const counts = await EmailSent.aggregate([
      { $match: { userId: user._id } },
      { $group: { _id: '$accountId', count: { $sum: 1 } } }
    ]);
    const mailboxCounts = await MailboxMessage.aggregate([
      { $match: { userId: user._id } },
      { $group: { _id: '$accountId', count: { $sum: 1 } } }
    ]);
    const sentByAccount = Object.fromEntries(
      counts.map((c) => [String(c._id || ''), c.count])
    );
    const mailboxByAccount = Object.fromEntries(
      mailboxCounts.map((c) => [String(c._id || ''), c.count])
    );

    return res.json({
      accounts: accounts.map((a) => ({
        ...a.toSafeJSON(),
        sentCount: sentByAccount[String(a._id)] || 0,
        mailboxCount: mailboxByAccount[String(a._id)] || 0,
        canFetchLifetime: a.method === 'oauth'
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list accounts' });
  }
}

/** GET /admin/users/:userId/email-accounts/:accountId/sent */
async function listAccountSentEmails(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;
    if (!isObjectId(req.params.accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }

    const account = await EmailAccount.findOne({
      _id: req.params.accountId,
      userId: user._id
    });
    if (!account) return res.status(404).json({ message: 'Email account not found' });

    const { page, limit, skip } = parsePaging(req.query);
    const search = String(req.query.search || '').trim();
    const filter = { userId: user._id, accountId: account._id };
    if (search) {
      filter.$or = [
        { to: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { subject: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { from: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }

    const [total, rows] = await Promise.all([
      EmailSent.countDocuments(filter),
      EmailSent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
    ]);

    return res.json({
      account: account.toSafeJSON(),
      page,
      limit,
      total,
      emails: rows.map((r) => r.toSafeJSON())
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list sent emails' });
  }
}

/** GET /admin/users/:userId/sent — all sent by user */
async function listUserSentEmails(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;

    const { page, limit, skip } = parsePaging(req.query);
    const search = String(req.query.search || '').trim();
    const filter = { userId: user._id };
    if (req.query.accountId && isObjectId(req.query.accountId)) {
      filter.accountId = req.query.accountId;
    }
    if (search) {
      filter.$or = [
        { to: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { subject: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { from: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }

    const [total, rows] = await Promise.all([
      EmailSent.countDocuments(filter),
      EmailSent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
    ]);

    return res.json({
      page,
      limit,
      total,
      emails: rows.map((r) => r.toSafeJSON())
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list sent emails' });
  }
}

/** GET /admin/email/sent/:id */
async function getSentEmail(req, res) {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const row = await EmailSent.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Sent email not found' });
    return res.json({ email: row.toSafeJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load email' });
  }
}

/** GET /admin/email/sent — global sent search */
async function listAllSentEmails(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const search = String(req.query.search || '').trim();
    const filter = {};
    if (req.query.userId && isObjectId(req.query.userId)) filter.userId = req.query.userId;
    if (req.query.accountId && isObjectId(req.query.accountId)) {
      filter.accountId = req.query.accountId;
    }
    if (search) {
      filter.$or = [
        { to: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { subject: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { from: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }

    const [total, rows] = await Promise.all([
      EmailSent.countDocuments(filter),
      EmailSent.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'name email')
    ]);

    return res.json({
      page,
      limit,
      total,
      emails: rows.map((r) => ({
        ...r.toSafeJSON(),
        user: r.userId
          ? {
              _id: String(r.userId._id || r.userId),
              name: r.userId.name,
              email: r.userId.email
            }
          : null
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list emails' });
  }
}

/** GET /admin/users/:userId/email-accounts/:accountId/mailbox */
async function listMailboxMessages(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;
    if (!isObjectId(req.params.accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }

    const account = await EmailAccount.findOne({
      _id: req.params.accountId,
      userId: user._id
    });
    if (!account) return res.status(404).json({ message: 'Email account not found' });

    const { page, limit, skip } = parsePaging(req.query);
    const search = String(req.query.search || '').trim();
    const direction = String(req.query.direction || '').trim();
    const filter = { userId: user._id, accountId: account._id };
    if (direction === 'inbound' || direction === 'outbound') filter.direction = direction;
    if (search) {
      filter.$or = [
        { to: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { from: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { subject: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { snippet: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }

    const [total, rows] = await Promise.all([
      MailboxMessage.countDocuments(filter),
      MailboxMessage.find(filter).sort({ internalDate: -1, createdAt: -1 }).skip(skip).limit(limit)
    ]);

    return res.json({
      account: {
        ...account.toSafeJSON(),
        canFetchLifetime: account.method === 'oauth'
      },
      page,
      limit,
      total,
      messages: rows.map((r) => r.toSafeJSON(false))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list mailbox' });
  }
}

/** GET /admin/mailbox/:id */
async function getMailboxMessage(req, res) {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const row = await MailboxMessage.findById(req.params.id);
    if (!row) return res.status(404).json({ message: 'Message not found' });
    return res.json({ message: row.toSafeJSON(true) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load message' });
  }
}

/**
 * POST /admin/users/:userId/email-accounts/:accountId/fetch-lifetime
 * Pulls Gmail history into MailboxMessage (batched; pass pageToken to continue).
 */
async function fetchLifetimeEmails(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;
    if (!isObjectId(req.params.accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }

    const account = await EmailAccount.findOne({
      _id: req.params.accountId,
      userId: user._id
    }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');
    if (!account) return res.status(404).json({ message: 'Email account not found' });

    if (account.method !== 'oauth') {
      return res.status(400).json({
        message:
          'Lifetime fetch requires Google OAuth. Ask the user to reconnect this inbox with “Connect with Google”.',
        code: 'OAUTH_REQUIRED'
      });
    }

    const maxMessages = Math.min(500, Math.max(1, Number(req.body?.maxMessages) || 100));
    const pageToken = String(req.body?.pageToken || '');
    const q = String(req.body?.q || '').trim();

    const batch = await fetchGmailMessagesBatch(account, { maxMessages, pageToken, q });

    let upserted = 0;
    for (const msg of batch.messages) {
      await MailboxMessage.findOneAndUpdate(
        { accountId: account._id, providerMessageId: msg.providerMessageId },
        {
          $set: {
            userId: user._id,
            accountId: account._id,
            provider: 'gmail',
            ...msg,
            syncedAt: new Date()
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      upserted += 1;
    }

    await logActivity({
      userId: user._id,
      actorEmail: req.user?.email || '',
      action: 'email.lifetime_fetch',
      category: 'admin',
      status: 'success',
      message: `Fetched ${upserted} mailbox messages for ${account.email}`,
      meta: {
        accountId: String(account._id),
        accountEmail: account.email,
        upserted,
        nextPageToken: batch.nextPageToken || '',
        resultSizeEstimate: batch.resultSizeEstimate
      },
      req
    });

    const totalStored = await MailboxMessage.countDocuments({ accountId: account._id });

    return res.json({
      message: `Synced ${upserted} messages`,
      upserted,
      fetched: batch.fetched,
      nextPageToken: batch.nextPageToken || '',
      resultSizeEstimate: batch.resultSizeEstimate || 0,
      totalStored,
      hasMore: Boolean(batch.nextPageToken)
    });
  } catch (error) {
    await logActivity({
      userId: req.params.userId,
      actorEmail: req.user?.email || '',
      action: 'email.lifetime_fetch',
      category: 'admin',
      status: 'failure',
      message: error.message || 'Lifetime fetch failed',
      meta: { accountId: req.params.accountId },
      req
    });
    return res.status(500).json({
      message: error.message || 'Failed to fetch lifetime emails',
      code: error.code || 'FETCH_FAILED'
    });
  }
}

/** GET /admin/activity */
async function listActivity(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query, { defaultLimit: 50, maxLimit: 200 });
    const filter = {};
    if (req.query.userId && isObjectId(req.query.userId)) filter.userId = req.query.userId;
    if (req.query.action) filter.action = String(req.query.action).trim();
    if (req.query.category) filter.category = String(req.query.category).trim();
    if (req.query.status) filter.status = String(req.query.status).trim();
    const search = String(req.query.search || '').trim();
    if (search) {
      filter.$or = [
        { actorEmail: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { message: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { action: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ];
    }

    const [total, rows] = await Promise.all([
      ActivityLog.countDocuments(filter),
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'name email')
    ]);

    return res.json({
      page,
      limit,
      total,
      logs: rows.map((r) => ({
        ...r.toSafeJSON(),
        user: r.userId
          ? {
              _id: String(r.userId._id || r.userId),
              name: r.userId.name,
              email: r.userId.email
            }
          : null
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list activity' });
  }
}

/** GET /admin/users/:userId/activity */
async function listUserActivity(req, res) {
  req.query.userId = req.params.userId;
  return listActivity(req, res);
}

/** GET /admin/email/accounts — all connected accounts across users */
async function listAllEmailAccounts(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const search = String(req.query.search || '').trim();
    const filter = {};
    if (search) {
      filter.email = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    if (req.query.userId && isObjectId(req.query.userId)) filter.userId = req.query.userId;

    const [total, rows] = await Promise.all([
      EmailAccount.countDocuments(filter),
      EmailAccount.find(filter)
        .sort({ connectedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'name email')
    ]);

    return res.json({
      page,
      limit,
      total,
      accounts: rows.map((a) => ({
        ...a.toSafeJSON(),
        canFetchLifetime: a.method === 'oauth',
        user: a.userId
          ? {
              _id: String(a.userId._id || a.userId),
              name: a.userId.name,
              email: a.userId.email
            }
          : null
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list accounts' });
  }
}

module.exports = {
  getUserDetail,
  listUserEmailAccounts,
  listAccountSentEmails,
  listUserSentEmails,
  getSentEmail,
  listAllSentEmails,
  listMailboxMessages,
  getMailboxMessage,
  fetchLifetimeEmails,
  listActivity,
  listUserActivity,
  listAllEmailAccounts
};
