'use strict';

/**
 * Work out which DAT account (and which browser) a session payload belongs to, so the
 * admin can spot two containers holding the same login.
 *
 *  - Account: DAT's Segment cookie `ajs_user_id` holds the Auth0 user id ("auth0|…"),
 *    identical for every login of the same DAT account. As a fallback, the `sub` claim
 *    of any JWT kept in localStorage / sessionStorage.
 *  - Browser: device ids (`dat_agent_device_id`, Auth0 `did`, Segment anonymous id,
 *    Hotjar user id) are per browser profile. A shared one means the cookies were
 *    exported from the same browser — often, but not always, the same account.
 */

const DEVICE_COOKIES = /^(dat_agent_device_id|did|did_compat|ajs_anonymous_id|_hjSessionUser_\d+)$/;

function storeOf(payload, key) {
  const store = payload?.['dat.com']?.[key] || payload?.[key];
  return store && typeof store === 'object' ? store : {};
}

function cookiesOf(payload) {
  const list = payload?.['dat.com']?.cookies || payload?.cookies;
  return Array.isArray(list) ? list.filter((c) => c && c.name) : [];
}

/** Cookie / storage values may be URL-encoded and JSON-quoted ("%22auth0%7C…%22"). */
function cleanValue(raw) {
  let value = String(raw ?? '').trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep as is */
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      value = value.slice(1, -1);
    }
  }
  return String(value || '').trim();
}

/**
 * DAT/Segment write non-identifying sentinels into ajs_user_id before (or when) the Auth0
 * subject is unknown — e.g. "unknown auth0 subject". Treating one of these as a real
 * account id would merge every such session into one identity and give them all the SAME
 * device fingerprint (its own detection flag). Reject them so resolution falls through to a
 * real token sub, or stays empty and the caller falls back to the per-container seed.
 */
const PLACEHOLDER_ACCOUNT_IDS = new Set([
  'unknown auth0 subject',
  'unknown',
  'anonymous',
  'undefined',
  'null',
  'none',
  ''
]);

function isRealAccountId(value) {
  return !PLACEHOLDER_ACCOUNT_IDS.has(String(value || '').trim().toLowerCase());
}

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[1].startsWith('ey')) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** JWTs found anywhere in a storage value (raw token, or JSON holding id_token / access_token). */
function jwtsIn(value, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') {
    const claims = decodeJwt(value);
    if (claims) return [claims];
    if (value.length > 2 && (value[0] === '{' || value[0] === '[')) {
      try {
        return jwtsIn(JSON.parse(value), depth + 1);
      } catch {
        return [];
      }
    }
    return [];
  }
  if (typeof value === 'object') {
    return Object.values(value).flatMap((v) => jwtsIn(v, depth + 1));
  }
  return [];
}

/** Hotjar's `_hjSessionUser_*` is base64 JSON: { id, created, existing }. */
function hotjarId(value) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'))?.id || '';
  } catch {
    return '';
  }
}

/**
 * @returns {{ accountId: string, email: string, source: string, deviceKeys: string[] }}
 *   accountId '' when the payload does not say which account it is.
 */
function sessionIdentity(payload) {
  const cookies = cookiesOf(payload);
  let accountId = '';
  let email = '';
  let name = '';
  let plan = '';
  let source = '';

  const looksEmail = (v) => /@/.test(String(v || ''));
  const setEmail = (v) => {
    const e = String(v || '').trim().toLowerCase();
    if (!email && looksEmail(e)) email = e;
  };

  const segment = cookies.find((c) => c.name === 'ajs_user_id');
  if (segment) {
    const value = cleanValue(segment.value);
    if (value && isRealAccountId(value)) {
      accountId = value;
      source = 'ajs_user_id cookie';
    }
  }

  for (const storeKey of ['localStorage', 'sessionStorage']) {
    const store = storeOf(payload, storeKey);
    if (!accountId && store.ajs_user_id) {
      const value = cleanValue(store.ajs_user_id);
      if (value && isRealAccountId(value)) {
        accountId = value;
        source = `ajs_user_id (${storeKey})`;
      }
    }
    for (const claims of jwtsIn(store)) {
      if (!accountId && typeof claims.sub === 'string' && claims.sub && isRealAccountId(claims.sub)) {
        accountId = claims.sub;
        source = `token sub (${storeKey})`;
      }
      if (typeof claims.email === 'string') setEmail(claims.email);
    }

    // DAT stores the signed-in user's profile in these localStorage keys (not a JWT), so
    // read the account email / name / plan from them for display on the admin.
    const parseJson = (raw) => {
      try {
        return JSON.parse(cleanValue(raw));
      } catch {
        return null;
      }
    };
    if (store.profile) {
      const p = parseJson(store.profile);
      if (p && typeof p === 'object') {
        setEmail(p.email || (looksEmail(p.name) ? p.name : '') || (looksEmail(p.nickname) ? p.nickname : ''));
        const full = [p.given_name, p.family_name].filter(Boolean).join(' ').trim();
        if (!name) name = (full || (!looksEmail(p.name) ? p.name : '') || p.nickname || '').trim();
        if (!accountId && typeof p.sub === 'string' && isRealAccountId(p.sub)) {
          accountId = p.sub;
          source = `profile (${storeKey})`;
        }
      }
    }
    if (store.ajs_user_traits) {
      const t = parseJson(store.ajs_user_traits);
      if (t && typeof t === 'object') {
        setEmail(t.email || (looksEmail(t.name) ? t.name : ''));
        if (!plan && typeof t.application_mode === 'string') plan = t.application_mode;
        if (!name && typeof t.name === 'string' && !looksEmail(t.name)) name = t.name.trim();
      }
    }
  }

  const deviceKeys = new Set();
  for (const c of cookies) {
    if (!DEVICE_COOKIES.test(c.name)) continue;
    // did and did_compat carry the same id; key both by "did".
    const nm = c.name === 'did_compat' ? 'did' : c.name.replace(/_\d+$/, '');
    const value = nm === '_hjSessionUser' ? hotjarId(c.value) : cleanValue(c.value);
    if (value) deviceKeys.add(`${nm}=${value}`);
  }

  return { accountId, email, name, plan, source, deviceKeys: [...deviceKeys] };
}

/** Short, display-safe form of an account id: "auth0|…a1b2c3". */
function shortAccountId(accountId) {
  const id = String(accountId || '');
  if (!id) return '';
  const [provider, rest] = id.includes('|') ? id.split('|', 2) : ['', id];
  const tail = rest.length > 8 ? `…${rest.slice(-6)}` : rest;
  return provider ? `${provider}|${tail}` : tail;
}

/**
 * Cross-reference identities of many containers.
 * @param {{ container: string, identity: ReturnType<typeof sessionIdentity> }[]} entries
 * @returns {Map<string, { sameAccountAs: string[], sameBrowserAs: string[] }>}
 */
function matchIdentities(entries) {
  const byAccount = new Map();
  const byDevice = new Map();
  const add = (map, key, container) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(container);
  };
  for (const { container, identity } of entries) {
    if (identity.accountId) add(byAccount, identity.accountId, container);
    for (const key of identity.deviceKeys) add(byDevice, key, container);
  }

  const result = new Map();
  for (const { container, identity } of entries) {
    const sameAccount = new Set(identity.accountId ? byAccount.get(identity.accountId) : []);
    const sameBrowser = new Set();
    for (const key of identity.deviceKeys) {
      for (const other of byDevice.get(key) || []) sameBrowser.add(other);
    }
    sameAccount.delete(container);
    sameBrowser.delete(container);
    // Already reported as the same account; no need to repeat it as the same browser.
    for (const other of sameAccount) sameBrowser.delete(other);
    result.set(container, {
      sameAccountAs: [...sameAccount].sort(),
      sameBrowserAs: [...sameBrowser].sort()
    });
  }
  return result;
}

module.exports = {
  sessionIdentity,
  shortAccountId,
  matchIdentities
};
