const express = require('express');
const router = express.Router();
const {
  checkUpdate,
  downloadUpdate,
  getUpdateFeed,
  getUpdateConfig,
  setUpdateConfig
} = require('../controllers/updateController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

router.get('/check', checkUpdate);
router.get('/feed', getUpdateFeed);
router.get('/feed/latest.yml', getUpdateFeed);

router.get('/config', authenticateToken, requireAdmin, getUpdateConfig);
router.put('/config/:app', authenticateToken, requireAdmin, setUpdateConfig);

router.get('/download/:app/:platform/:fileName', downloadUpdate);
router.get('/download/:platform/:fileName', downloadUpdate);

module.exports = router;
