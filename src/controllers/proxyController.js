const Proxy = require('../models/Proxy');
const User = require('../models/User');
const { getAppSettings, resolveProxyForUser, proxyDocToString } = require('../utils/proxyResolve');
const { isValidProxy, formatProxy, parseProxy } = require('../utils/proxy');
const { isProxyEnabled } = require('../utils/permissions');
const { listFailoverCandidates } = require('../utils/proxyLoadBalance');
const { logActivity } = require('../services/activityLogService');

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
    const [proxies, settings, userCounts] = await Promise.all([
      Proxy.find().sort({ createdAt: -1 }),
      getAppSettings(),
      User.aggregate([
        {
          $match: {
            role: { $ne: 'admin' },
            isBanned: { $ne: true },
            proxyId: { $ne: null }
          }
        },
        { $group: { _id: '$proxyId', count: { $sum: 1 } } }
      ])
    ]);

    await settings.populate('globalProxyId');

    const countByProxyId = Object.fromEntries(
      userCounts.map((row) => [String(row._id), row.count])
    );

    return res.json({
      proxies: proxies.map((p) => {
        const safe = p.toSafeJSON();
        return {
          ...safe,
          activeUserCount: countByProxyId[String(p._id)] || 0
        };
      }),
      settings: {
        globalProxyEnabled: settings.globalProxyEnabled,
        globalProxyId: settings.globalProxyId?._id || settings.globalProxyId || null,
        globalProxy: settings.globalProxyId
          ? typeof settings.globalProxyId.toSafeJSON === 'function'
            ? settings.globalProxyId.toSafeJSON()
            : settings.globalProxyId
          : null,
        blockDatTrackers: settings.blockDatTrackers !== false
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
    const { globalProxyEnabled, globalProxyId, blockDatTrackers } = req.body;

    if (blockDatTrackers !== undefined) {
      settings.blockDatTrackers = !!blockDatTrackers;
    }

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
          : null,
        blockDatTrackers: settings.blockDatTrackers !== false
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
    if (resolved.source === 'direct') {
      return res.json({
        success: true,
        proxy: null,
        source: 'direct',
        proxyId: null,
        name: null
      });
    }

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

function proxyAddress(value) {
  const parsed = parseProxy(value);
  return parsed ? `${parsed.host}:${parsed.port}`.toLowerCase() : '';
}

function triedSet(body) {
  return new Set((Array.isArray(body?.tried) ? body.tried : []).map(proxyAddress).filter(Boolean));
}

/**
 * Desktop: the user's proxy does not work → offer the least-loaded enabled proxy
 * (Admin → Proxies "Enabled"; Horizon-reserved ones only for label=horizon),
 * skipping the ones already tried. Nothing is saved until /failover/confirm.
 * Body: { tried: ["host:port" | proxy string, ...], reason?: "ERR_…" }
 */
async function getFailoverProxy(req, res) {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(401).json({ message: 'User not found' });
    if (!isProxyEnabled(user.permissions)) {
      return res.status(400).json({ success: false, message: 'Proxy is disabled for this account' });
    }

    const tried = triedSet(req.body);
    const reason = String(req.body?.reason || '').slice(0, 60);
    const [pick] = await listFailoverCandidates(user, tried);

    if (!pick) {
      await logActivity({
        userId: user._id,
        actorEmail: user.email,
        action: 'proxy.failover',
        category: 'system',
        status: 'failure',
        message: `Proxy not working for ${user.email} (${[...tried].join(', ') || 'unknown'}${
          reason ? `, ${reason}` : ''
        }) — no other enabled proxy left`,
        meta: { tried: [...tried], reason },
        req
      });
      return res.status(404).json({ success: false, message: 'No other enabled proxy available' });
    }

    return res.json({
      success: true,
      proxy: proxyDocToString(pick),
      source: 'failover',
      proxyId: pick._id,
      name: pick.name || null
    });
  } catch (error) {
    console.error('[PROXY] Failover error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/**
 * Desktop: the offered proxy reached DAT → make it the user's proxy from now on
 * (only when their proxy came from their own assignment; a custom or global
 * proxy is left alone). Body: { proxyId, tried: [...], reason? }
 */
async function confirmFailoverProxy(req, res) {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(401).json({ message: 'User not found' });

    const tried = triedSet(req.body);
    const reason = String(req.body?.reason || '').slice(0, 60);
    const proxyId = String(req.body?.proxyId || '');
    // Must still be a working proxy this user may use
    const pick = (await listFailoverCandidates(user, tried)).find((d) => String(d._id) === proxyId);
    if (!pick) {
      return res.status(400).json({ success: false, message: 'Proxy is not an enabled proxy this user may use' });
    }

    const resolved = await resolveProxyForUser(user);
    const saved = resolved.source === 'user' || resolved.source === 'legacy' || !resolved.proxy;
    if (saved) {
      user.proxyId = pick._id;
      await user.save();
    }

    await logActivity({
      userId: user._id,
      actorEmail: user.email,
      action: 'proxy.failover',
      category: 'system',
      status: 'success',
      message: `Proxy not working for ${user.email} (${[...tried].join(', ') || 'unknown'}${
        reason ? `, ${reason}` : ''
      }) — switched to ${pick.name}${saved ? ' and assigned it to the user' : ` (not saved: ${resolved.source} proxy)`}`,
      meta: { tried: [...tried], reason, proxyId: String(pick._id), saved },
      req
    });

    return res.json({ success: true, saved, proxyId: pick._id, name: pick.name || null });
  } catch (error) {
    console.error('[PROXY] Failover confirm error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  getFailoverProxy,
  confirmFailoverProxy,
  listProxies,
  createProxy,
  updateProxy,
  deleteProxy,
  updateProxySettings,
  getResolvedProxy
};
