const User = require('../models/User');
const { generateToken, createSessionId } = require('../utils/jwt');
const { verifyPassword } = require('../utils/password');
const { enrichUser } = require('./userController');
const { verifyStaffPanelPassword } = require('../utils/staffPanel');
const { logActivity } = require('../services/activityLogService');

async function login(req, res) {
  const emailRaw = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+password')
      .populate('proxyId')
      .populate('assignedCookieId');
    if (!user) {
      await logActivity({
        actorEmail: emailRaw,
        action: 'auth.login',
        category: 'auth',
        status: 'failure',
        message: 'Login failed: user not found',
        req
      });
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.isBanned) {
      await logActivity({
        userId: user._id,
        actorEmail: user.email,
        action: 'auth.login',
        category: 'auth',
        status: 'failure',
        message: 'Login blocked: account banned',
        req
      });
      return res.status(403).json({ message: 'Account is banned', isBanned: true });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      await logActivity({
        userId: user._id,
        actorEmail: user.email,
        action: 'auth.login',
        category: 'auth',
        status: 'failure',
        message: 'Login failed: invalid password',
        req
      });
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Desktop/admin login rotates the session (one device). The email extension
    // reuses the active session so signing in there does not kick the desk app.
    const reuseSession =
      req.body?.reuseSession === true || String(req.body?.client || '') === 'extension';
    let sessionId = reuseSession ? user.activeSessionId : null;
    if (!sessionId) {
      sessionId = createSessionId();
      user.activeSessionId = sessionId;
      await user.save({ validateBeforeSave: false });
    }

    const token = generateToken(user, sessionId);
    const enriched = await enrichUser(user);

    await logActivity({
      userId: user._id,
      actorEmail: user.email,
      action: 'auth.login',
      category: 'auth',
      status: 'success',
      message: `User logged in (${user.role})`,
      meta: { role: user.role, sessionId },
      req
    });

    return res.json({
      ...enriched,
      token
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    await logActivity({
      actorEmail: emailRaw,
      action: 'auth.login',
      category: 'auth',
      status: 'failure',
      message: error.message || 'Internal login error',
      req
    });
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function checkSession(req, res) {
  try {
    const user = await User.findById(req.user.userId)
      .populate('proxyId')
      .populate('assignedCookieId');
    if (!user) {
      return res.status(401).json({
        message: 'Please sign in again.',
        code: 'USER_NOT_FOUND'
      });
    }
    if (user.isBanned) {
      return res.status(403).json({ message: 'Account is banned', isBanned: true });
    }
    return res.json(await enrichUser(user));
  } catch (error) {
    console.error('[AUTH] Check session error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

/**
 * POST /auth/staff-unlock
 * No login required — used by proxy + custom-server panels.
 * Password must match backend SERVER_PANEL_PASSWORD / PROXY_PANEL_PASSWORD.
 */
async function staffUnlock(req, res) {
  try {
    if (!verifyStaffPanelPassword(req.body?.password)) {
      await logActivity({
        action: 'auth.staff_unlock',
        category: 'auth',
        status: 'failure',
        message: 'Staff panel unlock failed',
        req
      });
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }
    await logActivity({
      action: 'auth.staff_unlock',
      category: 'auth',
      status: 'success',
      message: 'Staff panel unlocked',
      req
    });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to verify' });
  }
}

module.exports = { login, checkSession, staffUnlock };
