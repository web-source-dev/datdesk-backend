const Cookie = require('../models/Cookie');
const {
  COOKIE_CHANNELS,
  getActiveFieldForChannel
} = require('../utils/cookieChannels');
const { isPartnerSwiftSessionVisible } = require('../utils/partnerSwiftSessionFilter');
const { PartnerSwiftConfig, CONFIG_KEY } = require('../models/PartnerSwiftConfig');

const MIN_SLOTS = 5;
const MAX_SLOTS = 6;
const CHANNEL = COOKIE_CHANNELS.SWIFT_SOLUTIONS;
const ACTIVE_FIELD = getActiveFieldForChannel(CHANNEL);

function getSlotLimit() {
  const raw = parseInt(process.env.PARTNER_SWIFT_ACCOUNT_SLOTS, 10);
  if (Number.isNaN(raw)) return MAX_SLOTS;
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, raw));
}

function isFdContainerFileName(fileName) {
  return /^fd-container-[A-Z0-9]+\.json$/i.test(String(fileName || ''));
}

function hasCookiePayload(cookie) {
  if (!cookie) return false;
  if (cookie.hasCookies === false) return false;
  const data = cookie.data;
  if (!data || typeof data !== 'object') {
    return Boolean(cookie.hasCookies);
  }
  if (Array.isArray(data['dat.com']?.cookies)) {
    return data['dat.com'].cookies.length > 0 || Boolean(cookie.hasCookies);
  }
  if (Array.isArray(data.cookies)) {
    return data.cookies.length > 0 || Boolean(cookie.hasCookies);
  }
  return Boolean(cookie.hasCookies);
}

/** Prefer note / sessionName / cleaned fileName for display + auto-filter. */
function getCookieDisplayName(cookie) {
  if (!cookie) return '';
  if (cookie.sessionName) return String(cookie.sessionName).trim();
  if (cookie.note) return String(cookie.note).trim();
  const fileName = String(cookie.fileName || '');
  return fileName
    .replace(/^fd-container-/i, '')
    .replace(/\.json$/i, '')
    .replace(/^\d+-/, '')
    .trim();
}

function getSessionAnchorForCookie(cookie) {
  if (!cookie) return null;
  if (cookie.fileName && isFdContainerFileName(cookie.fileName)) {
    return `file:${cookie.fileName}`;
  }
  if (cookie.fileName) {
    return `file:${cookie.fileName}`;
  }
  return cookie._id ? `id:${cookie._id}` : null;
}

async function findLatestCookieForSession(sessionAnchor) {
  if (!sessionAnchor) return null;
  const anchor = String(sessionAnchor).trim();
  if (!anchor) return null;

  if (anchor.startsWith('file:')) {
    const fileName = anchor.slice(5);
    return Cookie.findOne({ fileName, hasCookies: true }).sort({
      lastUpdated: -1,
      updatedAt: -1
    });
  }

  if (anchor.startsWith('id:')) {
    return Cookie.findById(anchor.slice(3));
  }

  if (/^[A-Z0-9]$/i.test(anchor)) {
    return Cookie.findOne({
      fileName: `fd-container-${anchor.toUpperCase()}.json`,
      hasCookies: true
    });
  }

  return null;
}

async function resolveCookieForSelection(cookieId, sessionAnchor) {
  let cookie = await Cookie.findById(cookieId);
  if (cookie && cookie.hasCookies && hasCookiePayload(cookie)) {
    return cookie;
  }
  if (sessionAnchor) {
    return findLatestCookieForSession(sessionAnchor);
  }
  return null;
}

async function sanitizeSelectedCookieIds(cookieIds, sessionAnchors = []) {
  const uniqueIds = (cookieIds || []).map((id) => String(id).trim()).filter(Boolean);

  if (uniqueIds.length === 0) {
    return { validIds: [], sessionAnchors: [], staleEntries: [] };
  }

  const cookies = await Cookie.find({ _id: { $in: uniqueIds } }).lean();
  const cookieById = new Map(cookies.map((c) => [String(c._id), c]));

  const validIds = [];
  const resolvedAnchors = [];
  const staleEntries = [];

  for (let i = 0; i < uniqueIds.length; i++) {
    const id = uniqueIds[i];
    const anchor = sessionAnchors[i] || null;
    let cookie = cookieById.get(id);

    if (!cookie && anchor) {
      const replacement = await findLatestCookieForSession(anchor);
      if (replacement && replacement.hasCookies) {
        const replacementId = String(replacement._id);
        validIds.push(replacementId);
        resolvedAnchors.push(getSessionAnchorForCookie(replacement) || anchor);
        staleEntries.push({
          id,
          reason: 'replaced',
          replacementId,
          sessionAnchor: anchor,
          fileName: replacement.fileName
        });
        continue;
      }
    }

    if (!cookie) {
      staleEntries.push({ id, reason: 'deleted' });
      continue;
    }

    if (!cookie.hasCookies) {
      const cookieAnchor = getSessionAnchorForCookie(cookie) || anchor;
      if (cookieAnchor) {
        const replacement = await findLatestCookieForSession(cookieAnchor);
        if (replacement && replacement.hasCookies) {
          const replacementId = String(replacement._id);
          validIds.push(replacementId);
          resolvedAnchors.push(getSessionAnchorForCookie(replacement) || cookieAnchor);
          staleEntries.push({
            id,
            reason: 'replaced',
            replacementId,
            sessionAnchor: cookieAnchor,
            fileName: replacement.fileName
          });
          continue;
        }
      }
      staleEntries.push({
        id,
        reason: 'no_cookies',
        sessionName: getCookieDisplayName(cookie) || null,
        fileName: cookie.fileName
      });
      continue;
    }

    validIds.push(id);
    resolvedAnchors.push(getSessionAnchorForCookie(cookie) || anchor || null);
  }

  return { validIds, sessionAnchors: resolvedAnchors, staleEntries };
}

async function pruneStaleDashboardSelection(config) {
  const rawIds = (config.selectedCookieIds || []).map((id) => String(id));
  const rawAnchors = (config.selectedSessionAnchors || []).map((a) =>
    a ? String(a).trim() : null
  );
  const { validIds, sessionAnchors, staleEntries } = await sanitizeSelectedCookieIds(
    rawIds,
    rawAnchors
  );

  const hasRemap = staleEntries.some((e) => e.reason === 'replaced');
  const storedAnchors = (config.selectedSessionAnchors || []).map((a) =>
    a ? String(a).trim() : null
  );
  const needsAnchorBackfill =
    validIds.length > 0 &&
    (storedAnchors.length !== validIds.length ||
      validIds.some((_, i) => !storedAnchors[i] && sessionAnchors[i]));

  if (staleEntries.length === 0 && !needsAnchorBackfill) {
    return { validIds, sessionAnchors, staleEntries, pruned: false };
  }

  if (
    validIds.length === 0 &&
    rawIds.length > 0 &&
    staleEntries.length > 0 &&
    staleEntries.every((e) => e.reason === 'deleted' || e.reason === 'no_cookies')
  ) {
    const hasRecoverableAnchors = rawAnchors.some((a) => a && String(a).trim());
    if (hasRecoverableAnchors) {
      console.warn(
        '[PARTNER_SWIFT] Keeping dashboard selection — cookies may be mid-sync; will remap when available'
      );
      return {
        validIds: rawIds,
        sessionAnchors: rawAnchors,
        staleEntries,
        pruned: false
      };
    }
  }

  config.selectedCookieIds = validIds;
  config.selectedSessionAnchors = sessionAnchors.filter(Boolean);
  if (validIds.length > 0) {
    config.manualSelectionEnabled = true;
  }
  await config.save();

  console.log(
    `[PARTNER_SWIFT] ${hasRemap ? 'Remapped' : 'Removed'} stale dashboard cookie IDs:`,
    staleEntries
      .map(
        (e) =>
          `${e.id} (${e.reason}${e.replacementId ? ` → ${e.replacementId}` : ''})`
      )
      .join(', ')
  );

  return { validIds, sessionAnchors, staleEntries, pruned: true };
}

async function getDashboardSelection() {
  const config = await PartnerSwiftConfig.findOne({ key: CONFIG_KEY });
  if (!config) {
    return { useManualList: false, cookieIds: [], staleEntries: [], pruned: false };
  }

  const { validIds, sessionAnchors, staleEntries, pruned } =
    await pruneStaleDashboardSelection(config);
  const useManualList = Boolean(config.manualSelectionEnabled) || validIds.length > 0;

  if (validIds.length > 0 && !config.manualSelectionEnabled) {
    config.manualSelectionEnabled = true;
    await config.save();
  }

  return {
    useManualList,
    cookieIds: validIds,
    sessionAnchors: sessionAnchors || config.selectedSessionAnchors || [],
    staleEntries,
    pruned
  };
}

async function resolvePartnerAccountCookies() {
  const limit = getSlotLimit();
  const { useManualList, cookieIds, sessionAnchors } = await getDashboardSelection();

  if (useManualList) {
    if (cookieIds.length === 0) {
      return { cookies: [] };
    }

    const cookies = [];
    for (let i = 0; i < Math.min(cookieIds.length, limit); i++) {
      const cookie = await resolveCookieForSelection(cookieIds[i], sessionAnchors[i] || null);
      if (cookie && cookie.hasCookies && hasCookiePayload(cookie)) {
        cookies.push(cookie);
      }
    }
    return { cookies };
  }

  const pinnedIds = (process.env.PARTNER_SWIFT_ACCOUNT_COOKIE_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (pinnedIds.length > 0) {
    const cookies = [];
    for (const id of pinnedIds.slice(0, limit)) {
      const cookie = await Cookie.findById(id);
      if (cookie && hasCookiePayload(cookie)) {
        const name = getCookieDisplayName(cookie);
        if (isPartnerSwiftSessionVisible(name) || !name) {
          cookies.push(cookie);
        }
      }
    }
    return { cookies };
  }

  const all = await Cookie.find({ hasCookies: true }).sort({
    lastUpdated: -1,
    createdAt: -1
  });

  const byKey = new Map();
  for (const cookie of all) {
    if (!hasCookiePayload(cookie)) continue;
    const displayName = getCookieDisplayName(cookie);
    if (!isPartnerSwiftSessionVisible(displayName)) continue;
    const key = getSessionAnchorForCookie(cookie) || String(cookie._id);
    if (!byKey.has(key)) byKey.set(key, cookie);
  }

  const cookies = Array.from(byKey.values())
    .sort((a, b) =>
      getCookieDisplayName(a).localeCompare(getCookieDisplayName(b), undefined, {
        sensitivity: 'base'
      })
    )
    .slice(0, limit);

  return { cookies };
}

function resolveAccountDisplayName(cookie, index, maskSessionNames) {
  if (maskSessionNames) return `Account ${index + 1}`;
  const name = getCookieDisplayName(cookie);
  return name || `Account ${index + 1}`;
}

function toPublicAccounts(cookies, maskSessionNames = true) {
  const activeIndex = cookies.findIndex((c) => c[ACTIVE_FIELD]);

  return {
    accounts: cookies.map((cookie, index) => ({
      slot: index + 1,
      displayName: resolveAccountDisplayName(cookie, index, maskSessionNames),
      isActive: Boolean(cookie[ACTIVE_FIELD]),
      ready: Boolean(cookie.hasCookies && hasCookiePayload(cookie))
    })),
    activeSlot: activeIndex >= 0 ? activeIndex + 1 : null
  };
}

async function listPartnerExtensionAccounts({ maskSessionNames = true } = {}) {
  const { cookies } = await resolvePartnerAccountCookies();
  return toPublicAccounts(cookies, maskSessionNames);
}

async function activatePartnerExtensionAccount(slot, { maskSessionNames = true } = {}) {
  const slotNum = parseInt(slot, 10);
  if (!Number.isInteger(slotNum) || slotNum < 1) {
    return { status: 400, message: 'Invalid account slot' };
  }

  const { cookies } = await resolvePartnerAccountCookies();
  const cookie = cookies[slotNum - 1];

  if (!cookie) {
    return { status: 404, message: 'Account not found' };
  }

  if (!cookie.hasCookies || !hasCookiePayload(cookie)) {
    return {
      status: 400,
      message: 'This account has no cookies loaded yet. Re-import or re-upload.'
    };
  }

  await Cookie.updateMany(
    { _id: { $ne: cookie._id } },
    { $set: { [ACTIVE_FIELD]: false } }
  );

  cookie[ACTIVE_FIELD] = true;
  await cookie.save();

  const refreshed = await resolvePartnerAccountCookies();
  return {
    status: 200,
    activeSlot: slotNum,
    accounts: toPublicAccounts(refreshed.cookies, maskSessionNames).accounts
  };
}

async function refreshPartnerSwiftDashboardSelection() {
  const config = await PartnerSwiftConfig.findOne({ key: CONFIG_KEY });
  if (!config || !(config.selectedCookieIds || []).length) {
    return { pruned: false };
  }
  return pruneStaleDashboardSelection(config);
}

module.exports = {
  getSlotLimit,
  hasCookiePayload,
  getCookieDisplayName,
  getSessionAnchorForCookie,
  sanitizeSelectedCookieIds,
  pruneStaleDashboardSelection,
  refreshPartnerSwiftDashboardSelection,
  listPartnerExtensionAccounts,
  activatePartnerExtensionAccount
};
