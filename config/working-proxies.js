'use strict';

/**
 * Working-proxy pool for Dat Desk (kept in-repo so Render deploys don't depend on DATHUB).
 * Keep in sync with DATHUB/backend/config/working-proxies.js
 *
 * RESERVED_FOR_HORIZON_MULTI — never assign to swiftSolutions users.
 * Prefer these for label=horizon and plan=multi users.
 */

const WORKING_PROXIES = [
  '161.77.203.94:12323:14a143f3a436b:ae2f1456b9',
  '161.77.175.86:12323:14a143f3a436b:ae2f1456b9',
  '23.26.136.98:12323:14a143f3a436b:ae2f1456b9',
  '130.12.97.200:12323:14a143f3a436b:ae2f1456b9',
  '64.84.117.208:12323:14a143f3a436b:ae2f1456b9',
  '9.142.11.112:5268:xsoekzgl:lr6bf988aq2h',
  '9.142.15.149:6305:xsoekzgl:lr6bf988aq2h',
  '9.142.15.160:6316:xsoekzgl:lr6bf988aq2h',
  '192.46.185.242:5932:xsoekzgl:lr6bf988aq2h',
  '192.53.66.22:6128:xsoekzgl:lr6bf988aq2h',
  '192.53.70.225:5939:xsoekzgl:lr6bf988aq2h',
  '192.53.138.53:5991:xsoekzgl:lr6bf988aq2h',
  '193.160.83.238:6559:xsoekzgl:lr6bf988aq2h'
];

const RESERVED_FOR_HORIZON_MULTI = [
  '161.77.203.94:12323:14a143f3a436b:ae2f1456b9',
  '161.77.175.86:12323:14a143f3a436b:ae2f1456b9',
  '64.84.117.208:12323:14a143f3a436b:ae2f1456b9'
];

function parseProxyLine(line) {
  const parts = String(line || '').split(':');
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = parseInt(parts[1], 10);
  if (!host || !Number.isFinite(port)) return null;
  return {
    host,
    port,
    username: parts[2] || '',
    password: parts.slice(3).join(':') || '',
    proxyString: `${host}:${port}:${parts[2] || ''}:${parts.slice(3).join(':') || ''}`,
    hostPort: `${host}:${port}`
  };
}

function hostPortKey(line) {
  const p = parseProxyLine(line);
  return p ? p.hostPort : null;
}

const WORKING_KEYS = new Set(WORKING_PROXIES.map(hostPortKey).filter(Boolean));
const RESERVED_KEYS = new Set(RESERVED_FOR_HORIZON_MULTI.map(hostPortKey).filter(Boolean));

function isSwiftSolutionsUser(user) {
  return String(user?.label || '').trim().toLowerCase() === 'swiftsolutions';
}

function isHorizonUser(user) {
  return String(user?.label || '').trim().toLowerCase() === 'horizon';
}

function isMultiPlanUser(user) {
  return String(user?.plan || '').trim().toLowerCase() === 'multi';
}

function canUseReservedProxies(user) {
  if (isSwiftSolutionsUser(user)) return false;
  return isHorizonUser(user) || isMultiPlanUser(user);
}

function pickLeastLoadedSlot(slots, user, reservedKeys = RESERVED_KEYS) {
  if (!slots.length) return null;
  const allowReserved = canUseReservedProxies(user);
  let candidates = allowReserved
    ? slots
    : slots.filter((s) => !reservedKeys.has(s.key));
  if (!candidates.length) {
    candidates = slots.filter((s) => !reservedKeys.has(s.key));
  }
  if (!candidates.length) candidates = slots;

  if (allowReserved) {
    const reserved = candidates.filter((s) => reservedKeys.has(s.key));
    if (reserved.length) {
      const minAll = Math.min(...candidates.map((s) => s.count));
      const minReserved = Math.min(...reserved.map((s) => s.count));
      if (minReserved <= minAll + 1) {
        candidates = reserved.filter((s) => s.count === minReserved);
        return candidates[Math.floor(Math.random() * candidates.length)];
      }
    }
  }

  const min = Math.min(...candidates.map((s) => s.count));
  const tied = candidates.filter((s) => s.count === min);
  return tied[Math.floor(Math.random() * tied.length)];
}

module.exports = {
  WORKING_PROXIES,
  RESERVED_FOR_HORIZON_MULTI,
  WORKING_KEYS,
  RESERVED_KEYS,
  parseProxyLine,
  hostPortKey,
  isSwiftSolutionsUser,
  isHorizonUser,
  isMultiPlanUser,
  canUseReservedProxies,
  pickLeastLoadedSlot
};
