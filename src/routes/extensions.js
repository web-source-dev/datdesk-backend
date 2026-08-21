const express = require('express');
const multer = require('multer');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { MAX_UPLOAD_BYTES, isTooLargeError, tooLargeMessage } = require('../utils/uploadLimits');
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
  limits: { fileSize: MAX_UPLOAD_BYTES },
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
      if (err) {
        const tooLarge = isTooLargeError(err);
        return res.status(tooLarge ? 413 : 400).json({
          message: tooLarge ? tooLargeMessage() : err.message || 'Upload failed'
        });
      }
      next();
    });
  },
  uploadExtension
);
router.put('/:id', authenticateToken, requireAdmin, updateExtension);
router.delete('/:id', authenticateToken, requireAdmin, deleteExtension);
router.get('/:id/download', authenticateToken, downloadExtension);

module.exports = router;
