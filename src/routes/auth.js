const express = require('express');
const { login, checkSession, staffUnlock } = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', login);
router.post('/check-session', authenticateToken, checkSession);
router.post('/staff-unlock', staffUnlock);

module.exports = router;
