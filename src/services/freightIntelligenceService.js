const crypto = require('crypto');
const FreightContact = require('../models/FreightContact');
const FreightLoad = require('../models/FreightLoad');
const FreightLoadEvent = require('../models/FreightLoadEvent');
const MailboxMessage = require('../models/MailboxMessage');
const EmailAccount = require('../models/EmailAccount');
const {
  analyzeEmailText,
  assessFreightRelevance,
  normalizeEmail,
  domainOf,
  companyFromDomain,
  isNoiseDomain,
  STATUS_RULES
} = require('./freightRules');

const STATUS_RANK = {
  unknown: 0,
  open: 1,
  inquiry: 2,
  negotiating: 3,
  booked: 4,
  confirmed: 5,
  picked_up: 6,
  in_transit: 6,
  delivered: 7,
  lost: 8,
  cancelled: 8
};

function shouldAdvanceStatus(current, next) {
  if (!next || next === 'unknown') return false;
  if (!current || current === 'unknown') return true;
  if ((next === 'lost' || next === 'cancelled') && STATUS_RANK[current] < STATUS_RANK.booked) {
    return true;
  }
  if ((next === 'lost' || next === 'cancelled') && STATUS_RANK[current] >= STATUS_RANK.booked) {
    return next === 'cancelled' || current !== 'delivered';
  }
  return STATUS_RANK[next] >= STATUS_RANK[current];
}

function buildMatchKey({ loadNumber, pickup, delivery, brokerEmail, threadId }) {
  if (loadNumber) return `ln:${String(loadNumber).toUpperCase()}`;
  if (threadId) return `th:${threadId}`;
  const route = [
    (pickup?.city || '').toLowerCase(),
    (pickup?.state || '').toLowerCase(),
    (delivery?.city || '').toLowerCase(),
    (delivery?.state || '').toLowerCase(),
    (brokerEmail || '').toLowerCase()
  ].join('|');
  if (pickup?.city && delivery?.city) {
    return `rt:${crypto.createHash('sha1').update(route).digest('hex').slice(0, 16)}`;
  }
  return `orphan:${crypto.createHash('sha1').update(route + Date.now()).digest('hex').slice(0, 16)}`;
}

function isFreightRelated(message, opts) {
  return assessFreightRelevance(message, opts).freightRelated;
}

async function upsertContact({ email, partyHint, messageDate, contactName, phone, mc, dot }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) return null;
  if (
    isNoiseDomain(domainOf(normalized), { allowPersonalWebmail: true }) &&
    !['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'].includes(
      domainOf(normalized)
    )
  ) {
    return null;
  }

  const domain = domainOf(normalized);
  let contact = await FreightContact.findOne({ email: normalized });
  if (!contact) {
    contact = new FreightContact({
      email: normalized,
      domain,
      companyName: companyFromDomain(domain),
      partyType: partyHint?.partyType || 'unknown',
      confidence: partyHint?.confidence || 0.4,
      emailCount: 0,
      brokerSignals: 0,
      carrierSignals: 0
    });
  }

  contact.emailCount = (contact.emailCount || 0) + 1;
  contact.lastSeenAt = messageDate || new Date();
  if (!contact.domain) contact.domain = domain;
  if (!contact.companyName) contact.companyName = companyFromDomain(domain);
  if (contactName && !contact.contactName) contact.contactName = contactName;
  if (phone && !contact.phone) contact.phone = phone;

  if (mc || dot) {
    contact.meta = {
      ...(contact.meta || {}),
      mc: mc || contact.meta?.mc || '',
      dot: dot || contact.meta?.dot || ''
    };
  }

  if (partyHint) {
    contact.brokerSignals = (contact.brokerSignals || 0) + (partyHint.brokerSignals || 0);
    contact.carrierSignals = (contact.carrierSignals || 0) + (partyHint.carrierSignals || 0);

    if (!contact.partyTypeOverride) {
      if (contact.brokerSignals > contact.carrierSignals + 1) {
        contact.partyType = 'broker';
        contact.confidence = Math.min(0.99, 0.5 + contact.brokerSignals * 0.05);
      } else if (contact.carrierSignals > contact.brokerSignals + 1) {
        contact.partyType = 'carrier';
        contact.confidence = Math.min(0.99, 0.5 + contact.carrierSignals * 0.05);
      } else if (partyHint.partyType !== 'unknown') {
        if (
          contact.partyType === 'unknown' ||
          (partyHint.confidence || 0) > (contact.confidence || 0)
        ) {
          contact.partyType = partyHint.partyType;
          contact.confidence = partyHint.confidence || contact.confidence;
        }
      }
    }
  }

  await contact.save();
  return contact;
}

async function processMailboxMessage(messageDoc, { accountEmail = '', force = false } = {}) {
  const message =
    messageDoc && messageDoc.toObject ? messageDoc : await MailboxMessage.findById(messageDoc);
  if (!message) return { skipped: true, reason: 'not_found' };

  if (!force && message.intelligenceProcessedAt) {
    return { skipped: true, reason: 'already_processed', loadId: message.freightLoadId };
  }

  const analysis = analyzeEmailText(message, { ownEmail: accountEmail });
  if (!analysis.freightRelated) {
    message.intelligenceProcessedAt = new Date();
    message.partyType = 'unknown';
    message.extractedLoadNumber = '';
    message.freightLoadId = null;
    message.intelligence = {
      skipped: true,
      reason: 'not_freight',
      freightScore: analysis.freightScore,
      filterReasons: analysis.filterReasons
    };
    await message.save();
    return { skipped: true, reason: 'not_freight', freightScore: analysis.freightScore };
  }

  const {
    loadNumbers,
    rates,
    route,
    equipment,
    weight,
    miles,
    mc,
    dot,
    phones,
    contactName,
    statusHit,
    partyHint,
    extractionConfidence,
    freightScore
  } = analysis;

  const account = await EmailAccount.findById(message.accountId).select('email userId');
  const ownEmail = normalizeEmail(accountEmail || account?.email || '');
  const fromEmail = normalizeEmail(message.from);
  const toEmails = String(message.to || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

  const externalEmail =
    message.direction === 'outbound'
      ? toEmails.find((e) => e !== ownEmail) || toEmails[0] || ''
      : fromEmail !== ownEmail
        ? fromEmail
        : toEmails.find((e) => e !== ownEmail) || '';

  const contact = externalEmail
    ? await upsertContact({
        email: externalEmail,
        partyHint,
        messageDate: message.internalDate || message.createdAt,
        contactName,
        phone: phones[0] || '',
        mc,
        dot
      })
    : null;

  const effectiveType = contact?.partyTypeOverride || contact?.partyType || partyHint.partyType;
  const loadNumber = loadNumbers[0] || '';
  const matchKey = buildMatchKey({
    loadNumber,
    pickup: route.pickup,
    delivery: route.delivery,
    brokerEmail: effectiveType === 'broker' ? externalEmail : '',
    threadId: message.threadId || ''
  });

  let load = null;
  if (loadNumber) {
    load = await FreightLoad.findOne({ loadNumber }).sort({ updatedAt: -1 });
  }
  if (!load && message.threadId) {
    load = await FreightLoad.findOne({ threadIds: message.threadId }).sort({ updatedAt: -1 });
  }
  if (!load) {
    load = await FreightLoad.findOne({ matchKey });
  }
  if (!load) {
    const hasFreightSignal =
      loadNumber ||
      (route.pickup?.city && route.delivery?.city) ||
      statusHit.status !== 'unknown' ||
      (partyHint.brokerSignals || 0) > 0 ||
      (partyHint.carrierSignals || 0) > 0;
    if (!hasFreightSignal) {
      message.intelligenceProcessedAt = new Date();
      message.partyType = effectiveType || 'unknown';
      message.intelligence = {
        skipped: true,
        reason: 'no_freight_signal',
        freightScore,
        loadNumbers,
        rates
      };
      await message.save();
      return { skipped: true, reason: 'no_freight_signal' };
    }

    load = new FreightLoad({
      loadNumber,
      matchKey,
      status: statusHit.status !== 'unknown' ? statusHit.status : 'open',
      statusConfidence: statusHit.confidence || 0.5,
      pickup: route.pickup || {},
      delivery: route.delivery || {},
      equipment,
      weight,
      miles,
      rate: rates[0] || null,
      subjectSample: message.subject || '',
      firstEmailAt: message.internalDate || message.createdAt || new Date(),
      extractionConfidence: extractionConfidence || 0.45,
      meta: { mc, dot, freightScore }
    });
  }

  if (loadNumber && !load.loadNumber) load.loadNumber = loadNumber;
  if (route.pickup?.city && !load.pickup?.city) load.pickup = route.pickup;
  if (route.delivery?.city && !load.delivery?.city) load.delivery = route.delivery;
  if (equipment && !load.equipment) load.equipment = equipment;
  if (weight && !load.weight) load.weight = weight;
  if (miles && !load.miles) load.miles = miles;
  if (rates[0]) {
    // Prefer newer negotiated rate if within reason
    if (!load.rate || Math.abs(rates[0] - load.rate) / Math.max(load.rate, 1) < 0.6) {
      load.rate = rates[0];
    }
  }
  if (message.subject && !load.subjectSample) load.subjectSample = message.subject;
  if (extractionConfidence > (load.extractionConfidence || 0)) {
    load.extractionConfidence = extractionConfidence;
  }

  if (contact) {
    if (effectiveType === 'broker') {
      load.brokerContactId = contact._id;
      load.brokerEmail = contact.email;
      if (contact.companyName) load.brokerName = contact.companyName;
    } else if (effectiveType === 'carrier') {
      load.carrierContactId = contact._id;
      load.carrierEmail = contact.email;
      if (contact.companyName) load.carrierName = contact.companyName;
    } else if (!load.brokerEmail && (partyHint.brokerSignals || 0) >= (partyHint.carrierSignals || 0)) {
      load.brokerEmail = contact.email;
      load.brokerContactId = contact._id;
      load.brokerName = contact.companyName || load.brokerName;
    } else if (!load.carrierEmail) {
      load.carrierEmail = contact.email;
      load.carrierContactId = contact._id;
      load.carrierName = contact.companyName || load.carrierName;
    }
  }

  const userId = message.userId;
  if (userId && !load.employeeUserIds.some((id) => String(id) === String(userId))) {
    load.employeeUserIds.push(userId);
  }
  if (ownEmail && !load.employeeEmails.includes(ownEmail)) {
    load.employeeEmails.push(ownEmail);
  }
  if (message.accountId && !load.accountIds.some((id) => String(id) === String(message.accountId))) {
    load.accountIds.push(message.accountId);
  }
  if (message.threadId && !load.threadIds.includes(message.threadId)) {
    load.threadIds.push(message.threadId);
  }
  if (!load.mailboxMessageIds.some((id) => String(id) === String(message._id))) {
    load.mailboxMessageIds.push(message._id);
    load.emailCount = (load.emailCount || 0) + 1;
  }

  const occurredAt = message.internalDate || message.createdAt || new Date();
  if (!load.firstEmailAt || occurredAt < load.firstEmailAt) load.firstEmailAt = occurredAt;
  if (!load.lastEmailAt || occurredAt > load.lastEmailAt) load.lastEmailAt = occurredAt;

  const previousStatus = load.status;
  let statusChanged = false;
  if (statusHit.status !== 'unknown' && shouldAdvanceStatus(load.status, statusHit.status)) {
    if (load.status !== statusHit.status) {
      statusChanged = true;
      load.status = statusHit.status;
      load.statusConfidence = statusHit.confidence;
      load.lastEventAt = occurredAt;
    }
  } else if (load.status === 'unknown' || !load.status) {
    load.status = 'open';
  }

  await load.save();

  if (statusChanged || (statusHit.status !== 'unknown' && load.emailCount === 1)) {
    await FreightLoadEvent.create({
      loadId: load._id,
      status: load.status,
      previousStatus: statusChanged ? previousStatus : null,
      source: 'rule',
      messageId: message._id,
      employeeUserId: userId || null,
      title: statusHit.title || `Email linked (${load.status})`,
      note: (message.subject || '').slice(0, 300),
      confidence: statusHit.confidence || 0.5,
      signals: statusHit.signals || [],
      occurredAt,
      meta: { freightScore, extractionConfidence }
    });
  } else {
    await FreightLoadEvent.create({
      loadId: load._id,
      status: load.status,
      previousStatus: null,
      source: 'email',
      messageId: message._id,
      employeeUserId: userId || null,
      title: message.direction === 'outbound' ? 'Outbound email' : 'Inbound email',
      note: (message.subject || '').slice(0, 300),
      confidence: 0.4,
      signals: [],
      occurredAt
    });
  }

  message.intelligenceProcessedAt = new Date();
  message.partyType = effectiveType || 'unknown';
  message.extractedLoadNumber = loadNumber || '';
  message.freightLoadId = load._id;
  message.intelligence = {
    freightScore,
    extractionConfidence,
    filterReasons: analysis.filterReasons,
    loadNumbers,
    rates,
    route,
    equipment,
    weight,
    miles,
    mc,
    dot,
    phones,
    contactName,
    status: statusHit,
    party: partyHint,
    contactId: contact ? String(contact._id) : null,
    loadId: String(load._id)
  };
  await message.save();

  return {
    skipped: false,
    loadId: String(load._id),
    status: load.status,
    partyType: effectiveType,
    loadNumber,
    freightScore
  };
}

async function processUnprocessedMessages({
  limit = 100,
  accountId = null,
  userId = null,
  force = false
} = {}) {
  const filter = {};
  if (!force) filter.intelligenceProcessedAt = { $in: [null, undefined] };
  if (accountId) filter.accountId = accountId;
  if (userId) filter.userId = userId;

  const rows = await MailboxMessage.find(filter)
    .sort({ internalDate: -1, createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));

  const accountCache = new Map();
  let processed = 0;
  let skipped = 0;
  let skippedNoise = 0;
  let errors = 0;
  const loadIds = new Set();

  for (const row of rows) {
    try {
      let accountEmail = '';
      if (row.accountId) {
        const key = String(row.accountId);
        if (!accountCache.has(key)) {
          const acc = await EmailAccount.findById(row.accountId).select('email');
          accountCache.set(key, acc?.email || '');
        }
        accountEmail = accountCache.get(key);
      }
      const result = await processMailboxMessage(row, { accountEmail, force });
      if (result.skipped) {
        skipped += 1;
        if (result.reason === 'not_freight') skippedNoise += 1;
      } else {
        processed += 1;
        if (result.loadId) loadIds.add(result.loadId);
      }
    } catch (err) {
      errors += 1;
      console.warn('[freight-intel] process failed', row._id, err?.message || err);
    }
  }

  return {
    scanned: rows.length,
    processed,
    skipped,
    skippedNoise,
    errors,
    loadsTouched: loadIds.size
  };
}

module.exports = {
  processMailboxMessage,
  processUnprocessedMessages,
  analyzeEmailText,
  isFreightRelated,
  assessFreightRelevance,
  STATUS_RANK,
  STATUS_RULES
};
