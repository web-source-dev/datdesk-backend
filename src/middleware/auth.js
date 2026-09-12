const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { verifyToken } = require('../utils/jwt');

const PUBLIC_API = String(process.env.PUBLIC_API_URL || 'https://api.datdesk.apexskillzone.com').replace(
  /\/+$/,
  ''
);

const AUTH_HOP_HEADER = 'x-datdesk-auth-hop';

function isExpiredTokenError(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || err || '');
  return name === 'TokenExpiredError' || /expired/i.test(message);
}

function requestPath(req) {
  return String(req?.originalUrl || req?.url || '').split('?')[0];
}

function isAuthProbePath(req) {
  const path = requestPath(req);
  return path === '/email/status' || path.endsWith('/email/status');
}

function incomingHostname(req) {
  const forwarded = String(req?.get?.('x-forwarded-host') || '')
    .split(',')[0]
    .trim();
  const host = forwarded || String(req?.get?.('host') || '');
  return host.split(':')[0].toLowerCase();
}

function publicApiIsSelf(req) {
  try {
    const pubHost = new URL(PUBLIC_API).hostname.toLowerCase();
    const incoming = incomingHostname(req);
    if (!pubHost || !incoming) return false;
    return pubHost === incoming || pubHost === 'localhost' || incoming === 'localhost';
  } catch {
    return false;
  }
}

function shouldSkipPublicFallback(req) {
  if (!req) return true;
  if (String(req.headers?.[AUTH_HOP_HEADER] || '') === '1') return true;
  if (isAuthProbePath(req)) return true;
  if (publicApiIsSelf(req)) return true;
  return false;
}

async function payloadFromPublicApi(token, req) {
  if (shouldSkipPublicFallback(req)) return null;

  const authHeader = String(token || '').trim();
  if (!authHeader) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${PUBLIC_API}/email/status`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'X-Datdesk-Auth-Hop': '1'
      },
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    const raw = authHeader.replace(/^Bearer\s+/i, '');
    const decoded = jwt.decode(raw);
    if (!decoded || !decoded.userId) return null;
    return decoded;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function authenticateToken(req, res, next) {
  try {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({
        message: 'Please sign in again.',
        code: 'NO_TOKEN'
      });
    }

    let payload;
    try {
      payload = verifyToken(String(token).replace(/^Bearer\s+/i, ''));
    } catch (jwtErr) {
      if (isExpiredTokenError(jwtErr)) {
        return res.status(401).json({
          message: 'Your session expired. Please sign in again.',
          code: 'TOKEN_EXPIRED'
        });
      }

      payload = await payloadFromPublicApi(token, req);
      if (!payload) {
        return res.status(401).json({
          message: 'Please sign in again.',
          code: 'INVALID_TOKEN'
        });
      }
    }

    const user = await User.findById(payload.userId).select(
      'activeSessionId isBanned role email permissions'
    );
    if (!user) {
      return res.status(401).json({
        message: 'Please sign in again.',
        code: 'USER_NOT_FOUND'
      });
    }

    if (user.isBanned) {
      return res.status(403).json({
        message: 'Account is banned',
        isBanned: true,
        code: 'BANNED'
      });
    }

    // Single-session login: only the latest login stays valid
    if (!payload.sessionId || !user.activeSessionId || payload.sessionId !== user.activeSessionId) {
      return res.status(401).json({
        message: 'You were signed out because your account signed in on another device.',
        code: 'SESSION_REPLACED'
      });
    }

    req.user = {
      userId: payload.userId,
      email: payload.email || user.email,
      role: payload.role || user.role,
      sessionId: payload.sessionId,
      permissions: user.permissions || null
    };
    next();
  } catch (error) {
    console.error('[AUTH] Authentication error:', error);
    return res.status(401).json({
      message: 'Please sign in again.',
      code: 'AUTH_FAILED'
    });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

module.exports = { authenticateToken, requireAdmin };
