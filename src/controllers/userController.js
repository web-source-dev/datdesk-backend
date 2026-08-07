const User = require('../models/User');
const Proxy = require('../models/Proxy');
const Cookie = require('../models/Cookie');
const { resolveProxyForUser } = require('../utils/proxyResolve');
const { resolveCookieForUser } = require('../utils/cookies');
const { getCookieChannelForUser } = require('../utils/cookieChannels');
const { normalizePermissions, getEnabledCustomTabs } = require('../utils/permissions');

function normalizePlan(plan) {
  const p = String(plan || 'single').trim().toLowerCase();
  if (p === 'double' || p === 'multi') return p;
  return 'single';
}

async function enrichUser(userDoc) {
  const base = typeof userDoc.toSafeJSON === 'function' ? userDoc.toSafeJSON() : userDoc;
  const permissions = normalizePermissions(base.permissions);
  const [resolvedProxy, resolvedCookie] = await Promise.all([
    resolveProxyForUser(userDoc),
    resolveCookieForUser(userDoc)
  ]);

  const assignedCookie =
    userDoc.assignedCookieId && typeof userDoc.assignedCookieId === 'object'
      ? {
          _id: userDoc.assignedCookieId._id,
          fileName: userDoc.assignedCookieId.fileName,
          cookieCount: userDoc.assignedCookieId.cookieCount
        }
      : null;

  return {
    ...base,
    plan: normalizePlan(base.plan),
    label: base.label || '',
    permissions,
    enabledCustomTabs: getEnabledCustomTabs(permissions),
    cookieChannel: getCookieChannelForUser(userDoc),
    proxyId: base.proxyId || null,
    assignedProxy: userDoc.proxyId
      ? typeof userDoc.proxyId === 'object' && userDoc.proxyId?.toSafeJSON
        ? userDoc.proxyId.toSafeJSON()
        : null
      : null,
    assignedCookieId: base.assignedCookieId?._id || base.assignedCookieId || null,
    assignedCookie,
    resolvedProxy: resolvedProxy.proxy
      ? {
          proxy: resolvedProxy.proxy,
          source: resolvedProxy.source,
          proxyId: resolvedProxy.proxyId,
          name: resolvedProxy.proxyDoc?.name || null
        }
      : null,
    resolvedCookie: resolvedCookie.data
      ? {
          source: resolvedCookie.source,
          channel: resolvedCookie.channel,
          cookieId: resolvedCookie.cookieDoc?._id || null,
          fileName: resolvedCookie.cookieDoc?.fileName || null,
          cookieCount: resolvedCookie.data.cookieCount || 0
        }
      : null
  };
}

async function listUsers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const search = (req.query.search || '').trim();
    const plan = String(req.query.plan || '').trim().toLowerCase();
    const label = String(req.query.label || '').trim();
    const role = String(req.query.role || '').trim().toLowerCase();
    const banned = String(req.query.banned || '').trim().toLowerCase();
    const proxy = String(req.query.proxy || '').trim().toLowerCase();
    const cookie = String(req.query.cookie || '').trim().toLowerCase();
    const openDat = String(req.query.openDat || '').trim().toLowerCase();

    const conditions = [];

    // Partner-managed Swift users stay out of the main table unless explicitly filtered
    if (label === 'swiftSolutions') {
      conditions.push({ label: 'swiftSolutions' });
    } else if (label === 'test') {
      conditions.push({ label: 'test' });
    } else if (label === 'none') {
      conditions.push({
        $or: [{ label: '' }, { label: null }, { label: { $exists: false } }]
      });
    } else {
      conditions.push({ label: { $ne: 'swiftSolutions' } });
    }

    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      conditions.push({
        $or: [{ name: re }, { email: re }, { note: re }]
      });
    }

    if (plan === 'single' || plan === 'double' || plan === 'multi') {
      conditions.push({ plan });
    }

    if (role === 'admin' || role === 'user') {
      conditions.push({ role });
    }

    if (banned === 'true' || banned === '1') {
      conditions.push({ isBanned: true });
    } else if (banned === 'false' || banned === '0') {
      conditions.push({ isBanned: { $ne: true } });
    }

    if (proxy === 'assigned') {
      conditions.push({ proxyId: { $ne: null } });
    } else if (proxy === 'none') {
      conditions.push({
        $or: [{ proxyId: null }, { proxyId: { $exists: false } }]
      });
    }

    if (cookie === 'assigned') {
      conditions.push({ assignedCookieId: { $ne: null } });
    } else if (cookie === 'none') {
      conditions.push({
        $or: [{ assignedCookieId: null }, { assignedCookieId: { $exists: false } }]
      });
    }

    if (openDat === 'true' || openDat === '1') {
      conditions.push({
        $or: [
          { 'permissions.openDat': true },
          { 'permissions.openDat': { $exists: false } },
          { permissions: { $exists: false } }
        ]
      });
    } else if (openDat === 'false' || openDat === '0') {
      conditions.push({ 'permissions.openDat': false });
    }

    const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };

    const [users, total] = await Promise.all([
      User.find(filter)
        .populate('proxyId')
        .populate('assignedCookieId')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter)
    ]);

    const enriched = await Promise.all(users.map((u) => enrichUser(u)));

    return res.json({
      users: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    console.error('[USER] List error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createUser(req, res) {
  try {
    const {
      name,
      email,
      password,
      role,
      domain,
      proxyId,
      note,
      permissions,
      plan,
      label,
      assignedCookieId
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const nextRole = role === 'admin' ? 'admin' : 'user';
    let nextProxyId = null;
    if (proxyId) {
      const p = await Proxy.findById(proxyId);
      if (!p) return res.status(404).json({ message: 'Assigned proxy not found' });
      nextProxyId = p._id;
    }

    let nextCookieId = null;
    if (assignedCookieId) {
      const c = await Cookie.findById(assignedCookieId);
      if (!c) return res.status(404).json({ message: 'Assigned cookie not found' });
      nextCookieId = c._id;
    }

    const user = await User.create({
      name,
      email,
      password,
      role: nextRole,
      domain: domain || 'https://one.dat.com/search-loads',
      plan: normalizePlan(plan),
      label: String(label || '').trim(),
      assignedCookieId: nextCookieId,
      proxyId: nextProxyId,
      proxy: '',
      note: note || '',
      permissions: normalizePermissions(permissions)
    });

    await user.populate('proxyId');
    await user.populate('assignedCookieId');
    return res.status(201).json(await enrichUser(user));
  } catch (error) {
    console.error('[USER] Create error:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
  }
}

async function updateUser(req, res) {
  try {
    const user = await User.findById(req.params.id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const {
      name,
      email,
      password,
      role,
      isBanned,
      domain,
      proxyId,
      note,
      permissions,
      plan,
      label,
      assignedCookieId
    } = req.body;

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email.toLowerCase();
    if (password) user.password = password;
    if (role !== undefined) user.role = role === 'admin' ? 'admin' : 'user';
    if (isBanned !== undefined) user.isBanned = !!isBanned;
    if (domain !== undefined) user.domain = domain;
    if (note !== undefined) user.note = note;
    if (plan !== undefined) user.plan = normalizePlan(plan);
    if (label !== undefined) user.label = String(label || '').trim();
    if (permissions !== undefined) {
      user.permissions = normalizePermissions(permissions);
      user.markModified('permissions');
    }

    if (proxyId !== undefined) {
      if (!proxyId) {
        user.proxyId = null;
      } else {
        const p = await Proxy.findById(proxyId);
        if (!p) return res.status(404).json({ message: 'Assigned proxy not found' });
        user.proxyId = p._id;
      }
    }

    if (assignedCookieId !== undefined) {
      if (!assignedCookieId) {
        user.assignedCookieId = null;
      } else {
        const c = await Cookie.findById(assignedCookieId);
        if (!c) return res.status(404).json({ message: 'Assigned cookie not found' });
        user.assignedCookieId = c._id;
      }
    }

    await user.save();
    await user.populate('proxyId');
    await user.populate('assignedCookieId');
    return res.json(await enrichUser(user));
  } catch (error) {
    console.error('[USER] Update error:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
  }
}

async function deleteUser(req, res) {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ message: 'User deleted' });
  } catch (error) {
    console.error('[USER] Delete error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = { listUsers, createUser, updateUser, deleteUser, enrichUser };
