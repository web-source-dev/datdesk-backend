const SWIFT_SOLUTIONS_LABEL = 'swiftSolutions';

/**
 * Requires X-Partner-Key header matching SWIFT_SOLUTIONS_PARTNER_KEY env.
 */
function requirePartnerKey(req, res, next) {
  const partnerKey = process.env.SWIFT_SOLUTIONS_PARTNER_KEY;
  if (!partnerKey) {
    return res.status(503).json({
      message: 'Swift Solutions partner API is not configured on the server'
    });
  }

  const provided = req.headers['x-partner-key'];
  if (!provided || provided !== partnerKey) {
    return res.status(401).json({ message: 'Invalid partner key' });
  }

  next();
}

/**
 * After authenticateToken: admin role required for partner dashboard.
 */
function requirePartnerAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }

  next();
}

/**
 * Swift Solutions–labeled admins see masked slot names only (Account 1, Account 2, …).
 */
function shouldMaskPartnerSessionNames(label) {
  return String(label || '').trim() === SWIFT_SOLUTIONS_LABEL;
}

module.exports = {
  SWIFT_SOLUTIONS_LABEL,
  requirePartnerKey,
  requirePartnerAdmin,
  shouldMaskPartnerSessionNames
};
