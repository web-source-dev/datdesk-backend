const Proxy = require('../models/Proxy');
const User = require('../models/User');
const { getAppSettings, resolveProxyForUser, proxyDocToString } = require('../utils/proxyResolve');
const { isValidProxy, formatProxy } = require('../utils/proxy');

function buildProxyFields(body) {
  const host = String(body.host || '').trim();
  const port = String(body.port || '').trim();
  const username = String(body.username || '').trim();
  const password = body.password !== undefined ? String(body.password) : '';
  const name = String(body.name || `${host}:${port}`).trim();
  const note = String(body.note || '').trim();
  const enabled = body.enabled !== undefined ? !!body.enabled : true;

  const connection = formatProxy({ host, port, username, password });
  if (!isValidProxy(connection)) {
    const err = new Error('Invalid proxy. Host and numeric port are required.');
    err.status = 400;
    throw err;
  }

  return { name, host, port, username, password, note, enabled };
}

async function listProxies(_req, res) {
  try {
    const [proxies, settings] = await Promise.all([
      Proxy.find().sort({ createdAt: -1 }),
      getAppSettings()
    ]);

    await settings.populate('globalProxyId');

    return res.json({
      proxies: proxies.map((p) => p.toSafeJSON()),
      settings: {
        globalProxyEnabled: settings.globalProxyEnabled,
        globalProxyId: settings.globalProxyId?._id || settings.globalProxyId || null,
        globalProxy: settings.globalProxyId
          ? typeof settings.globalProxyId.toSafeJSON === 'function'
            ? settings.globalProxyId.toSafeJSON()
            : settings.globalProxyId
          : null
      }
    });
  } catch (error) {
    console.error('[PROXY] List error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createProxy(req, res) {
  try {
    const fields = buildProxyFields(req.body);
    const proxy = await Proxy.create(fields);
    return res.status(201).json({ proxy: proxy.toSafeJSON() });
  } catch (error) {
    console.error('[PROXY] Create error:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
  }
}

async function updateProxy(req, res) {
  try {
    const proxy = await Proxy.findById(req.params.id);
    if (!proxy) return res.status(404).json({ message: 'Proxy not found' });

    const body = { ...req.body };
    // Keep existing password if placeholder or empty on update
    if (body.password === '********' || body.password === undefined || body.password === '') {
      body.password = proxy.password;
    }

    const fields = buildProxyFields({
      name: body.name !== undefined ? body.name : proxy.name,
      host: body.host !== undefined ? body.host : proxy.host,
      port: body.port !== undefined ? body.port : proxy.port,
      username: body.username !== undefined ? body.username : proxy.username,
      password: body.password,
      note: body.note !== undefined ? body.note : proxy.note,
      enabled: body.enabled !== undefined ? body.enabled : proxy.enabled
    });

    Object.assign(proxy, fields);
    await proxy.save();
    return res.json({ proxy: proxy.toSafeJSON() });
  } catch (error) {
    console.error('[PROXY] Update error:', error);
    return res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
  }
}

async function deleteProxy(req, res) {
  try {
    const proxy = await Proxy.findById(req.params.id);
    if (!proxy) return res.status(404).json({ message: 'Proxy not found' });

    const settings = await getAppSettings();
    if (settings.globalProxyId && String(settings.globalProxyId) === String(proxy._id)) {
      settings.globalProxyId = null;
      settings.globalProxyEnabled = false;
      await settings.save();
    }

    await User.updateMany({ proxyId: proxy._id }, { $set: { proxyId: null } });
    await proxy.deleteOne();

    return res.json({ message: 'Proxy deleted' });
  } catch (error) {
    console.error('[PROXY] Delete error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateProxySettings(req, res) {
  try {
    const settings = await getAppSettings();
    const { globalProxyEnabled, globalProxyId } = req.body;

    if (globalProxyId !== undefined) {
      if (!globalProxyId) {
        settings.globalProxyId = null;
      } else {
        const exists = await Proxy.findById(globalProxyId);
        if (!exists) {
          return res.status(404).json({ message: 'Global proxy not found' });
        }
        settings.globalProxyId = exists._id;
      }
    }

    if (globalProxyEnabled !== undefined) {
      settings.globalProxyEnabled = !!globalProxyEnabled;
      if (settings.globalProxyEnabled && !settings.globalProxyId) {
        return res.status(400).json({
          message: 'Select a global proxy before enabling app-wide proxy'
        });
      }
    }

    await settings.save();
    await settings.populate('globalProxyId');

    return res.json({
      settings: {
        globalProxyEnabled: settings.globalProxyEnabled,
        globalProxyId: settings.globalProxyId?._id || settings.globalProxyId || null,
        globalProxy: settings.globalProxyId
          ? typeof settings.globalProxyId.toSafeJSON === 'function'
            ? settings.globalProxyId.toSafeJSON()
            : settings.globalProxyId
          : null
      },
      message: 'Proxy settings updated'
    });
  } catch (error) {
    console.error('[PROXY] Settings error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getResolvedProxy(req, res) {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(401).json({ message: 'User not found' });

    const resolved = await resolveProxyForUser(user);
    if (!resolved.proxy) {
      return res.status(404).json({
        success: false,
        message: resolved.message,
        proxy: null,
        source: null
      });
    }

    return res.json({
      success: true,
      proxy: resolved.proxy,
      source: resolved.source,
      proxyId: resolved.proxyId,
      name: resolved.proxyDoc?.name || null
    });
  } catch (error) {
    console.error('[PROXY] Resolve error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  listProxies,
  createProxy,
  updateProxy,
  deleteProxy,
  updateProxySettings,
  getResolvedProxy
};
