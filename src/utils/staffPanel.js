'use strict';

const crypto = require('crypto');

/**
 * Staff panel password (proxy Ctrl+Shift+P, server Ctrl+Shift+S).
 * Checked only on the backend — desktop never compares locally.
 */
function getExpectedStaffPanelPassword() {
  return String(
    process.env.SERVER_PANEL_PASSWORD ||
      process.env.PROXY_PANEL_PASSWORD ||
      'Horizon@Proxy#2026'
  );
}

function verifyStaffPanelPassword(provided) {
  const expected = getExpectedStaffPanelPassword();
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(String(provided || ''));
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = {
  getExpectedStaffPanelPassword,
  verifyStaffPanelPassword
};
