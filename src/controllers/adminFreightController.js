const mongoose = require('mongoose');
const FreightLoad = require('../models/FreightLoad');
const FreightLoadEvent = require('../models/FreightLoadEvent');
const FreightContact = require('../models/FreightContact');
const MailboxMessage = require('../models/MailboxMessage');
const User = require('../models/User');
const { processUnprocessedMessages } = require('../services/freightIntelligenceService');
const {
  getMailboxSyncStatus,
  runMailboxSyncTick,
  syncOneAccount
} = require('../services/mailboxSyncService');
const EmailAccount = require('../models/EmailAccount');
const EmailSyncState = require('../models/EmailSyncState');
const { logActivity } = require('../services/activityLogService');

function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function isObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ''));
}

/** GET /admin/freight/overview */
async function getOverview(req, res) {
  try {
    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const [
      statusCounts,
      partyCounts,
      emailsToday,
      loadsToday,
      openCount,
      bookedCount,
      unprocessed,
      noiseFiltered,
      freightLinkedEmails
    ] = await Promise.all([
      FreightLoad.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      FreightContact.aggregate([
        {
          $group: {
            _id: { $ifNull: ['$partyTypeOverride', '$partyType'] },
            count: { $sum: 1 }
          }
        }
      ]),
      MailboxMessage.countDocuments({
        $or: [{ internalDate: { $gte: since } }, { createdAt: { $gte: since } }]
      }),
      FreightLoad.countDocuments({ createdAt: { $gte: since } }),
      FreightLoad.countDocuments({ status: { $in: ['open', 'inquiry', 'negotiating'] } }),
      FreightLoad.countDocuments({ status: { $in: ['booked', 'confirmed'] } }),
      MailboxMessage.countDocuments({ intelligenceProcessedAt: null }),
      MailboxMessage.countDocuments({ 'intelligence.reason': 'not_freight' }),
      MailboxMessage.countDocuments({ freightLoadId: { $ne: null } })
    ]);

    const byStatus = Object.fromEntries(statusCounts.map((s) => [s._id || 'unknown', s.count]));
    const byParty = Object.fromEntries(partyCounts.map((s) => [s._id || 'unknown', s.count]));

    return res.json({
      emailsToday,
      loadsToday,
      openCount,
      bookedCount,
      unprocessedEmails: unprocessed,
      noiseFiltered,
      freightLinkedEmails,
      byStatus,
      byParty,
      totalLoads: Object.values(byStatus).reduce((a, b) => a + b, 0),
      totalContacts: Object.values(byParty).reduce((a, b) => a + b, 0)
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load overview' });
  }
}

/** GET /admin/freight/loads */
async function listLoads(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const filter = {};
    if (req.query.status) {
      const statuses = String(req.query.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) filter.status = statuses[0];
      else if (statuses.length > 1) filter.status = { $in: statuses };
    }
    if (req.query.employeeUserId && isObjectId(req.query.employeeUserId)) {
      filter.employeeUserIds = req.query.employeeUserId;
    }
    if (req.query.party === 'broker' && req.query.email) {
      filter.brokerEmail = String(req.query.email).toLowerCase();
    }
    if (req.query.party === 'carrier' && req.query.email) {
      filter.carrierEmail = String(req.query.email).toLowerCase();
    }
    const search = String(req.query.search || '').trim();
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { loadNumber: re },
        { brokerName: re },
        { carrierName: re },
        { brokerEmail: re },
        { carrierEmail: re },
        { subjectSample: re },
        { 'pickup.city': re },
        { 'delivery.city': re }
      ];
    }

    const [total, rows] = await Promise.all([
      FreightLoad.countDocuments(filter),
      FreightLoad.find(filter)
        .sort({ lastEmailAt: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('employeeUserIds', 'name email')
        .populate('brokerContactId', 'email companyName partyType partyTypeOverride confidence')
        .populate('carrierContactId', 'email companyName partyType partyTypeOverride confidence')
    ]);

    return res.json({
      page,
      limit,
      total,
      loads: rows.map((l) => ({
        ...l.toSafeJSON(),
        employees: (l.employeeUserIds || []).map((u) =>
          u && u._id
            ? { _id: String(u._id), name: u.name, email: u.email }
            : { _id: String(u) }
        ),
        brokerContact: l.brokerContactId?.toSafeJSON
          ? l.brokerContactId.toSafeJSON()
          : null,
        carrierContact: l.carrierContactId?.toSafeJSON
          ? l.carrierContactId.toSafeJSON()
          : null
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list loads' });
  }
}

/** GET /admin/freight/loads/:id */
async function getLoad(req, res) {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const load = await FreightLoad.findById(req.params.id)
      .populate('employeeUserIds', 'name email')
      .populate('brokerContactId')
      .populate('carrierContactId');
    if (!load) return res.status(404).json({ message: 'Load not found' });

    const [events, messages] = await Promise.all([
      FreightLoadEvent.find({ loadId: load._id }).sort({ occurredAt: -1 }).limit(100),
      MailboxMessage.find({ freightLoadId: load._id })
        .sort({ internalDate: -1 })
        .limit(50)
        .select(
          'from to subject snippet direction internalDate partyType extractedLoadNumber accountId userId'
        )
    ]);

    return res.json({
      load: {
        ...load.toSafeJSON(),
        employees: (load.employeeUserIds || []).map((u) =>
          u && u._id ? { _id: String(u._id), name: u.name, email: u.email } : null
        ),
        brokerContact: load.brokerContactId?.toSafeJSON ? load.brokerContactId.toSafeJSON() : null,
        carrierContact: load.carrierContactId?.toSafeJSON
          ? load.carrierContactId.toSafeJSON()
          : null
      },
      events: events.map((e) => e.toSafeJSON()),
      messages: messages.map((m) => m.toSafeJSON(false))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load detail' });
  }
}

/** PATCH /admin/freight/loads/:id — manual status / notes */
async function updateLoad(req, res) {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const load = await FreightLoad.findById(req.params.id);
    if (!load) return res.status(404).json({ message: 'Load not found' });

    const prev = load.status;
    if (req.body?.status) {
      load.status = String(req.body.status);
      load.statusConfidence = 1;
      load.lastEventAt = new Date();
    }
    if (req.body?.rate != null && req.body.rate !== '') load.rate = Number(req.body.rate);
    if (req.body?.brokerName != null) load.brokerName = String(req.body.brokerName).trim();
    if (req.body?.carrierName != null) load.carrierName = String(req.body.carrierName).trim();
    if (req.body?.loadNumber != null) load.loadNumber = String(req.body.loadNumber).trim();

    await load.save();

    if (req.body?.status && req.body.status !== prev) {
      await FreightLoadEvent.create({
        loadId: load._id,
        status: load.status,
        previousStatus: prev,
        source: 'manual',
        title: `Manual status → ${load.status}`,
        note: String(req.body?.note || '').slice(0, 500),
        confidence: 1,
        occurredAt: new Date(),
        employeeUserId: req.user?.userId || null
      });
    }

    return res.json({ load: load.toSafeJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to update load' });
  }
}

/** GET /admin/freight/contacts */
async function listContacts(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const filter = {};
    if (req.query.partyType) {
      filter.$or = [
        { partyTypeOverride: req.query.partyType },
        { partyTypeOverride: null, partyType: req.query.partyType }
      ];
    }
    const search = String(req.query.search || '').trim();
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ email: re }, { companyName: re }, { contactName: re }, { domain: re }] }
      ];
    }

    const [total, rows] = await Promise.all([
      FreightContact.countDocuments(filter),
      FreightContact.find(filter).sort({ lastSeenAt: -1, emailCount: -1 }).skip(skip).limit(limit)
    ]);

    return res.json({
      page,
      limit,
      total,
      contacts: rows.map((c) => c.toSafeJSON())
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list contacts' });
  }
}

/** PATCH /admin/freight/contacts/:id — correct broker/carrier */
async function updateContact(req, res) {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const contact = await FreightContact.findById(req.params.id);
    if (!contact) return res.status(404).json({ message: 'Contact not found' });

    if (req.body?.partyTypeOverride !== undefined) {
      const v = req.body.partyTypeOverride;
      if (v === '' || v == null) {
        contact.partyTypeOverride = undefined;
        contact.set('partyTypeOverride', undefined);
      } else {
        contact.partyTypeOverride = String(v);
        contact.confidence = 1;
      }
    }
    if (req.body?.companyName != null) contact.companyName = String(req.body.companyName).trim();
    if (req.body?.contactName != null) contact.contactName = String(req.body.contactName).trim();
    if (req.body?.phone != null) contact.phone = String(req.body.phone).trim();
    if (req.body?.notes != null) contact.notes = String(req.body.notes).trim();

    await contact.save();
    return res.json({ contact: contact.toSafeJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to update contact' });
  }
}

/** POST /admin/freight/process — run intelligence on unprocessed emails */
async function processEmails(req, res) {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.body?.limit) || 100));
    const accountId = req.body?.accountId || null;
    const userId = req.body?.userId || null;
    const force = Boolean(req.body?.force);

    const result = await processUnprocessedMessages({ limit, accountId, userId, force });

    await logActivity({
      userId: req.user?.userId,
      actorEmail: req.user?.email || '',
      action: force ? 'freight.reclassify_emails' : 'freight.process_emails',
      category: 'admin',
      status: 'success',
      message: `${force ? 'Reclassified' : 'Processed'} ${result.processed} emails (${result.skippedNoise || 0} noise) → ${result.loadsTouched} loads`,
      meta: result,
      req
    });

    return res.json({ message: force ? 'Reclassification complete' : 'Processing complete', ...result });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Processing failed' });
  }
}

/** GET /admin/freight/employees — users who have loads */
async function listFreightEmployees(req, res) {
  try {
    const ids = await FreightLoad.distinct('employeeUserIds');
    const users = await User.find({ _id: { $in: ids } }).select('name email role');
    return res.json({
      employees: users.map((u) => ({
        _id: String(u._id),
        name: u.name,
        email: u.email,
        role: u.role
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list employees' });
  }
}

/** GET /admin/freight/sync/status */
async function getSyncStatus(req, res) {
  try {
    const status = getMailboxSyncStatus();
    const states = await EmailSyncState.find({})
      .sort({ lastSyncAt: -1 })
      .limit(100)
      .populate('accountId', 'email method')
      .populate('userId', 'name email');
    return res.json({
      ...status,
      accounts: states.map((s) => ({
        ...s.toSafeJSON(),
        accountEmail: s.accountId?.email || '',
        method: s.accountId?.method || '',
        user: s.userId
          ? { _id: String(s.userId._id || s.userId), name: s.userId.name, email: s.userId.email }
          : null
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load sync status' });
  }
}

/** POST /admin/freight/sync/run — trigger one sync tick now */
async function runSyncNow(req, res) {
  try {
    const accountId = req.body?.accountId;
    if (accountId) {
      if (!isObjectId(accountId)) return res.status(400).json({ message: 'Invalid account id' });
      const account = await EmailAccount.findById(accountId).select(
        '+appPasswordEnc +refreshTokenEnc +accessTokenEnc'
      );
      if (!account) return res.status(404).json({ message: 'Account not found' });
      const result = await syncOneAccount(account, {
        maxMessages: Math.min(200, Number(req.body?.maxMessages) || 50)
      });
      await logActivity({
        userId: req.user?.userId,
        actorEmail: req.user?.email || '',
        action: 'email.mailbox_sync_one',
        category: 'admin',
        status: result.error ? 'failure' : 'success',
        message: `Manual sync ${account.email}`,
        meta: result,
        req
      });
      return res.json({ message: 'Account sync finished', result });
    }

    const result = await runMailboxSyncTick({ triggeredBy: 'admin' });
    return res.json({ message: 'Sync tick finished', result });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Sync failed' });
  }
}

/** PATCH /admin/freight/sync/accounts/:accountId — enable/disable continuous sync */
async function updateSyncAccount(req, res) {
  try {
    if (!isObjectId(req.params.accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }
    const account = await EmailAccount.findById(req.params.accountId);
    if (!account) return res.status(404).json({ message: 'Account not found' });

    let state = await EmailSyncState.findOne({ accountId: account._id });
    if (!state) {
      state = await EmailSyncState.create({
        accountId: account._id,
        userId: account.userId,
        enabled: true
      });
    }
    if (req.body?.enabled != null) state.enabled = Boolean(req.body.enabled);
    if (req.body?.resetErrors) {
      state.consecutiveFailures = 0;
      state.lastError = '';
      state.lastErrorAt = null;
    }
    await state.save();
    return res.json({ state: state.toSafeJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to update sync state' });
  }
}

module.exports = {
  getOverview,
  listLoads,
  getLoad,
  updateLoad,
  listContacts,
  updateContact,
  processEmails,
  listFreightEmployees,
  getSyncStatus,
  runSyncNow,
  updateSyncAccount
};
