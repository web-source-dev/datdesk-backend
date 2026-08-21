const User = require('../models/User');
const { verifyToken } = require('../utils/jwt');

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
      payload = verifyToken(token);
    } catch {
      return res.status(401).json({
        message: 'Please sign in again.',
        code: 'INVALID_TOKEN'
      });
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
