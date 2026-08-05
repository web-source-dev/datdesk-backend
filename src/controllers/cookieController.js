const fs = require('fs');
const Cookie = require('../models/Cookie');
const User = require('../models/User');
const {
  countCookiesInData,
  normalizeCookiePayload,
  resolveCookieForUser
} = require('../utils/cookies');
const {
  isValidCookieChannel,
  normalizeCookieChannel,
  getActiveFieldForChannel,
  CHANNEL_LABELS,
  COOKIE_CHANNELS
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

    const cookie = await Cookie.create({
      fileName,
      data: normalized,
      filePath: '',
      cookieCount,
      hasCookies: cookieCount > 0,
      fileSize,
      note: req.body.note || '',
      isActive: false,
      isActiveSingle: false,
      isActiveDouble: false,
      isActiveMulti: false,
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

    const channel = normalizeCookieChannel(req.body.channel || 'single');
    if (!isValidCookieChannel(channel)) {
      return res.status(400).json({ message: 'Invalid channel. Use single, double, multi, or test.' });
    }

    const activeField = getActiveFieldForChannel(channel);

    await Cookie.updateMany(
      { _id: { $ne: cookie._id } },
      { $set: { [activeField]: false, ...(channel === 'single' ? { isActive: false } : {}) } }
    );

    cookie[activeField] = true;
    if (channel === 'single') cookie.isActive = true;
    await cookie.save();

    const safe = cookie.toObject();
    delete safe.data;

    return res.json({
      cookie: safe,
      channel,
      message: `Cookie activated for ${CHANNEL_LABELS[channel] || channel}`
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

    const channel = normalizeCookieChannel(req.body.channel || 'single');
    if (!isValidCookieChannel(channel)) {
      return res.status(400).json({ message: 'Invalid channel. Use single, double, multi, or test.' });
    }

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

async function getActiveCookieForUser(req, res) {
  try {
    const user = await User.findById(req.user.userId).populate('assignedCookieId');
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const resolved = await resolveCookieForUser(user);
    if (!resolved.data) {
      return res.json({
        'dat.com': { cookies: [], localStorage: {}, sessionStorage: {} },
        source: null,
        channel: resolved.channel
      });
    }

    return res.json({
      'dat.com': resolved.data['dat.com'] || {
        cookies: [],
        localStorage: {},
        sessionStorage: {}
      },
      source: resolved.source,
      channel: resolved.channel,
      cookieId: resolved.cookieDoc?._id || null,
      fileName: resolved.cookieDoc?.fileName || null
    });
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

module.exports = {
  listCookies,
  uploadCookie,
  activateCookie,
  deactivateCookie,
  deleteCookie,
  getActiveCookieForUser,
  setCookieWorking
};
