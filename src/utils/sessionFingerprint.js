'use strict';

/**
 * Compare DAT session payloads ({ "dat.com": { cookies, localStorage, sessionStorage } }).
 *
 * Analytics / bot-protection cookies (Datadog, Cloudflare, Hotjar, Segment…) change
 * on every page view and say nothing about the DAT login, so they are left out of the
 * fingerprint and the diff — otherwise every session would always look "changed".
 */

const crypto = require('crypto');

const VOLATILE_COOKIE = /^(_dd_s|__cf_bm|_cfuvid|cf_clearance|_hj|_ga|_gid|_gcl|_uet|_fbp|ajs_|amplitude|mp_|intercom-|AWSALB)/i;

/** Auth0 login cookies on login.dat.com: their expiry moves forward when DAT renews the session. */
const AUTH_COOKIE = /^auth0(_compat)?$/i;

function cookiesOf(payload) {
  const list = payload?.['dat.com']?.cookies || payload?.cookies;
  return Array.isArray(list) ? list.filter((c) => c && c.name) : [];
}

function cookieKey(c) {
  return `${c.name}@${String(c.domain || '').toLowerCase()}${c.path || '/'}`;
}

/** Expiry in epoch seconds (exports sometimes use milliseconds). */
function expirySeconds(c) {
  const raw = Number(c?.expirationDate);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 2e9 ? raw / 1000 : raw;
}

function sessionCookies(payload) {
  return cookiesOf(payload).filter((c) => !VOLATILE_COOKIE.test(c.name));
}

/** Stable hash of the login-relevant cookies (name, domain, path, value). '' when there are none. */
function sessionFingerprint(payload) {
  const lines = sessionCookies(payload)
    .map((c) => `${cookieKey(c)}=${c.value || ''}`)
    .sort();
  if (!lines.length) return '';
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** Latest expiry of the Auth0 login cookies, as a Date — how "fresh" the login is. Null if none. */
function authExpiresAt(payload) {
  let best = null;
  for (const c of cookiesOf(payload)) {
    if (!AUTH_COOKIE.test(c.name)) continue;
    const exp = expirySeconds(c);
    if (exp && (!best || exp > best)) best = exp;
  }
  return best ? new Date(Math.round(best * 1000)) : null;
}

/**
 * Which login-relevant cookies differ between two payloads (by name@domain/path).
 * A cookie whose value is the same but whose expiry moved by over a minute counts as renewed.
 */
function diffSessions(before, after) {
  const map = (payload) => new Map(sessionCookies(payload).map((c) => [cookieKey(c), c]));
  const a = map(before);
  const b = map(after);
  const added = [];
  const removed = [];
  const changed = [];
  const renewed = [];
  for (const [key, c] of b) {
    const old = a.get(key);
    if (!old) added.push(c.name);
    else if ((old.value || '') !== (c.value || '')) changed.push(c.name);
    else {
      const e1 = expirySeconds(old);
      const e2 = expirySeconds(c);
      if (e1 && e2 && Math.abs(e2 - e1) > 60) renewed.push(c.name);
    }
  }
  for (const [key, c] of a) if (!b.has(key)) removed.push(c.name);
  return {
    added,
    removed,
    changed,
    renewed,
    total: added.length + removed.length + changed.length + renewed.length
  };
}

module.exports = {
  sessionFingerprint,
  authExpiresAt,
  diffSessions,
  sessionCookies
};
