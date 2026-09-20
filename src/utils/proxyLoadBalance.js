'use strict';

/**
 * Least-load proxy assignment for Dat Desk users.
 * Uses the shared working-proxy pool from DATHUB/backend/config/working-proxies.js
 */

const path = require('path');
const Proxy = require('../models/Proxy');
const User = require('../models/User');

const workingProxies = require(path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'DATHUB',
  'backend',
  'config',
  'working-proxies.js'
));

const {
  WORKING_KEYS,
  RESERVED_KEYS,
  canUseReservedProxies,
  pickLeastLoadedSlot,
  isSwiftSolutionsUser
} = workingProxies;

async function getWorkingProxyDocs() {
  const enabled = await Proxy.find({ enabled: true }).lean();
  const byKey = new Map();
  for (const p of enabled) {
    const key = `${p.host}:${p.port}`;
    if (!WORKING_KEYS.has(key)) continue;
    const prev = byKey.get(key);
    if (!prev || /^FD\s*[·.]/i.test(p.name || '')) {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

async function countUsersPerProxy(proxyIds) {
  const counts = Object.fromEntries(proxyIds.map((id) => [String(id), 0]));
  const rows = await User.aggregate([
    {
      $match: {
        role: { $ne: 'admin' },
        isBanned: { $ne: true },
        proxyId: { $in: proxyIds },
        'permissions.proxyEnabled': { $ne: false }
      }
    },
    { $group: { _id: '$proxyId', n: { $sum: 1 } } }
  ]);
  for (const r of rows) {
    counts[String(r._id)] = r.n;
  }
  return counts;
}

/**
 * Pick the least-loaded working proxy allowed for this user.
 * Returns Proxy mongoose doc or lean object, or null.
 */
async function assignLeastLoadedProxyForUser(userLike = {}) {
  const docs = await getWorkingProxyDocs();
  if (!docs.length) return null;

  const counts = await countUsersPerProxy(docs.map((d) => d._id));
  const slots = docs.map((d) => ({
    key: `${d.host}:${d.port}`,
    count: counts[String(d._id)] || 0,
    meta: d
  }));

  // Swift must never land on reserved
  const user = {
    label: userLike.label,
    plan: userLike.plan
  };
  if (isSwiftSolutionsUser(user) && !canUseReservedProxies(user)) {
    // already handled inside pickLeastLoadedSlot
  }

  const picked = pickLeastLoadedSlot(slots, user, RESERVED_KEYS);
  return picked ? picked.meta : null;
}

module.exports = {
  assignLeastLoadedProxyForUser,
  getWorkingProxyDocs,
  WORKING_KEYS,
  RESERVED_KEYS,
  canUseReservedProxies
};
