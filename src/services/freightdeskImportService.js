'use strict';

/**
 * Import FreightDesk container sessions as Cookie documents.
 * Payload is stored in MongoDB `data` (no uploads folder).
 */

const Cookie = require('../models/Cookie');
const freightdeskApiService = require('./freightdeskApiService');
const {
  getActiveFieldForChannel,
  normalizeCookieChannel,
  isValidCookieChannel,
  CHANNEL_LABELS,
  CHANNEL_ACTIVE_FIELD
} = require('../utils/cookieChannels');
const {
  normalizeCookiePayload,
  countCookiesInData
} = require('../utils/cookies');

const FD_CONTAINER_PREFIX = 'fd-container-';
const IMPORT_DELAY_MS = parseInt(process.env.FREIGHTDESK_IMPORT_DELAY_MS, 10) || 750;

const ASSIGNABLE_LABELS = new Set([
  'new',
  'single',
  'double',
  'multi_without_auto',
  'multi_with_auto',
  'multi',
  'test'
]);

const COOKIE_ACTIVATION_FIELDS = Object.values(CHANNEL_ACTIVE_FIELD);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containerFileName(container) {
  return `${FD_CONTAINER_PREFIX}${String(container).toUpperCase()}.json`;
}

function isFdContainerFileName(fileName) {
  return String(fileName || '').startsWith(FD_CONTAINER_PREFIX);
}

function parseContainerFromFileName(fileName) {
  const match = String(fileName || '').match(/^fd-container-([A-Z0-9]+)\.json$/i);
  return match ? match[1].toUpperCase() : null;
}

function findImportedCookie(container) {
  return Cookie.findOne({ fileName: containerFileName(container) });
}

function collectActivationFlags(cookie) {
  const flags = {};
  if (!cookie) return flags;
  for (const field of COOKIE_ACTIVATION_FIELDS) {
    flags[field] = cookie[field] === true;
  }
  return flags;
}

function applyActivationFlags(cookie, flags = {}) {
  for (const field of COOKIE_ACTIVATION_FIELDS) {
    if (flags[field]) cookie[field] = true;
  }
}

function collectWorkingFlag(cookie) {
  return cookie?.isWorking === true;
}

function applyWorkingFlag(cookie, isWorking) {
  cookie.isWorking = isWorking === true;
}

function isCookieReady(cookie) {
  return Boolean(cookie?.hasCookies && cookie?.data);
}

async function getImportedCookieStatus(container) {
  const cookie = await findImportedCookie(container);
  return {
    cookie,
    imported: Boolean(cookie),
    ready: isCookieReady(cookie)
  };
}

function toSafeCookie(cookie) {
  if (!cookie) return null;
  const obj = typeof cookie.toObject === 'function' ? cookie.toObject() : { ...cookie };
  delete obj.data;
  return obj;
}

async function saveImportedCookie(container, sessionData, options = {}) {
  const normalized = String(container).toUpperCase();
  const fileName = containerFileName(normalized);
  const payload = normalizeCookiePayload(sessionData);
  const cookieCount = countCookiesInData(payload);
  const hasCookies = cookieCount > 0;
  const remoteLabel = options.label;

  if (!hasCookies && !options.allowEmpty) {
    throw new Error(`No cookies found in FreightDesk container ${normalized}`);
  }

  const existingCookie = await findImportedCookie(normalized);
  const preservedActivation = options.preservedActivation || collectActivationFlags(existingCookie);
  const preservedIsWorking =
    options.preservedIsWorking === true || collectWorkingFlag(existingCookie);

  let cookie = existingCookie;
  if (!cookie) {
    cookie = new Cookie({
      fileName,
      filePath: '',
      note: `FreightDesk Container ${normalized}`,
      label: remoteLabel || 'new',
      cookieCount,
      hasCookies,
      fileSize: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      data: payload,
      lastUpdated: new Date(),
      source: 'freightdesk',
      isWorking: preservedIsWorking
    });
  } else {
    cookie.cookieCount = cookieCount;
    cookie.hasCookies = hasCookies;
    cookie.fileSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    cookie.data = payload;
    cookie.lastUpdated = new Date();
    cookie.source = 'freightdesk';
    if (remoteLabel) cookie.label = remoteLabel;
    if (!cookie.note) cookie.note = `FreightDesk Container ${normalized}`;
  }

  applyActivationFlags(cookie, preservedActivation);
  applyWorkingFlag(cookie, preservedIsWorking);
  await cookie.save();
  return cookie;
}

async function importContainerFromRemote(container, options = {}) {
  const normalized = String(container).toUpperCase();
  const existingCookie = await findImportedCookie(normalized);
  const preservedActivation =
    options.preservedActivation ?? collectActivationFlags(existingCookie);
  const preservedIsWorking =
    options.preservedIsWorking === true || collectWorkingFlag(existingCookie);

  const remote = await freightdeskApiService.fetchSession(normalized);
  if (!remote?.success || !remote.session) {
    throw new Error(remote?.message || `FreightDesk session not found for container ${normalized}`);
  }

  return saveImportedCookie(normalized, remote.session, {
    label: remote.label,
    preservedActivation,
    preservedIsWorking,
    allowEmpty: options.allowEmpty
  });
}

async function listContainerIds() {
  const response = await freightdeskApiService.listContainers();
  const items = response?.containers || [];
  const ids = items
    .map((item) => String(item?.container || item).toUpperCase())
    .filter(Boolean);
  if (ids.length > 0) return [...new Set(ids)];

  const data = await freightdeskApiService.fetchAllSessions();
  return [
    ...new Set(
      (data.sessions || [])
        .map((session) => String(session.container || '').toUpperCase())
        .filter(Boolean)
    )
  ];
}

async function importAllContainers(options = {}) {
  if (!freightdeskApiService.isConfigured()) {
    return {
      success: false,
      skipped: true,
      reason: 'FreightDesk partner API is not configured.',
      imported: 0,
      failed: 0,
      containers: [],
      errors: []
    };
  }

  const activationSnapshot = new Map();
  const workingSnapshot = new Map();
  const existingFdCookies = await Cookie.find({
    fileName: { $regex: `^${FD_CONTAINER_PREFIX}`, $options: 'i' }
  });
  for (const cookie of existingFdCookies) {
    const container = parseContainerFromFileName(cookie.fileName);
    if (container) {
      activationSnapshot.set(container, collectActivationFlags(cookie));
      workingSnapshot.set(container, collectWorkingFlag(cookie));
    }
  }

  if (options.forceReimport) {
    console.log('[FreightDesk] Force re-import: replacing each container after successful fetch');
  }

  const containerIds = await listContainerIds();
  const imported = [];
  const failed = [];
  const retryQueue = [];

  for (let i = 0; i < containerIds.length; i++) {
    const container = containerIds[i];
    try {
      const cookie = await importContainerFromRemote(container, {
        forceReimport: Boolean(options.forceReimport),
        preservedActivation: activationSnapshot.get(container),
        preservedIsWorking: workingSnapshot.get(container) === true
      });
      imported.push({
        container,
        cookieId: cookie._id,
        label: cookie.label,
        hasCookies: cookie.hasCookies
      });
    } catch (err) {
      const retryable = /502|503|504|timed out|network error|overloaded/i.test(err.message || '');
      if (retryable) retryQueue.push(container);
      failed.push({ container, error: err.message });
    }

    if (i < containerIds.length - 1) {
      await sleep(IMPORT_DELAY_MS);
    }
  }

  if (retryQueue.length > 0) {
    console.log(`[FreightDesk] Retrying ${retryQueue.length} container(s)...`);
    await sleep(IMPORT_DELAY_MS * 2);

    for (const container of retryQueue) {
      try {
        const cookie = await importContainerFromRemote(container, {
          forceReimport: Boolean(options.forceReimport),
          preservedActivation: activationSnapshot.get(container),
          preservedIsWorking: workingSnapshot.get(container) === true
        });
        imported.push({
          container,
          cookieId: cookie._id,
          label: cookie.label,
          hasCookies: cookie.hasCookies
        });
        const idx = failed.findIndex((f) => f.container === container);
        if (idx >= 0) failed.splice(idx, 1);
      } catch (err) {
        const existing = failed.find((f) => f.container === container);
        if (existing) existing.error = err.message;
        else failed.push({ container, error: err.message });
      }
      await sleep(IMPORT_DELAY_MS);
    }
  }

  if (options.activate && imported.length) {
    const channel = normalizeCookieChannel(options.channel || 'single');
    const activeField = getActiveFieldForChannel(channel);
    await Cookie.updateMany({}, { $set: { [activeField]: false } });
    const last = imported[imported.length - 1];
    await Cookie.findByIdAndUpdate(last.cookieId, { $set: { [activeField]: true } });
  }

  return {
    success: true,
    imported: imported.length,
    failed: failed.length,
    total: containerIds.length,
    containers: imported,
    errors: failed,
    activated: Boolean(options.activate),
    channel: options.activate ? normalizeCookieChannel(options.channel || 'single') : null,
    forceReimport: Boolean(options.forceReimport)
  };
}

async function updateContainerLabel(container, label) {
  const normalized = String(container || '').toUpperCase();
  if (!ASSIGNABLE_LABELS.has(String(label || ''))) {
    throw new Error(
      'Invalid label. Use new, single, double, multi_without_auto, multi_with_auto, or test.'
    );
  }

  if (!freightdeskApiService.isConfigured()) {
    throw new Error('FreightDesk partner API is not configured.');
  }

  await freightdeskApiService.updateContainerLabel(normalized, label);

  const cookie = await findImportedCookie(normalized);
  if (cookie) {
    cookie.label = label;
    await cookie.save();
    return toSafeCookie(cookie);
  }

  return {
    container: normalized,
    label,
    fileName: containerFileName(normalized)
  };
}

async function activateImportedCookie(container, channelInput = 'single') {
  const normalized = String(container || '').toUpperCase();

  if (!isValidCookieChannel(channelInput)) {
    throw new Error('Invalid cookie channel.');
  }

  const channel = normalizeCookieChannel(channelInput);

  const existingCookie = await findImportedCookie(normalized);
  const preservedActivation = collectActivationFlags(existingCookie);
  const preservedIsWorking = collectWorkingFlag(existingCookie);

  const cookie = await importContainerFromRemote(normalized, {
    forceReimport: true,
    preservedActivation,
    preservedIsWorking
  });

  if (!isCookieReady(cookie)) {
    throw new Error(
      'No cookies found in FreightDesk session. Upload or refresh the session in FreightDesk, then re-import.'
    );
  }

  const activeField = getActiveFieldForChannel(channel);
  await Cookie.updateMany({ _id: { $ne: cookie._id } }, { $set: { [activeField]: false } });
  cookie[activeField] = true;
  await cookie.save();

  return {
    container: normalized,
    channel,
    channelName: CHANNEL_LABELS[channel] || channel,
    cookie: toSafeCookie(cookie)
  };
}

async function setWorkingStatus(container, isWorking) {
  const normalized = String(container || '').toUpperCase();
  let cookie = await findImportedCookie(normalized);

  if (!cookie) {
    throw new Error('Import this container before marking working status.');
  }

  cookie.isWorking = isWorking === true;
  await cookie.save();
  return toSafeCookie(cookie);
}

module.exports = {
  containerFileName,
  isFdContainerFileName,
  parseContainerFromFileName,
  findImportedCookie,
  saveImportedCookie,
  importContainerFromRemote,
  listContainerIds,
  importAllContainers,
  updateContainerLabel,
  activateImportedCookie,
  setWorkingStatus,
  isCookieReady,
  getImportedCookieStatus,
  toSafeCookie,
  ASSIGNABLE_LABELS
};
