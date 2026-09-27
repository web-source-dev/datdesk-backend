const express = require('express');
const {
  listProxies,
  createProxy,
  updateProxy,
  deleteProxy,
  updateProxySettings,
  getResolvedProxy,
  getFailoverProxy,
  confirmFailoverProxy
} = require('../controllers/proxyController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Desktop / any auth user: get my effective proxy
router.get('/resolved', authenticateToken, getResolvedProxy);
// Desktop: my proxy is down → offer a working one; confirm once it reached DAT
router.post('/failover', authenticateToken, getFailoverProxy);
router.post('/failover/confirm', authenticateToken, confirmFailoverProxy);

router.get('/', authenticateToken, requireAdmin, listProxies);
router.post('/', authenticateToken, requireAdmin, createProxy);
router.put('/settings', authenticateToken, requireAdmin, updateProxySettings);
router.put('/:id', authenticateToken, requireAdmin, updateProxy);
router.delete('/:id', authenticateToken, requireAdmin, deleteProxy);

module.exports = router;
