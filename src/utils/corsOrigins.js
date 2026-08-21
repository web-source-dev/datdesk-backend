'use strict';

/**
 * CORS origin policy for NEWDATAPP backend.
 *
 * Always allows:
 * - *.apexskillzone.com / apexskillzone.com
 * - *.rtnglobal.* / rtnglobal.* (any TLD, e.g. swift.rtnglobal.co)
 * - localhost / 127.0.0.1 / ::1 (any port)
 *
 * ALLOWED_ORIGIN:
 * - unset / * → allow all origins
 * - comma list → those origins as well (plus the domain rules above)
 */

const BUILTIN_ORIGINS = [
  'https://datdeskadmin.apexskillzone.com',
  'https://datdesk.apexskillzone.com',
  'https://swift.rtnglobal.co',
  'https://freightdesk.rtnglobal.co',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001'
];

const CORS_ALLOW_HEADERS = [
  'Accept',
  'Authorization',
  'Content-Type',
  'Origin',
  'X-Requested-With',
  'X-Partner-Key',
  'X-CSRF-Token'
];

const CORS_ALLOW_HEADERS_VALUE = CORS_ALLOW_HEADERS.join(', ');

function parseAllowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGIN || '').trim();
  if (!raw || raw === '*') return null;

  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return [...new Set([...fromEnv, ...BUILTIN_ORIGINS])];
}

function hostnameAllowed(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');

  if (!host) return false;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  ) {
    return true;
  }

  if (host === 'apexskillzone.com' || host.endsWith('.apexskillzone.com')) {
    return true;
  }

  // rtnglobal.co, rtnglobal.com, swift.rtnglobal.co, partner.rtnglobal.net, …
  if (host === 'rtnglobal' || host.startsWith('rtnglobal.') || host.includes('.rtnglobal.')) {
    return true;
  }

  return false;
}

function isOriginAllowed(origin, allowedList) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    if (hostnameAllowed(url.hostname)) return true;
  } catch {
    // fall through to exact list match
  }

  // ALLOWED_ORIGIN=* / unset
  if (!allowedList) return true;

  return allowedList.includes(origin);
}

function allowHeadersForRequest(req) {
  const requested = String(req?.headers?.['access-control-request-headers'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!requested.length) return CORS_ALLOW_HEADERS_VALUE;
  return [...new Set([...CORS_ALLOW_HEADERS, ...requested])].join(', ');
}

function createCorsOptions() {
  const allowed = parseAllowedOrigins();

  return function corsDelegate(req, callback) {
    const origin = req.headers.origin;
    callback(null, {
      origin: isOriginAllowed(origin, allowed),
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: allowHeadersForRequest(req),
      exposedHeaders: ['Content-Type'],
      maxAge: 86400,
      optionsSuccessStatus: 204
    });
  };
}

/** Attach CORS headers on responses that bypass the cors package. */
function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = parseAllowedOrigins();
  if (!isOriginAllowed(origin, allowed)) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader('Access-Control-Allow-Headers', allowHeadersForRequest(req));
}

module.exports = {
  BUILTIN_ORIGINS,
  CORS_ALLOW_HEADERS,
  parseAllowedOrigins,
  hostnameAllowed,
  isOriginAllowed,
  createCorsOptions,
  applyCorsHeaders
};
