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
  countCookiesInData,
  setActiveCookie
} = require('../utils/cookies');
const {
  sessionFingerprint,
  authExpiresAt,
  diffSessions
} = require('../utils/sessionFingerprint');
const { sessionIdentity } = require('../utils/sessionIdentity');
const { buildDeviceProfile } = require('../utils/deviceProfile');

/** Stable seed for an account's device profile: its DAT account id, else the container. */
function profileSeed(payload, container) {
  return sessionIdentity(payload).accountId || String(container || '').toUpperCase();
}

/**
 * Import modes:
 *  - 'changed' import only containers whose FreightDesk cookies changed since the last import
 *  - 'all'     import every container (default)
 *  - 'force'   like 'all', and may also replace a newer login synced from Dat Desk
 */
const IMPORT_MODES = new Set(['changed', 'all', 'force']);

function normalizeImportMode(mode) {
  const raw = String(mode || '').toLowerCase();
  return IMPORT_MODES.has(raw) ? raw : 'all';
}

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

/**
 * Decide whether a FreightDesk payload should replace the stored cookie.
 *
 * Dat Desk keeps the stored cookie current (POST /cookie/sync), so the DB copy can differ
 * from FreightDesk without FreightDesk having changed. `fdFingerprint` remembers what
 * FreightDesk sent last time: equal → FreightDesk has nothing new. And unless forced, a
 * payload whose Auth0 login expires earlier than the stored one never replaces it, so an
 * import cannot roll a renewed session back to an older one.
 *
 * @returns {{ action: 'import'|'skip', status: string, reason: string, diff: object, fingerprint: string }}
 */
function planFdImport(existingCookie, payload, mode = 'all') {
  const fingerprint = sessionFingerprint(payload);
  const diff = diffSessions(existingCookie?.data, payload);
  const result = (action, status, reason) => ({ action, status, reason, diff, fingerprint });
  if (!existingCookie) return result('import', 'new', 'Not imported yet');

  const storedFingerprint = existingCookie.sessionFingerprint || sessionFingerprint(existingCookie.data);
  const lastFd = existingCookie.fdFingerprint || storedFingerprint;
  const remoteUnchanged = Boolean(fingerprint) && fingerprint === lastFd;
  const sameAsStored = Boolean(fingerprint) && fingerprint === storedFingerprint;

  if (mode === 'changed' && remoteUnchanged) {
    return result('skip', 'unchanged', 'FreightDesk cookies unchanged since the last import');
  }
  if (mode !== 'force' && !sameAsStored) {
    const remoteExp = authExpiresAt(payload);
    const storedExp = existingCookie.authExpiresAt || authExpiresAt(existingCookie.data);
    if (storedExp && (!remoteExp || remoteExp < storedExp)) {
      return result(
        'skip',
        'kept-newer',
        existingCookie.syncedAt
          ? `Server copy is newer (synced from Dat Desk ${existingCookie.syncedAt.toISOString()})`
          : 'Server copy has a newer DAT login than FreightDesk'
      );
    }
    if (remoteUnchanged && existingCookie.syncedAt) {
      return result('skip', 'kept-newer', 'FreightDesk unchanged; server copy was synced from Dat Desk since');
    }
  }
  return result('import', remoteUnchanged ? 'reimported' : 'changed', remoteUnchanged ? 'Re-imported' : 'FreightDesk cookies changed');
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
  const fingerprint = sessionFingerprint(payload);
  cookie.sessionFingerprint = fingerprint;
  cookie.authExpiresAt = authExpiresAt(payload);
  cookie.fdFingerprint = fingerprint;
  cookie.fdImportedAt = new Date();

  // User agent, bound proxy, and a stable per-account device fingerprint travel with the
  // session so every device replays the account as the same browser from the same IP.
  const userAgent = String(
    options.userAgent || payload.userAgent || existingCookie?.userAgent || ''
  ).trim();
  cookie.userAgent = userAgent;
  cookie.fingerprint = buildDeviceProfile(profileSeed(payload, normalized), userAgent);
  if (options.proxy !== undefined) {
    cookie.proxy = String(options.proxy || '').trim();
  }
  // The data is FreightDesk's now, not a Dat Desk sync.
  cookie.syncedAt = null;
  cookie.syncedBy = '';

  // An existing cookie keeps its flags as they are in the DB now: re-applying a
  // snapshot taken earlier would undo an activation an admin made meanwhile.
  if (!existingCookie) {
    applyActivationFlags(cookie, preservedActivation);
    applyWorkingFlag(cookie, preservedIsWorking);
  }
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

  const remoteUserAgent = String(remote.userAgent || remote.session?.userAgent || '').trim();
  const remoteProxy = String(remote.proxy || '').trim();

  const plan = planFdImport(existingCookie, normalizeCookiePayload(remote.session), normalizeImportMode(options.mode));
  if (plan.action === 'skip') {
    if (remote.label && existingCookie.label !== remote.label) {
      existingCookie.label = remote.label;
      await existingCookie.save();
    }
    // The cookies did not change, but the account's proxy / user agent / fingerprint might
    // have, or be missing from an older import — refresh them so the session still replays
    // as the same browser from the bound IP.
    const refresh = {};
    if (remoteUserAgent && existingCookie.userAgent !== remoteUserAgent) refresh.userAgent = remoteUserAgent;
    if (remote.proxy !== undefined && existingCookie.proxy !== remoteProxy) refresh.proxy = remoteProxy;
    const seed = profileSeed(normalizeCookiePayload(remote.session), normalized);
    const nextUa = refresh.userAgent || existingCookie.userAgent || '';
    if (refresh.userAgent || !existingCookie.fingerprint) {
      refresh.fingerprint = buildDeviceProfile(seed, nextUa);
    }
    // Remember FreightDesk's current version so "changed only" does not report it again.
    if (plan.fingerprint && existingCookie.fdFingerprint !== plan.fingerprint) {
      refresh.fdFingerprint = plan.fingerprint;
    }
    if (Object.keys(refresh).length) {
      await Cookie.updateOne({ _id: existingCookie._id }, { $set: refresh }, { timestamps: false });
      Object.assign(existingCookie, refresh);
    }
    return { cookie: existingCookie, ...plan };
  }

  const cookie = await saveImportedCookie(normalized, remote.session, {
    label: remote.label,
    userAgent: remoteUserAgent,
    proxy: remote.proxy !== undefined ? remoteProxy : undefined,
    preservedActivation,
    preservedIsWorking,
    allowEmpty: options.allowEmpty
  });
  return { cookie, ...plan };
}

/**
 * Import the container's CURRENT FreightDesk session as a brand-new, standalone cookie —
 * WITHOUT touching the existing imported cookie. Used for "keep both" when FreightDesk now
 * holds a different account than the DB copy (someone pushed another account on the same
 * container), so the admin can keep and activate either one. The new file does not use the
 * `fd-container-` name, so later FD imports never overwrite it; it carries its own user
 * agent and device fingerprint.
 */
async function importContainerAsSeparate(container) {
  const normalized = String(container || '').toUpperCase();
  const remote = await freightdeskApiService.fetchSession(normalized);
  if (!remote?.success || !remote.session) {
    throw new Error(remote?.message || `FreightDesk session not found for container ${normalized}`);
  }
  const payload = normalizeCookiePayload(remote.session);
  const cookieCount = countCookiesInData(payload);
  if (!cookieCount) {
    throw new Error('No cookies in the FreightDesk session to import.');
  }

  const identity = sessionIdentity(payload);
  const userAgent = String(remote.userAgent || remote.session?.userAgent || '').trim();
  const proxy = String(remote.proxy || '').trim();
  const tail = (identity.accountId ? identity.accountId.split('|').pop() : '').slice(-6);
  const suffix = tail || Date.now().toString(36).slice(-6);
  // Not an `fd-container-` name on purpose → FD import will never re-manage/overwrite it.
  const fileName = `fd-copy-${normalized}-${suffix}-${Date.now()}.json`;
  const fingerprint = buildDeviceProfile(identity.accountId || fileName, userAgent);

  const cookie = await Cookie.create({
    fileName,
    data: payload,
    filePath: '',
    cookieCount,
    hasCookies: cookieCount > 0,
    fileSize: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    source: 'freightdesk-copy',
    label: remote.label || 'new',
    userAgent,
    proxy,
    fingerprint,
    sessionFingerprint: sessionFingerprint(payload),
    authExpiresAt: authExpiresAt(payload),
    fdFingerprint: sessionFingerprint(payload),
    fdImportedAt: new Date(),
    note:
      `FreightDesk container ${normalized} — separate copy` +
      (identity.email ? ` (${identity.email})` : identity.name ? ` (${identity.name})` : '')
  });

  return {
    cookie,
    accountId: identity.accountId || '',
    email: identity.email || '',
    name: identity.name || ''
  };
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

  const mode = normalizeImportMode(options.mode);
  console.log(`[FreightDesk] Import all (mode: ${mode})`);

  const containerIds = await listContainerIds();
  const imported = [];
  const skipped = [];
  const failed = [];
  const record = (container, outcome) => {
    const entry = {
      container,
      cookieId: outcome.cookie._id,
      label: outcome.cookie.label,
      hasCookies: outcome.cookie.hasCookies,
      status: outcome.status,
      reason: outcome.reason,
      diff: outcome.diff
    };
    (outcome.action === 'import' ? imported : skipped).push(entry);
  };
  const retryQueue = [];
  const onProgress =
    typeof options.onProgress === 'function' ? options.onProgress : null;

  const emitProgress = async (extra = {}) => {
    if (!onProgress) return;
    try {
      await onProgress({
        imported: imported.length,
        skipped: skipped.length,
        failed: failed.length,
        total: containerIds.length,
        phase: 'importing',
        ...extra
      });
    } catch (err) {
      console.warn('[FreightDesk] onProgress failed:', err?.message || err);
    }
  };

  await emitProgress({ phase: 'starting', current: null });

  for (let i = 0; i < containerIds.length; i++) {
    const container = containerIds[i];
    await emitProgress({
      current: container,
      phase: 'importing'
    });
    try {
      record(container, await importContainerFromRemote(container, { mode }));
    } catch (err) {
      const retryable = /502|503|504|timed out|network error|overloaded/i.test(err.message || '');
      if (retryable) retryQueue.push(container);
      failed.push({ container, error: err.message });
    }

    await emitProgress({
      current: container,
      phase: 'importing'
    });

    if (i < containerIds.length - 1) {
      await sleep(IMPORT_DELAY_MS);
    }
  }

  if (retryQueue.length > 0) {
    console.log(`[FreightDesk] Retrying ${retryQueue.length} container(s)...`);
    await sleep(IMPORT_DELAY_MS * 2);

    for (const container of retryQueue) {
      await emitProgress({
        current: container,
        phase: 'retrying'
      });
      try {
        record(container, await importContainerFromRemote(container, { mode }));
        const idx = failed.findIndex((f) => f.container === container);
        if (idx >= 0) failed.splice(idx, 1);
      } catch (err) {
        const existing = failed.find((f) => f.container === container);
        if (existing) existing.error = err.message;
        else failed.push({ container, error: err.message });
      }
      await emitProgress({
        current: container,
        phase: 'retrying'
      });
      await sleep(IMPORT_DELAY_MS);
    }
  }

  if (options.activate && imported.length) {
    const channel = normalizeCookieChannel(options.channel || 'single');
    const activeField = getActiveFieldForChannel(channel);
    const last = imported[imported.length - 1];
    await setActiveCookie(last.cookieId, activeField);
  }

  return {
    success: true,
    mode,
    imported: imported.length,
    skipped: skipped.length,
    failed: failed.length,
    total: containerIds.length,
    containers: imported,
    skippedContainers: skipped,
    errors: failed,
    activated: Boolean(options.activate && imported.length),
    channel: options.activate ? normalizeCookieChannel(options.channel || 'single') : null
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

async function activateImportedCookie(container, channelInput = 'single', options = {}) {
  const normalized = String(container || '').toUpperCase();

  if (!isValidCookieChannel(channelInput)) {
    throw new Error('Invalid cookie channel.');
  }

  const channel = normalizeCookieChannel(channelInput);

  const existingCookie = await findImportedCookie(normalized);
  const preservedActivation = collectActivationFlags(existingCookie);
  const preservedIsWorking = collectWorkingFlag(existingCookie);

  const outcome = await importContainerFromRemote(normalized, {
    mode: options.mode,
    preservedActivation,
    preservedIsWorking
  });
  const { cookie } = outcome;

  if (!isCookieReady(cookie)) {
    throw new Error(
      'No cookies found in FreightDesk session. Upload or refresh the session in FreightDesk, then re-import.'
    );
  }

  const activeField = getActiveFieldForChannel(channel);
  await setActiveCookie(cookie._id, activeField);
  cookie[activeField] = true;

  return {
    container: normalized,
    channel,
    channelName: CHANNEL_LABELS[channel] || channel,
    cookie: toSafeCookie(cookie),
    status: outcome.status,
    reason: outcome.reason,
    diff: outcome.diff
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
  importContainerAsSeparate,
  listContainerIds,
  importAllContainers,
  updateContainerLabel,
  activateImportedCookie,
  setWorkingStatus,
  isCookieReady,
  getImportedCookieStatus,
  planFdImport,
  normalizeImportMode,
  toSafeCookie,
  ASSIGNABLE_LABELS
};
