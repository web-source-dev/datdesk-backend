const express = require('express');
const multer = require('multer');
const path = require('path');
const {
  listCookies,
  uploadCookie,
  activateCookie,
  deactivateCookie,
  deleteCookie,
  getActiveCookieForUser,
  setCookieWorking
} = require('../controllers/cookieController');
const {
  getDashboardConfig,
  updateDashboardConfig
} = require('../controllers/partnerSwiftConfigController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Keep cookie JSON in memory → MongoDB (no uploads/cookies disk write)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.json') {
      return cb(new Error('Only .json cookie files are allowed'));
    }
    cb(null, true);
  }
});

const router = express.Router();

router.get('/active', authenticateToken, getActiveCookieForUser);

router.get(
  '/partner-swift/dashboard-config',
  authenticateToken,
  requireAdmin,
  getDashboardConfig
);
router.put(
  '/partner-swift/dashboard-config',
  authenticateToken,
  requireAdmin,
  updateDashboardConfig
);

router.get('/', authenticateToken, requireAdmin, listCookies);
router.post('/upload', authenticateToken, requireAdmin, upload.single('file'), uploadCookie);
router.post('/:id/activate', authenticateToken, requireAdmin, activateCookie);
router.post('/:id/deactivate', authenticateToken, requireAdmin, deactivateCookie);
router.patch('/:id/working', authenticateToken, requireAdmin, setCookieWorking);
router.delete('/:id', authenticateToken, requireAdmin, deleteCookie);

module.exports = router;
