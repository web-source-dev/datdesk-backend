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
  oauthCallback,
  listUserMailbox,
  listUserConversations,
  getConversationMessages,
  getUserMailboxMessage,
  listUserSentEmails,
  getUserSentEmail,
  syncUserMailbox
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
router.get('/oauth/result', authenticateToken, getOAuthResult);

router.get('/templates', authenticateToken, listTemplates);
router.post('/templates/ai', authenticateToken, generateTemplateAi);
router.post('/templates', authenticateToken, createTemplate);
router.put('/templates/:id', authenticateToken, updateTemplate);
router.delete('/templates/:id', authenticateToken, deleteTemplate);

router.post('/send', authenticateToken, sendEmail);
router.post('/send/ack', authenticateToken, ackClientSend);

router.get('/mailbox', authenticateToken, listUserMailbox);
router.get('/mailbox/:id', authenticateToken, getUserMailboxMessage);
router.post('/mailbox/sync', authenticateToken, syncUserMailbox);
router.get('/conversations', authenticateToken, listUserConversations);
router.get('/conversations/:conversationKey/messages', authenticateToken, getConversationMessages);
router.get('/sent', authenticateToken, listUserSentEmails);
router.get('/sent/:id', authenticateToken, getUserSentEmail);

module.exports = router;
