'use strict';

/** Shared upload cap for extension ZIPs, cookies, and other multipart posts. */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 50 * 1024 * 1024;
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

function isTooLargeError(err) {
  if (!err) return false;
  return (
    err.status === 413 ||
    err.statusCode === 413 ||
    err.code === 'LIMIT_FILE_SIZE' ||
    err.type === 'entity.too.large'
  );
}

function tooLargeMessage() {
  return `Upload is too large. Maximum size is ${MAX_UPLOAD_MB}MB.`;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  isTooLargeError,
  tooLargeMessage
};
