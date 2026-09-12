'use strict';

/**
 * Strong ETag for GET /cookie/active.
 * Based on the resolved cookie document identity + size + update time so
 * clients can send If-None-Match and receive 304 without the JSON blob.
 */

function normalizeEtag(value) {
  return String(value || '')
    .trim()
    .replace(/^W\//i, '')
    .trim()
    .replace(/^"/, '')
    .replace(/"$/, '');
}

function quoteEtag(value) {
  const token = normalizeEtag(value);
  if (!token) return '';
  return `"${token}"`;
}

function cookiePayloadEtag(cookieDoc, channel) {
  if (!cookieDoc?._id) {
    return quoteEtag(`empty-${channel || 'none'}`);
  }
  const ts = new Date(cookieDoc.updatedAt || cookieDoc.lastUpdated || 0).getTime() || 0;
  const size = Number(cookieDoc.fileSize) || 0;
  return quoteEtag(`${cookieDoc._id}-${ts}-${size}`);
}

function etagsMatch(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const want = normalizeEtag(etag);
  if (!want) return false;
  return String(ifNoneMatch)
    .split(',')
    .map((part) => normalizeEtag(part))
    .some((part) => part === '*' || part === want);
}

function setCookieRevalidateHeaders(res, etag) {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
}

module.exports = {
  normalizeEtag,
  quoteEtag,
  cookiePayloadEtag,
  etagsMatch,
  setCookieRevalidateHeaders
};
