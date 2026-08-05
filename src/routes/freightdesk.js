'use strict';

const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getStatus,
  listSessions,
  importContainer,
  importAllContainers,
  activateImportedCookie,
  updateContainerLabel,
  setWorkingStatus
} = require('../controllers/freightdeskController');

const router = express.Router();

router.get('/status', authenticateToken, requireAdmin, getStatus);
router.get('/sessions', authenticateToken, requireAdmin, listSessions);
router.post('/import-all', authenticateToken, requireAdmin, importAllContainers);
router.patch('/label/:container', authenticateToken, requireAdmin, updateContainerLabel);
router.patch('/working/:container', authenticateToken, requireAdmin, setWorkingStatus);
router.post('/import/:container', authenticateToken, requireAdmin, importContainer);
router.post('/activate/:container', authenticateToken, requireAdmin, activateImportedCookie);

module.exports = router;
