const express = require('express');
const multer = require('multer');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  listExtensions,
  listEnabledForUser,
  uploadExtension,
  updateExtension,
  deleteExtension,
  downloadExtension
} = require('../controllers/extensionController');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.zip$/i.test(file.originalname || '') ||
      file.mimetype === 'application/zip' ||
      file.mimetype === 'application/x-zip-compressed' ||
      file.mimetype === 'application/octet-stream';
    if (ok) return cb(null, true);
    cb(new Error('Only .zip files are allowed'));
  }
});

router.get('/for-me', authenticateToken, listEnabledForUser);
router.get('/', authenticateToken, requireAdmin, listExtensions);
router.post(
  '/upload',
  authenticateToken,
  requireAdmin,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message || 'Upload failed' });
      next();
    });
  },
  uploadExtension
);
router.put('/:id', authenticateToken, requireAdmin, updateExtension);
router.delete('/:id', authenticateToken, requireAdmin, deleteExtension);
router.get('/:id/download', authenticateToken, downloadExtension);

module.exports = router;
