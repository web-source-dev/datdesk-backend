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
const {
  getOverview,
  listLoads,
  getLoad,
  updateLoad,
  listContacts,
  updateContact,
  processEmails,
  listFreightEmployees,
  getSyncStatus,
  runSyncNow,
  updateSyncAccount
} = require('../controllers/adminFreightController');

const router = express.Router();

router.use(authenticateToken, requireAdmin);

router.get('/activity', listActivity);
router.get('/email/accounts', listAllEmailAccounts);
router.get('/email/sent', listAllSentEmails);
router.get('/email/sent/:id', getSentEmail);
router.get('/mailbox/:id', getMailboxMessage);

router.get('/freight/overview', getOverview);
router.get('/freight/loads', listLoads);
router.get('/freight/loads/:id', getLoad);
router.patch('/freight/loads/:id', updateLoad);
router.get('/freight/contacts', listContacts);
router.patch('/freight/contacts/:id', updateContact);
router.post('/freight/process', processEmails);
router.get('/freight/employees', listFreightEmployees);
router.get('/freight/sync/status', getSyncStatus);
router.post('/freight/sync/run', runSyncNow);
router.patch('/freight/sync/accounts/:accountId', updateSyncAccount);

router.get('/users/:userId', getUserDetail);
router.get('/users/:userId/activity', listUserActivity);
router.get('/users/:userId/email-accounts', listUserEmailAccounts);
router.get('/users/:userId/sent', listUserSentEmails);
router.get('/users/:userId/email-accounts/:accountId/sent', listAccountSentEmails);
router.get('/users/:userId/email-accounts/:accountId/mailbox', listMailboxMessages);
router.post('/users/:userId/email-accounts/:accountId/fetch-lifetime', fetchLifetimeEmails);

module.exports = router;
