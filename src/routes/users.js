const express = require('express');
const {
  listUsers,
  createUser,
  updateUser,
  deleteUser
} = require('../controllers/userController');
const {
  getMyProxy,
  updateMyProxy,
  deleteMyProxy,
  unlockProxyPanel
} = require('../controllers/userProxyController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/** Staff custom proxy (Ctrl+Shift+P) — any authenticated user */
router.get('/proxy', authenticateToken, getMyProxy);
router.put('/proxy', authenticateToken, updateMyProxy);
router.delete('/proxy', authenticateToken, deleteMyProxy);
router.post('/proxy/unlock', authenticateToken, unlockProxyPanel);

/** Admin user CRUD */
router.get('/', authenticateToken, requireAdmin, listUsers);
router.post('/', authenticateToken, requireAdmin, createUser);
router.put('/:id', authenticateToken, requireAdmin, updateUser);
router.delete('/:id', authenticateToken, requireAdmin, deleteUser);

module.exports = router;
