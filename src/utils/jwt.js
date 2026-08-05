const jwt = require('jsonwebtoken');
const crypto = require('crypto');

function createSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function generateToken(user, sessionId) {
  const sid = sessionId || user.activeSessionId || createSessionId();
  return jwt.sign(
    {
      userId: user._id || user.id,
      email: user.email,
      role: user.role,
      sessionId: sid
    },
    process.env.JWT_SECRET || 'default-secret-change-this',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'default-secret-change-this');
  } catch (error) {
    if (error.name === 'TokenExpiredError') throw new Error('Token expired');
    if (error.name === 'JsonWebTokenError') throw new Error('Invalid token');
    throw new Error('Token verification failed');
  }
}

module.exports = { generateToken, verifyToken, createSessionId };
