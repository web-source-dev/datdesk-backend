const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getUserDetail,
  listUserEmailAccounts,
  listAccountSentEmails,
  listUserSentEmails,
  getSentEmail,
  listAllSentEmails,
  listMailboxMessages,
  getMailboxMessage,
  fetchLifetimeEmails,
  listActivity,
  listUserActivity,
  listAllEmailAccounts
} = require('../controllers/adminEmailController');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

router.get('/activity', listActivity);
router.get('/email/accounts', listAllEmailAccounts);
router.get('/email/sent', listAllSentEmails);
router.get('/email/sent/:id', getSentEmail);
router.get('/mailbox/:id', getMailboxMessage);

router.get('/users/:userId', getUserDetail);
router.get('/users/:userId/activity', listUserActivity);
router.get('/users/:userId/email-accounts', listUserEmailAccounts);
router.get('/users/:userId/sent', listUserSentEmails);
router.get('/users/:userId/email-accounts/:accountId/sent', listAccountSentEmails);
router.get('/users/:userId/email-accounts/:accountId/mailbox', listMailboxMessages);
router.post('/users/:userId/email-accounts/:accountId/fetch-lifetime', fetchLifetimeEmails);

module.exports = router;
