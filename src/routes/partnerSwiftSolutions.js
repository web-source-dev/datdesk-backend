const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  requirePartnerKey,
  requirePartnerAdmin
} = require('../middleware/partnerSwiftSolutions');
const {
  partnerLogin,
  listUsers,
  createUser,
  updateUser,
  listExtensionAccounts,
  activateExtensionAccount
} = require('../controllers/partnerSwiftSolutionsController');

router.use(requirePartnerKey);

router.post('/auth/login', partnerLogin);

router.use(authenticateToken, requirePartnerAdmin);

router.get('/users', listUsers);
router.post('/users', createUser);
router.put('/users/:id', updateUser);

router.get('/extension-accounts', listExtensionAccounts);
router.post('/extension-accounts/:slot/activate', activateExtensionAccount);

module.exports = router;
