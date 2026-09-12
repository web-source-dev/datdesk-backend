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
  generateTemplateAi,
  sendEmail,
  ackClientSend,
  getOAuthUrl,
  getOAuthResult,
  oauthCallback
} = require('../controllers/emailController');
const {
  listInboxAccounts,
  listInboxMessages,
  getInboxMessage,
  syncInboxAccount
} = require('../controllers/inboxController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/oauth/callback', oauthCallback);

router.get('/status', authenticateToken, getStatus);
router.post('/connect/app-password', authenticateToken, connectAppPassword);
router.post('/connect/smtp', authenticateToken, connectSmtp);
router.post('/disconnect', authenticateToken, disconnect);
router.post('/accounts/default', authenticateToken, setDefaultAccount);
router.get('/oauth/url', authenticateToken, getOAuthUrl);
router.get('/oauth/result', authenticateToken, getOAuthResult);

router.get('/templates', authenticateToken, listTemplates);
router.post('/templates/ai', authenticateToken, generateTemplateAi);
router.post('/templates', authenticateToken, createTemplate);
router.put('/templates/:id', authenticateToken, updateTemplate);
router.delete('/templates/:id', authenticateToken, deleteTemplate);

router.post('/send', authenticateToken, sendEmail);
router.post('/send/ack', authenticateToken, ackClientSend);

router.get('/inbox/accounts', authenticateToken, listInboxAccounts);
router.get('/inbox/messages/:id', authenticateToken, getInboxMessage);
router.get('/inbox/:accountId/messages', authenticateToken, listInboxMessages);
router.post('/inbox/:accountId/sync', authenticateToken, syncInboxAccount);

module.exports = router;
