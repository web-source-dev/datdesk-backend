const fs = require('fs');
const mongoose = require('mongoose');
const Cookie = require('../models/Cookie');
const User = require('../models/User');
const { logActivity } = require('../services/activityLogService');
const {
  countCookiesInData,
  normalizeCookiePayload,
  resolveCookieForUser,
  readCookieData,
  setActiveCookie,
  COOKIE_META_FIELDS
} = require('../utils/cookies');
const { cookiePayloadEtag, etagsMatch, setCookieRevalidateHeaders } = require('../utils/cookieEtag');
const { sessionFingerprint, authExpiresAt } = require('../utils/sessionFingerprint');
const { sessionIdentity } = require('../utils/sessionIdentity');
const { buildDeviceProfile } = require('../utils/deviceProfile');
const {
  isValidCookieChannel,
  normalizeCookieChannel,
  getActiveFieldForChannel,
  CHANNEL_LABELS,
  COOKIE_CHANNELS,
  userQueryForCookieChannel
} = require('../utils/cookieChannels');

async function listCookies(_req, res) {
  try {
    // Exclude heavy `data` blob from list responses
    const cookies = await Cookie.find()
      .select('-data')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({
      cookies,
      channels: Object.values(COOKIE_CHANNELS).map((id) => ({
        id,
        label: CHANNEL_LABELS[id] || id
      }))
    });
  } catch (error) {
    console.error('[COOKIE] List error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function uploadCookie(req, res) {
  try {
    if (!req.file && !req.body.cookieJson) {
      return res.status(400).json({ message: 'Cookie JSON file or cookieJson body is required' });
    }

    let raw;
    let originalName;

    if (req.file) {
      const text = req.file.buffer
        ? req.file.buffer.toString('utf8')
        : fs.readFileSync(req.file.path, 'utf8');
      raw = JSON.parse(text);
      originalName = req.file.originalname || req.file.filename || `cookie-${Date.now()}.json`;
      // Clean temp disk file if multer used disk storage
      if (req.file.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
      }
    } else {
      raw =
        typeof req.body.cookieJson === 'string'
          ? JSON.parse(req.body.cookieJson)
          : req.body.cookieJson;
      originalName = req.body.fileName || `cookie-${Date.now()}.json`;
    }

    const normalized = normalizeCookiePayload(raw);
    const cookieCount = countCookiesInData(normalized);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${Date.now()}-${safeName}`;
    const fileSize = Buffer.byteLength(JSON.stringify(normalized), 'utf8');

    // Pin a stable synthetic device profile for this account so every device/app that
    // opens it presents the same machine (user agent, client hints, WebGL, timezone…).
    // A manually uploaded session may carry its captured user agent at the top level.
    const userAgent = String(
      raw?.userAgent || raw?.['dat.com']?.userAgent || req.body.userAgent || ''
    ).trim();
    const profileSeed = sessionIdentity(normalized).accountId || fileName;
    const fingerprint = buildDeviceProfile(profileSeed, userAgent);

    const cookie = await Cookie.create({
      fileName,
      data: normalized,
      filePath: '',
      cookieCount,
      hasCookies: cookieCount > 0,
      fileSize,
      userAgent,
      fingerprint,
      note: req.body.note || '',
      isActive: false,
      isActiveSingle: false,
      isActiveDouble: false,
      isActiveMulti: false,
      isActiveHorizon: false,
      isActiveSwiftSolutions: false,
      isActiveTest: false
    });

    const safe = cookie.toObject();
    delete safe.data;

    return res.status(201).json({ cookie: safe });
  } catch (error) {
    console.error('[COOKIE] Upload error:', error);
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
}

async function activateCookie(req, res) {
  try {
    const cookie = await Cookie.findById(req.params.id);
    if (!cookie) {
      return res.status(404).json({ message: 'Cookie not found' });
    }

    const rawChannel = req.body.channel || 'single';
    if (!isValidCookieChannel(rawChannel)) {
      return res.status(400).json({
        message: 'Invalid channel. Use single, double, multi, horizon, swiftSolutions, or test.'
      });
    }
    const channel = normalizeCookieChannel(rawChannel);

    const activeField = getActiveFieldForChannel(channel);

    await setActiveCookie(cookie._id, activeField, { legacy: channel === 'single' });
    cookie[activeField] = true;
    if (channel === 'single') cookie.isActive = true;

    const refresh = await queueSessionRefresh(userQueryForCookieChannel(channel), {
      req,
      meta: { scope: 'channel', channel }
    });

    const safe = cookie.toObject();
    delete safe.data;
    const label = CHANNEL_LABELS[channel] || channel;

    return res.json({
      cookie: safe,
      channel,
      refreshCount: refresh.count,
      message:
        refresh.count > 0
          ? `Cookie activated for ${label}. Session refresh queued for ${refresh.count} account${refresh.count === 1 ? '' : 's'}. They will apply it the next time they open DAT.`
          : `Cookie activated for ${label}. No accounts are on that channel.`
    });
  } catch (error) {
    console.error('[COOKIE] Activate error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deactivateCookie(req, res) {
  try {
    const cookie = await Cookie.findById(req.params.id);
    if (!cookie) {
      return res.status(404).json({ message: 'Cookie not found' });
    }

    const rawChannel = req.body.channel || 'single';
    if (!isValidCookieChannel(rawChannel)) {
      return res.status(400).json({
        message: 'Invalid channel. Use single, double, multi, horizon, swiftSolutions, or test.'
      });
    }
    const channel = normalizeCookieChannel(rawChannel);

    const activeField = getActiveFieldForChannel(channel);
    cookie[activeField] = false;
    if (channel === 'single') cookie.isActive = false;
    await cookie.save();

    const safe = cookie.toObject();
    delete safe.data;

    return res.json({
      cookie: safe,
      channel,
      message: `Cookie deactivated for ${CHANNEL_LABELS[channel] || channel}`
    });
  } catch (error) {
    console.error('[COOKIE] Deactivate error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteCookie(req, res) {
  try {
    const cookie = await Cookie.findById(req.params.id);
    if (!cookie) {
      return res.status(404).json({ message: 'Cookie not found' });
    }

    await User.updateMany(
      { assignedCookieId: cookie._id },
      { $set: { assignedCookieId: null } }
    );

    // Best-effort cleanup of legacy disk files
    if (cookie.filePath && fs.existsSync(cookie.filePath)) {
      try {
        fs.unlinkSync(cookie.filePath);
      } catch {
        // ignore
      }
    }
    await cookie.deleteOne();

    return res.json({ message: 'Cookie deleted' });
  } catch (error) {
    console.error('[COOKIE] Delete error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/**
 * POST /cookie/sync — a running Dat Desk sends the DAT session it has been renewing,
 * so the server copy stays current (new devices and recoveries get the freshest login).
 * Only the cookie this user is served may be written, and never with an older login:
 * the write is skipped when the stored Auth0 cookie already expires later.
 */
async function syncCookie(req, res) {
  try {
    const cookieId = String(req.body?.cookieId || '');
    const payload = normalizeCookiePayload(req.body?.data);
    const fingerprint = sessionFingerprint(payload);
    const expiresAt = authExpiresAt(payload);
    if (!cookieId || !fingerprint || !expiresAt) {
      return res.status(422).json({ updated: false, reason: 'no-login', message: 'No DAT login cookie in the session.' });
    }

    const user = await User.findById(req.user.userId).populate({
      path: 'assignedCookieId',
      select: COOKIE_META_FIELDS
    });
    if (!user) return res.status(401).json({ message: 'User not found' });
    const resolved = await resolveCookieForUser(user, { includeData: false });
    if (!resolved.cookieDoc || String(resolved.cookieDoc._id) !== cookieId) {
      // This device still runs a session the user is no longer assigned to.
      return res.status(409).json({ updated: false, reason: 'cookie-switched' });
    }

    const current = await Cookie.findById(cookieId);
    if (!current) return res.status(404).json({ updated: false, reason: 'not-found' });
    const currentFingerprint = current.sessionFingerprint || sessionFingerprint(current.data);
    const currentExpiresAt = current.authExpiresAt || authExpiresAt(current.data);
    if (fingerprint === currentFingerprint) {
      return res.json({ updated: false, reason: 'unchanged' });
    }
    if (currentExpiresAt && expiresAt < currentExpiresAt) {
      return res.json({ updated: false, reason: 'older', serverExpiresAt: currentExpiresAt });
    }

    // Without a live DAT tab the device sends no storage: keep what the server has.
    const incoming = payload['dat.com'];
    const stored = current.data?.['dat.com'] || {};
    const pick = (next, prev) => (next && Object.keys(next).length ? next : prev || {});
    const data = {
      'dat.com': {
        cookies: incoming.cookies,
        localStorage: pick(incoming.localStorage, stored.localStorage),
        sessionStorage: pick(incoming.sessionStorage, stored.sessionStorage)
      }
    };
    const now = new Date();
    // Conditional write: two devices syncing at once cannot replace a fresher login.
    const result = await Cookie.updateOne(
      {
        _id: current._id,
        $or: [{ authExpiresAt: null }, { authExpiresAt: { $lte: expiresAt } }]
      },
      {
        $set: {
          data,
          cookieCount: countCookiesInData(data),
          hasCookies: countCookiesInData(data) > 0,
          fileSize: Buffer.byteLength(JSON.stringify(data), 'utf8'),
          lastUpdated: now,
          sessionFingerprint: fingerprint,
          authExpiresAt: expiresAt,
          syncedAt: now,
          syncedBy: req.user.email || String(user._id)
        }
      }
    );
    if (!result.modifiedCount) return res.json({ updated: false, reason: 'older' });

    console.log('[COOKIE] synced from Dat Desk', {
      cookieId,
      user: req.user.email,
      cookies: data['dat.com'].cookies.length,
      authExpiresAt: expiresAt.toISOString()
    });
    return res.json({ updated: true, authExpiresAt: expiresAt });
  } catch (error) {
    console.error('[COOKIE] Sync error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getActiveCookieForUser(req, res) {
  try {
    const user = await User.findById(req.user.userId).populate({
      path: 'assignedCookieId',
      select: COOKIE_META_FIELDS
    });
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const resolved = await resolveCookieForUser(user, { includeData: false });
    const etag = cookiePayloadEtag(resolved.cookieDoc, resolved.channel, user.datSessionPush);
    setCookieRevalidateHeaders(res, etag);

    if (etagsMatch(req.headers['if-none-match'], etag)) {
      console.log('[COOKIE] active 304', {
        userId: String(user._id),
        cookieId: resolved.cookieDoc?._id ? String(resolved.cookieDoc._id) : null,
        etag
      });
      res.status(304);
      return res.end();
    }

    if (!resolved.cookieDoc) {
      return res.json({
        'dat.com': { cookies: [], localStorage: {}, sessionStorage: {} },
        source: null,
        channel: resolved.channel,
        cookieId: null,
        fileName: null
      });
    }

    const data = await readCookieData(resolved.cookieDoc);
    if (!data) {
      return res.json({
        'dat.com': { cookies: [], localStorage: {}, sessionStorage: {} },
        source: null,
        channel: resolved.channel,
        cookieId: resolved.cookieDoc?._id || null,
        fileName: resolved.cookieDoc?.fileName || null
      });
    }

    const payload = {
      'dat.com': data['dat.com'] || {
        cookies: [],
        localStorage: {},
        sessionStorage: {}
      },
      source: resolved.source,
      channel: resolved.channel,
      cookieId: resolved.cookieDoc?._id || null,
      fileName: resolved.cookieDoc?.fileName || null,
      // Replay hints: the account's captured user agent, bound proxy, and device fingerprint.
      userAgent: resolved.cookieDoc?.userAgent || '',
      proxy: resolved.cookieDoc?.proxy || '',
      fingerprint: resolved.cookieDoc?.fingerprint || null,
      // Auth0 session expiry of this stored copy — lets the client auto-adopt a backend copy
      // that is genuinely newer than the session it is already running.
      authExpiresAt: resolved.cookieDoc?.authExpiresAt || null
    };

    // Cookies stored before device profiles existed have no fingerprint. Derive one
    // deterministically from the account identity so the client still presents a stable,
    // consistent machine, and persist it so it is identical on every later open.
    if (!payload.fingerprint && resolved.cookieDoc?._id) {
      const seed =
        sessionIdentity(data).accountId ||
        String(resolved.cookieDoc.fileName || resolved.cookieDoc._id);
      const derived = buildDeviceProfile(seed, payload.userAgent);
      payload.fingerprint = derived;
      Cookie.updateOne(
        { _id: resolved.cookieDoc._id },
        { $set: { fingerprint: derived, userAgent: payload.userAgent || derived.userAgent } }
      ).catch((err) => console.warn('[COOKIE] Lazy fingerprint persist failed:', err.message));
      if (!payload.userAgent) payload.userAgent = derived.userAgent;
    }

    console.log('[COOKIE] active 200', {
      userId: String(user._id),
      cookieId: payload.cookieId ? String(payload.cookieId) : null,
      etag,
      cookies: payload['dat.com']?.cookies?.length || 0
    });

    return res.json(payload);
  } catch (error) {
    console.error('[COOKIE] Get active error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function setCookieWorking(req, res) {
  try {
    const cookie = await Cookie.findById(req.params.id);
    if (!cookie) {
      return res.status(404).json({ message: 'Cookie not found' });
    }

    cookie.isWorking = req.body?.isWorking === true || req.body?.isWorking === 'true';
    await cookie.save();
    // Toggling working is the admin acknowledging this cookie — clear its logout alert.
    try {
      require('../services/sessionAlerts').clear(String(cookie._id));
    } catch {
      // ignore
    }

    const safe = cookie.toObject();
    delete safe.data;

    return res.json({
      cookie: safe,
      message: `Cookie marked as ${cookie.isWorking ? 'working' : 'not working'}`
    });
  } catch (error) {
    console.error('[COOKIE] setWorking error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function queueSessionRefresh(filter, { req = null, meta = {} } = {}) {
  const result = await User.updateMany(filter, { $inc: { datSessionPush: 1 } });
  const count = result.modifiedCount || 0;
  await logActivity({
    userId: req?.user?.userId || null,
    actorEmail: req?.user?.email || '',
    action: 'admin.session_push',
    category: 'admin',
    status: 'success',
    message: `Queued DAT session refresh for ${count} account(s)`,
    meta: { ...meta, count },
    req
  });
  return { count };
}

async function pushSession(req, res) {
  try {
    const scope = String(req.body?.scope || '').trim();
    const filter = {};

    if (scope === 'user') {
      const userId = String(req.body?.userId || '').trim();
      if (!mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ message: 'Choose a user to refresh.' });
      }
      filter._id = userId;
    } else if (scope === 'all') {
      // every account
    } else if (scope === 'label') {
      const label = String(req.body?.label || '').trim();
      if (label === 'none') {
        filter.$or = [{ label: '' }, { label: null }, { label: { $exists: false } }];
      } else if (!label) {
        return res.status(400).json({ message: 'Choose a label to refresh.' });
      } else {
        filter.label = label;
      }
    } else if (scope === 'plan') {
      const plan = String(req.body?.plan || '').trim().toLowerCase();
      if (plan !== 'single' && plan !== 'double' && plan !== 'multi') {
        return res.status(400).json({ message: 'Choose a plan to refresh.' });
      }
      Object.assign(filter, userQueryForCookieChannel(plan));
    } else {
      return res.status(400).json({ message: 'Choose who should get the refreshed session.' });
    }

    const { count } = await queueSessionRefresh(filter, {
      req,
      meta: { scope, userId: req.body?.userId || null, label: req.body?.label || null, plan: req.body?.plan || null }
    });

    return res.json({
      count,
      message:
        count > 0
          ? `Session refresh queued for ${count} account${count === 1 ? '' : 's'}. They will apply it the next time they open DAT.`
          : 'No accounts matched that selection.'
    });
  } catch (error) {
    console.error('[COOKIE] Push session error:', error);
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
}

module.exports = {
  listCookies,
  uploadCookie,
  activateCookie,
  deactivateCookie,
  deleteCookie,
  getActiveCookieForUser,
  setCookieWorking,
  pushSession,
  syncCookie
};
