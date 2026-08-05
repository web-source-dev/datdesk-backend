const User = require('../models/User');
const { generateToken, createSessionId } = require('../utils/jwt');
const { verifyPassword } = require('../utils/password');
const { enrichUser } = require('./userController');

async function login(req, res) {
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
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.isBanned) {
      return res.status(403).json({ message: 'Account is banned', isBanned: true });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // New login creates a new session and invalidates any previous device
    const sessionId = createSessionId();
    user.activeSessionId = sessionId;
    await user.save({ validateBeforeSave: false });

    const token = generateToken(user, sessionId);
    const enriched = await enrichUser(user);

    return res.json({
      ...enriched,
      token
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
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

module.exports = { login, checkSession };
