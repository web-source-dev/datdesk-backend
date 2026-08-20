'use strict';

/**
 * CORS origin policy for NEWDATAPP backend.
 *
 * Always allows:
 * - *.apexskillzone.com / apexskillzone.com
 * - *.rtnglobal.* / rtnglobal.* (e.g. rtnglobal.co, rtnglobal.com)
 * - localhost / 127.0.0.1 (any port)
 *
 * ALLOWED_ORIGIN:
 * - unset / * → allow all origins
 * - comma list → those origins as well (plus the domain rules above)
 */

const BUILTIN_ORIGINS = [
  'https://datdeskadmin.apexskillzone.com',
  'https://datdesk.apexskillzone.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001'
];

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

  if (host === 'localhost' || host === '127.0.0.1') return true;

  if (host === 'apexskillzone.com' || host.endsWith('.apexskillzone.com')) {
    return true;
  }

  // rtnglobal.co / rtnglobal.com / any subdomain
  if (
    host === 'rtnglobal.co' ||
    host.endsWith('.rtnglobal.co') ||
    host === 'rtnglobal.com' ||
    host.endsWith('.rtnglobal.com')
  ) {
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

function createCorsOptions() {
  const allowed = parseAllowedOrigins();

  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin, allowed)) {
        return callback(null, true);
      }
      console.warn('[CORS] Blocked origin:', origin);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin'
    ],
    exposedHeaders: ['Content-Type'],
    maxAge: 86400,
    optionsSuccessStatus: 204
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
}

module.exports = {
  BUILTIN_ORIGINS,
  parseAllowedOrigins,
  hostnameAllowed,
  isOriginAllowed,
  createCorsOptions,
  applyCorsHeaders
};
