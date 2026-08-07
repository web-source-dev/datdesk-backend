const fs = require('fs');
const path = require('path');
const Cookie = require('../models/Cookie');
const {
  getCookieChannelForUser,
  getActiveFieldForChannel
} = require('./cookieChannels');

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');
const COOKIES_DIR = path.join(UPLOADS_DIR, 'cookies');

function ensureCookiesDir() {
  // No longer required for serving; kept so legacy migration can read old files.
  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
  }
}

function countCookiesInData(data) {
  if (!data || typeof data !== 'object') return 0;
  if (Array.isArray(data.cookies)) return data.cookies.length;
  if (data['dat.com']?.cookies) return data['dat.com'].cookies.length;
  return 0;
}

function normalizeCookiePayload(raw) {
  if (raw?.['dat.com']?.cookies) return raw;

  if (Array.isArray(raw?.cookies)) {
    return {
      'dat.com': {
        cookies: raw.cookies,
        localStorage: raw.localStorage || {},
        sessionStorage: raw.sessionStorage || {}
      }
    };
  }

  if (Array.isArray(raw)) {
    return {
      'dat.com': {
        cookies: raw,
        localStorage: {},
        sessionStorage: {}
      }
    };
  }

  return {
    'dat.com': {
      cookies: [],
      localStorage: {},
      sessionStorage: {}
    }
  };
}

function attachMeta(data, cookieDoc) {
  if (!data) return null;
  const normalized = normalizeCookiePayload(data);
  normalized.hasCookies = (normalized['dat.com']?.cookies?.length || 0) > 0;
  normalized.cookieCount = normalized['dat.com']?.cookies?.length || 0;
  normalized.cookieId = cookieDoc._id;
  normalized.fileName = cookieDoc.fileName;
  return normalized;
}

/**
 * Serve cookie payload from MongoDB.
 * If an old record still has a disk file and no `data`, migrate it into the DB once.
 */
async function readCookieData(cookieDoc) {
  if (!cookieDoc) return null;

  if (cookieDoc.data && typeof cookieDoc.data === 'object') {
    return attachMeta(cookieDoc.data, cookieDoc);
  }

  // Legacy migration: pull once from uploads folder into MongoDB
  if (cookieDoc.filePath && fs.existsSync(cookieDoc.filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cookieDoc.filePath, 'utf8'));
      const normalized = normalizeCookiePayload(parsed);
      const cookieCount = countCookiesInData(normalized);

      cookieDoc.data = normalized;
      cookieDoc.cookieCount = cookieCount;
      cookieDoc.hasCookies = cookieCount > 0;
      cookieDoc.fileSize = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
      if (typeof cookieDoc.save === 'function') {
        await cookieDoc.save();
        console.log('[COOKIE] Migrated disk cookie into DB:', cookieDoc.fileName);
      } else {
        await Cookie.updateOne(
          { _id: cookieDoc._id },
          {
            $set: {
              data: normalized,
              cookieCount,
              hasCookies: cookieCount > 0,
              fileSize: cookieDoc.fileSize
            }
          }
        );
      }

      return attachMeta(normalized, cookieDoc);
    } catch (err) {
      console.error('[COOKIE] Legacy migrate failed:', cookieDoc.filePath, err.message);
      return null;
    }
  }

  console.error('[COOKIE] No data in database for', cookieDoc._id, cookieDoc.fileName);
  return null;
}

/** @deprecated use readCookieData */
function readCookieFile(cookieDoc) {
  if (!cookieDoc?.data) return null;
  return attachMeta(cookieDoc.data, cookieDoc);
}

async function getCookieByChannel(channel) {
  const activeField = getActiveFieldForChannel(channel);
  let active = await Cookie.findOne({ [activeField]: true });

  // Legacy isActive fallback only for plan channels — not Test / Swift Solutions
  if (!active && channel !== 'test' && channel !== 'swiftSolutions') {
    active = await Cookie.findOne({ isActive: true });
  }

  return active;
}

/**
 * Resolve cookie for a user:
 * 1) assignedCookieId (per-user override)
 * 2) channel active cookie (plan/label)
 * Payload always comes from MongoDB `data`.
 */
async function resolveCookieForUser(user) {
  if (!user) {
    return { data: null, source: null, channel: null, cookieDoc: null };
  }

  if (user.assignedCookieId) {
    const assigned =
      typeof user.assignedCookieId === 'object' && user.assignedCookieId._id
        ? user.assignedCookieId
        : await Cookie.findById(user.assignedCookieId);

    if (assigned) {
      const data = await readCookieData(assigned);
      if (data) {
        return {
          data,
          source: 'user',
          channel: getCookieChannelForUser(user),
          cookieDoc: assigned
        };
      }
    }
  }

  const channel = getCookieChannelForUser(user);
  const cookieDoc = await getCookieByChannel(channel);
  const data = await readCookieData(cookieDoc);

  return {
    data,
    source: data ? 'channel' : null,
    channel,
    cookieDoc: cookieDoc || null
  };
}

/** @deprecated use resolveCookieForUser */
async function getActiveCookie() {
  const active = await Cookie.findOne({
    $or: [
      { isActive: true },
      { isActiveSingle: true },
      { isActiveDouble: true },
      { isActiveMulti: true },
      { isActiveSwiftSolutions: true },
      { isActiveTest: true }
    ]
  });
  return readCookieData(active);
}

module.exports = {
  COOKIES_DIR,
  ensureCookiesDir,
  countCookiesInData,
  normalizeCookiePayload,
  getActiveCookie,
  getCookieByChannel,
  resolveCookieForUser,
  readCookieData,
  readCookieFile
};
