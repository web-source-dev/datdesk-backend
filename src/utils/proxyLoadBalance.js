'use strict';

/**
 * Least-load proxy assignment for Dat Desk users.
 */

const Proxy = require('../models/Proxy');
const User = require('../models/User');
const {
  WORKING_KEYS,
  RESERVED_KEYS,
  canUseReservedProxies,
  pickLeastLoadedSlot,
  isSwiftSolutionsUser
} = require('../../config/working-proxies');

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

  const user = {
    label: userLike.label,
    plan: userLike.plan
  };
  if (isSwiftSolutionsUser(user) && !canUseReservedProxies(user)) {
    // reserved exclusion handled in pickLeastLoadedSlot
  }

  const picked = pickLeastLoadedSlot(slots, user, RESERVED_KEYS);
  return picked ? picked.meta : null;
}

/**
 * Proxies this user may switch to when their proxy stops working: every proxy
 * enabled in Admin → Proxies (one per host:port), minus `excludeKeys`
 * ("host:port"), and never a Horizon-reserved proxy for a user who is not
 * label=horizon. Least-loaded first. Returns lean Proxy objects.
 */
async function listFailoverCandidates(userLike = {}, excludeKeys = new Set()) {
  const allowReserved = canUseReservedProxies(userLike);
  const byKey = new Map();
  for (const d of await Proxy.find({ enabled: true }).lean()) {
    const key = `${d.host}:${d.port}`.toLowerCase();
    if (excludeKeys.has(key) || byKey.has(key)) continue;
    if (!allowReserved && RESERVED_KEYS.has(`${d.host}:${d.port}`)) continue;
    byKey.set(key, d);
  }
  const docs = [...byKey.values()];
  if (!docs.length) return [];
  const counts = await countUsersPerProxy(docs.map((d) => d._id));
  return docs
    .map((d) => ({ doc: d, count: counts[String(d._id)] || 0, tie: Math.random() }))
    .sort((a, b) => a.count - b.count || a.tie - b.tie)
    .map((s) => s.doc);
}

module.exports = {
  assignLeastLoadedProxyForUser,
  listFailoverCandidates,
  getWorkingProxyDocs,
  WORKING_KEYS,
  RESERVED_KEYS,
  canUseReservedProxies
};
