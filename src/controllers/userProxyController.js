const User = require('../models/User');
const crypto = require('crypto');

function normalizeCredentials(body = {}) {
  if (typeof body === 'string' || (body.host && String(body.host).includes(':') && !body.port)) {
    const raw = typeof body === 'string' ? body : body.host;
    const parts = String(raw).trim().split(':');
    if (parts.length < 2) return null;
    const host = parts[0].trim();
    const port = parseInt(parts[1], 10);
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    return {
      host,
      port,
      username: parts[2] || '',
      password: parts.slice(3).join(':') || ''
    };
  }

  const host = String(body.host || '').trim();
  const port = parseInt(body.port, 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return {
    host,
    port,
    username: String(body.username || '').trim(),
    password: body.password != null ? String(body.password) : ''
  };
}

function toClientPayload(customProxy) {
  const enabled = Boolean(customProxy?.enabled);
  const host = customProxy?.host || '';
  const port = customProxy?.port || 0;
  const username = customProxy?.username || '';
  const password = customProxy?.password || '';
  const configured = Boolean(host && port > 0);

  return {
    enabled,
    host,
    port: configured ? port : '',
    username,
    password,
    hasPassword: Boolean(password),
    configured,
    preview: configured ? `${host}:${port}` : '',
    usingCustom: enabled && configured
  };
}

function buildProxyString(customProxy) {
  if (!customProxy?.enabled) return null;
  const n = normalizeCredentials(customProxy);
  if (!n) return null;
  if (n.username || n.password) {
    return `${n.host}:${n.port}:${n.username}:${n.password}`;
  }
  return `${n.host}:${n.port}`;
}

async function getMyProxy(req, res) {
  try {
    const user = await User.findById(req.user.userId).select('customProxy');
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json(toClientPayload(user.customProxy));
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to get proxy' });
  }
}

async function updateMyProxy(req, res) {
  try {
    const user = await User.findById(req.user.userId).select('customProxy');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const existing = user.customProxy || {};
    const incoming = { ...(req.body || {}) };

    if (
      (incoming.password === undefined || incoming.password === null || incoming.password === '') &&
      existing.password
    ) {
      incoming.password = existing.password;
    }

    const enabled =
      incoming.enabled === undefined ? Boolean(existing.enabled) : Boolean(incoming.enabled);

    if (!enabled && !incoming.host && !incoming.port) {
      user.customProxy = {
        enabled: false,
        host: existing.host || '',
        port: existing.port || 0,
        username: existing.username || '',
        password: existing.password || ''
      };
      await user.save({ validateBeforeSave: false });
      return res.json(toClientPayload(user.customProxy));
    }

    const normalized = normalizeCredentials({
      host: incoming.host !== undefined ? incoming.host : existing.host,
      port: incoming.port !== undefined ? incoming.port : existing.port,
      username: incoming.username !== undefined ? incoming.username : existing.username,
      password: incoming.password
    });

    if (!normalized) {
      return res.status(400).json({ message: 'Proxy requires a valid host and port' });
    }

    user.customProxy = {
      enabled,
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      password: normalized.password
    };
    await user.save({ validateBeforeSave: false });
    return res.json(toClientPayload(user.customProxy));
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to save proxy' });
  }
}

async function deleteMyProxy(req, res) {
  try {
    const user = await User.findById(req.user.userId).select('customProxy');
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.customProxy = { enabled: false, host: '', port: 0, username: '', password: '' };
    await user.save({ validateBeforeSave: false });
    return res.json(toClientPayload(user.customProxy));
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to clear proxy' });
  }
}

async function unlockProxyPanel(req, res) {
  try {
    const expected = String(process.env.PROXY_PANEL_PASSWORD || 'Horizon@Proxy#2026');
    const provided = String(req.body?.password || '');
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);

    let ok = false;
    if (expectedBuf.length === providedBuf.length) {
      ok = crypto.timingSafeEqual(expectedBuf, providedBuf);
    }
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to verify' });
  }
}

module.exports = {
  getMyProxy,
  updateMyProxy,
  deleteMyProxy,
  unlockProxyPanel,
  buildProxyString,
  toClientPayload
};
