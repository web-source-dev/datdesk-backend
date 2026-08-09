const express = require('express');
const {
  getStatus,
  connectAppPassword,
  connectSmtp,
  disconnect,
  setDefaultAccount,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  sendEmail,
  getOAuthUrl,
  oauthCallback
} = require('../controllers/emailController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/oauth/callback', oauthCallback);

router.get('/status', authenticateToken, getStatus);
router.post('/connect/app-password', authenticateToken, connectAppPassword);
router.post('/connect/smtp', authenticateToken, connectSmtp);
router.post('/disconnect', authenticateToken, disconnect);
router.post('/accounts/default', authenticateToken, setDefaultAccount);
router.get('/oauth/url', authenticateToken, getOAuthUrl);

router.get('/templates', authenticateToken, listTemplates);
router.post('/templates', authenticateToken, createTemplate);
router.put('/templates/:id', authenticateToken, updateTemplate);
router.delete('/templates/:id', authenticateToken, deleteTemplate);

router.post('/send', authenticateToken, sendEmail);

module.exports = router;
