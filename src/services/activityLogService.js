const ActivityLog = require('../models/ActivityLog');

function clientIp(req) {
  if (!req) return '';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return String(req.ip || req.socket?.remoteAddress || '').trim();
}

function clientUa(req) {
  if (!req) return '';
  return String(req.headers?.['user-agent'] || '').slice(0, 500);
}

/**
 * Fire-and-forget activity write. Never throws to callers.
 */
async function logActivity({
  userId = null,
  actorEmail = '',
  action,
  category = 'other',
  status = 'success',
  message = '',
  meta = null,
  req = null,
  ip = '',
  userAgent = ''
} = {}) {
  try {
    if (!action) return null;
    const doc = await ActivityLog.create({
      userId: userId || null,
      actorEmail: String(actorEmail || '')
        .trim()
        .toLowerCase(),
      action: String(action).trim(),
      category,
      status,
      message: String(message || '').slice(0, 1000),
      meta: meta && typeof meta === 'object' ? meta : null,
      ip: ip || clientIp(req),
      userAgent: userAgent || clientUa(req)
    });
    return doc;
  } catch (err) {
    console.warn('[activity] failed to write log:', err?.message || err);
    return null;
  }
}

module.exports = {
  logActivity,
  clientIp,
  clientUa
};
