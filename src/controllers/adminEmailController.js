const mongoose = require('mongoose');
const User = require('../models/User');
const EmailAccount = require('../models/EmailAccount');
const EmailSent = require('../models/EmailSent');
const EmailTemplate = require('../models/EmailTemplate');
const MailboxMessage = require('../models/MailboxMessage');
const ActivityLog = require('../models/ActivityLog');
const { logActivity } = require('../services/activityLogService');
const EmailSyncState = require('../models/EmailSyncState');
const { fetchMailboxMessagesBatch, canFetchLifetimeForAccount } = require('../services/mailService');
const { processUnprocessedMessages } = require('../services/freightIntelligenceService');
const { normalizePermissions } = require('../utils/permissions');
const {
  syncAllowedAccounts,
  setAccountAllowed,
  ensureDefaultAmongAllowed,
  getMaxEmailAccounts,
  isAllowedFlag,
  listUserAccounts
} = require('../services/emailLimits');

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
        permissions: normalizePermissions(user.permissions),
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

    const accounts = await syncAllowedAccounts(user._id, user.permissions);

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
      maxEmailAccounts: getMaxEmailAccounts(user.permissions),
      accounts: accounts.map((a) => ({
        ...a.toSafeJSON(),
        allowed: isAllowedFlag(a),
        usable: isAllowedFlag(a),
        sentCount: sentByAccount[String(a._id)] || 0,
        mailboxCount: mailboxByAccount[String(a._id)] || 0,
        canFetchLifetime: canFetchLifetimeForAccount(a)
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list accounts' });
  }
}

/** PATCH /admin/users/:userId/email-accounts/:accountId */
async function updateUserEmailAccount(req, res) {
  try {
    const user = await getUserOr404(req.params.userId, res);
    if (!user) return undefined;
    if (!isObjectId(req.params.accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }

    const hasAllowed = typeof req.body?.allowed === 'boolean';
    const hasDefault = req.body?.isDefault === true;
    if (!hasAllowed && !hasDefault) {
      return res.status(400).json({ message: 'Provide allowed or isDefault' });
    }

    if (hasAllowed) {
      await setAccountAllowed(user._id, req.params.accountId, req.body.allowed, user.permissions);
    }

    if (hasDefault) {
      const accounts = await EmailAccount.find({ userId: user._id });
      const match = accounts.find((a) => String(a._id) === String(req.params.accountId));
      if (!match) return res.status(404).json({ message: 'Email account not found' });
      if (match.allowed === false && req.body?.allowed !== true) {
        return res.status(403).json({
          message: 'Enable this email before making it the default.',
          code: 'EMAIL_ACCOUNT_UNUSABLE'
        });
      }
      await ensureDefaultAmongAllowed(user._id, match._id);
    }

    const remaining = await listUserAccounts(user._id);

    await logActivity({
      userId: user._id,
      actorEmail: req.user?.email || '',
      action: hasAllowed
        ? req.body.allowed
          ? 'email.admin_enable'
          : 'email.admin_disable'
        : 'email.admin_default',
      category: 'admin',
      status: 'success',
      message: hasAllowed
        ? `${req.body.allowed ? 'Enabled' : 'Disabled'} ${
            remaining.find((a) => String(a._id) === String(req.params.accountId))?.email || 'email'
          } for ${user.email}`
        : `Set default email for ${user.email}`,
      meta: {
        accountId: String(req.params.accountId),
        allowed: hasAllowed ? Boolean(req.body.allowed) : undefined,
        isDefault: hasDefault || undefined
      },
      req
    });

    return res.json({
      message: hasAllowed
        ? req.body.allowed
          ? 'Email enabled for sending'
          : 'Email disabled for sending'
        : 'Default email updated',
      accounts: remaining.map((a) => ({
        ...a.toSafeJSON(),
        allowed: isAllowedFlag(a),
        usable: isAllowedFlag(a)
      }))
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to update email account',
      code: error.code
    });
  }
}

/** DELETE /admin/users/:userId/email-accounts/:accountId */
async function deleteUserEmailAccount(req, res) {
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

    await EmailAccount.deleteOne({ _id: account._id, userId: user._id });
    await EmailSyncState.deleteMany({ accountId: account._id });
    await ensureDefaultAmongAllowed(user._id);

    const remaining = await listUserAccounts(user._id);

    await logActivity({
      userId: user._id,
      actorEmail: req.user?.email || '',
      action: 'email.admin_remove',
      category: 'admin',
      status: 'success',
      message: `Removed ${account.email} from ${user.email}`,
      meta: {
        accountId: String(account._id),
        accountEmail: account.email,
        method: account.method
      },
      req
    });

    return res.json({
      message: `Removed ${account.email}`,
      accounts: remaining.map((a) => ({
        ...a.toSafeJSON(),
        allowed: isAllowedFlag(a),
        usable: isAllowedFlag(a)
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to remove email account' });
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
      account: {
        ...account.toSafeJSON(),
        canFetchLifetime: canFetchLifetimeForAccount(account)
      },
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
        canFetchLifetime: canFetchLifetimeForAccount(account)
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
 * Pulls mailbox history into MailboxMessage (Gmail API for OAuth, IMAP for app password/SMTP).
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

    if (!canFetchLifetimeForAccount(account)) {
      return res.status(400).json({
        message: `Lifetime fetch is not supported for method "${account.method}"`,
        code: 'UNSUPPORTED_METHOD'
      });
    }

    const maxMessages = Math.min(500, Math.max(1, Number(req.body?.maxMessages) || 100));
    const pageToken = String(req.body?.pageToken || '');
    const q = String(req.body?.q || '').trim();

    const batch = await fetchMailboxMessagesBatch(account, { maxMessages, pageToken, q });
    const provider = batch.provider || (account.method === 'oauth' ? 'gmail' : 'imap');

    let upserted = 0;
    for (const msg of batch.messages) {
      await MailboxMessage.findOneAndUpdate(
        { accountId: account._id, providerMessageId: msg.providerMessageId },
        {
          $set: {
            userId: user._id,
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

    // Auto-run freight intelligence on newly synced (unprocessed) messages for this account
    let intel = null;
    try {
      intel = await processUnprocessedMessages({
        limit: Math.min(upserted || maxMessages, 200),
        accountId: account._id
      });
    } catch (intelErr) {
      console.warn('[freight-intel] post-sync process failed:', intelErr?.message || intelErr);
    }

    await logActivity({
      userId: user._id,
      actorEmail: req.user?.email || '',
      action: 'email.lifetime_fetch',
      category: 'admin',
      status: 'success',
      message: `Fetched ${upserted} mailbox messages for ${account.email} via ${provider}`,
      meta: {
        accountId: String(account._id),
        accountEmail: account.email,
        method: account.method,
        provider,
        upserted,
        nextPageToken: batch.nextPageToken || '',
        resultSizeEstimate: batch.resultSizeEstimate,
        imapHost: batch.imapHost || null,
        intelligence: intel
      },
      req
    });

    const totalStored = await MailboxMessage.countDocuments({ accountId: account._id });

    return res.json({
      message: `Synced ${upserted} messages via ${provider}`,
      upserted,
      fetched: batch.fetched,
      nextPageToken: batch.nextPageToken || '',
      resultSizeEstimate: batch.resultSizeEstimate || 0,
      totalStored,
      hasMore: Boolean(batch.nextPageToken),
      provider,
      intelligence: intel
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
        canFetchLifetime: canFetchLifetimeForAccount(a),
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
  updateUserEmailAccount,
  deleteUserEmailAccount,
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
