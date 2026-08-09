const nodemailer = require('nodemailer');
const { decryptSecret, encryptSecret } = require('../utils/secretCrypto');

const GMAIL_SMTP = {
  host: 'smtp.gmail.com',
  port: 465,
  secure: true
};

const SMTP_PRESETS = {
  'gmail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'googlemail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'outlook.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'hotmail.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'live.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'msn.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'office365.com': { host: 'smtp.office365.com', port: 587, secure: false },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  'ymail.com': { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  'icloud.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
  'me.com': { host: 'smtp.mail.me.com', port: 587, secure: false },
  'mac.com': { host: 'smtp.mail.me.com', port: 587, secure: false }
};

function applyTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function inferSmtpPreset(email) {
  const domain = String(email || '')
    .split('@')[1]
    ?.toLowerCase()
    .trim();
  if (!domain) return null;
  return SMTP_PRESETS[domain] || null;
}

/**
 * Normalize host/port/secure so STARTTLS (587) and SSL (465) are not mixed up.
 * Wrong secure+port combos are the #1 cause of SMTP "connection timeout".
 */
function normalizeSmtpSettings({ email, smtpHost, smtpPort, smtpSecure }) {
  let host = String(smtpHost || '').trim();
  let port = Number(smtpPort) || 0;
  let secure = smtpSecure == null ? null : Boolean(smtpSecure);

  const preset = inferSmtpPreset(email);
  if (!host && preset) {
    host = preset.host;
    if (!port) port = preset.port;
    if (secure == null) secure = preset.secure;
  }

  const hostLower = host.toLowerCase();
  if (hostLower === 'smtp.gmail.com' || hostLower === 'smtp.mail.yahoo.com') {
    if (!port || port === 587 || port === 465) {
      if (secure === true || port === 465 || !port) {
        port = port || 465;
        secure = true;
      } else {
        port = 587;
        secure = false;
      }
    }
  }
  if (hostLower === 'smtp.office365.com' || hostLower === 'smtp-mail.outlook.com') {
    port = port || 587;
    secure = false;
  }

  if (!port) port = secure ? 465 : 587;

  if (port === 465) secure = true;
  else if (port === 587 || port === 25 || port === 2525) secure = false;
  else if (secure == null) secure = port === 465;

  return { host, port: Number(port), secure: Boolean(secure) };
}

function buildSmtpTransportOptions(account, overrides = {}) {
  const password = decryptSecret(account.appPasswordEnc);
  if (!password) throw new Error('Email account is missing credentials');

  const normalized = normalizeSmtpSettings({
    email: overrides.email || account.email,
    smtpHost: overrides.host != null ? overrides.host : account.smtpHost,
    smtpPort: overrides.port != null ? overrides.port : account.smtpPort,
    smtpSecure: overrides.secure != null ? overrides.secure : account.smtpSecure
  });

  if (!normalized.host) throw new Error('SMTP host is required');

  const opts = {
    host: normalized.host,
    port: normalized.port,
    secure: normalized.secure,
    auth: {
      user: String(overrides.user || account.email || '').trim(),
      pass: password
    },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 45_000,
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    },
    requireTLS: !normalized.secure && (normalized.port === 587 || normalized.port === 25),
    ignoreTLS: false
  };

  return { opts, normalized };
}

function smtpCandidateConfigs(account) {
  const base = normalizeSmtpSettings({
    email: account.email,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure
  });

  const candidates = [];
  const push = (host, port, secure) => {
    if (!host) return;
    const key = `${host}|${port}|${secure}`;
    if (candidates.some((c) => `${c.host}|${c.port}|${c.secure}` === key)) return;
    candidates.push({ host, port, secure });
  };

  if (base.host) push(base.host, base.port, base.secure);
  if (base.host) {
    push(base.host, 587, false);
    push(base.host, 465, true);
    push(base.host, 2525, false);
  }

  const preset = inferSmtpPreset(account.email);
  if (preset) {
    push(preset.host, preset.port, preset.secure);
    push(preset.host, 587, false);
    push(preset.host, 465, true);
  }

  return candidates;
}

function formatSmtpError(err, tried = []) {
  const code = err?.code || '';
  const msg = String(err?.message || err || 'SMTP connection failed');
  const triedLabel = tried.length
    ? ` Tried: ${tried.map((t) => `${t.host}:${t.port}${t.secure ? '/SSL' : '/STARTTLS'}`).join(', ')}.`
    : '';

  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return (
      'SMTP connection timed out. Use port 587 without SSL/TLS, or port 465 with SSL/TLS. ' +
      'Also confirm this machine can reach the mail server (outbound 465/587 not blocked).' +
      triedLabel
    );
  }
  if (code === 'ECONNREFUSED') {
    return `SMTP connection refused.${triedLabel} Wrong host/port, or the mail server is blocking this IP.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `SMTP host not found. Check the SMTP host name.${triedLabel}`;
  }
  if (/invalid login|authentication|credentials|535|534|535-5\.7/i.test(msg)) {
    return `SMTP login failed: ${msg}. For Gmail/Yahoo use an App Password, not your normal password.`;
  }
  return `${msg}${triedLabel}`;
}

async function createAppPasswordTransport(account) {
  const password = decryptSecret(account.appPasswordEnc);
  if (!password) throw new Error('Email account is missing credentials');
  return nodemailer.createTransport({
    ...GMAIL_SMTP,
    auth: {
      user: account.email,
      pass: password
    },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 45_000,
    tls: { rejectUnauthorized: false }
  });
}

async function createSmtpTransport(account) {
  const { opts } = buildSmtpTransportOptions(account);
  return nodemailer.createTransport(opts);
}

async function refreshGoogleAccessToken(account) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth is not configured on the server');
  }
  const refreshToken = decryptSecret(account.refreshTokenEnc);
  if (!refreshToken) throw new Error('Missing Google refresh token — reconnect Gmail');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to refresh Google token');
  }

  account.accessTokenEnc = encryptSecret(data.access_token);
  account.accessTokenExpiresAt = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000);
  if (data.refresh_token) {
    account.refreshTokenEnc = encryptSecret(data.refresh_token);
  }
  await account.save();
  return data.access_token;
}

async function getOAuthAccessToken(account) {
  const expires = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : 0;
  const access = decryptSecret(account.accessTokenEnc);
  if (access && expires > Date.now() + 60_000) return access;
  return refreshGoogleAccessToken(account);
}

async function createOAuthTransport(account) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const accessToken = await getOAuthAccessToken(account);
  const refreshToken = decryptSecret(account.refreshTokenEnc);

  return nodemailer.createTransport({
    ...GMAIL_SMTP,
    auth: {
      type: 'OAuth2',
      user: account.email,
      clientId,
      clientSecret,
      refreshToken,
      accessToken
    },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 45_000
  });
}

async function getTransportForAccount(account) {
  if (account.method === 'oauth') return createOAuthTransport(account);
  if (account.method === 'smtp') return createSmtpTransport(account);
  return createAppPasswordTransport(account);
}

/**
 * Verify SMTP by trying several common TLS/port combinations.
 * Returns the working { host, port, secure } so callers can persist corrections.
 */
async function verifySmtpWithFallbacks(account) {
  const candidates = smtpCandidateConfigs(account);
  const tried = [];
  let lastErr = null;

  for (const candidate of candidates) {
    tried.push(candidate);
    let transport;
    try {
      const { opts, normalized } = buildSmtpTransportOptions(account, candidate);
      transport = nodemailer.createTransport(opts);
      await transport.verify();
      try {
        transport.close();
      } catch {
        // ignore
      }
      return normalized;
    } catch (err) {
      lastErr = err;
      try {
        transport?.close();
      } catch {
        // ignore
      }
      const msg = String(err?.message || '');
      if (/invalid login|authentication failed|535/i.test(msg) && tried.length >= 2) {
        break;
      }
    }
  }

  throw new Error(formatSmtpError(lastErr, tried));
}

async function verifyAccountCredentials(account) {
  if (account.method === 'smtp') {
    const working = await verifySmtpWithFallbacks(account);
    account.smtpHost = working.host;
    account.smtpPort = working.port;
    account.smtpSecure = working.secure;
    return working;
  }
  const transport = await getTransportForAccount(account);
  try {
    await transport.verify();
  } catch (err) {
    throw new Error(formatSmtpError(err));
  } finally {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
  return true;
}

async function sendMail({ account, to, subject, body, replyTo }) {
  const transport = await getTransportForAccount(account);
  try {
    const fromName = account.displayName || account.email;
    const info = await transport.sendMail({
      from: `"${fromName.replace(/"/g, '')}" <${account.email}>`,
      to,
      subject,
      text: body,
      html: body.includes('<') ? body : undefined,
      replyTo: replyTo || account.email
    });
    return {
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || []
    };
  } finally {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
}

function isGoogleOAuthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getOAuthRedirectUri() {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${(process.env.PUBLIC_API_URL || 'http://localhost:7020').replace(/\/$/, '')}/email/oauth/callback`
  );
}

function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: getOAuthRedirectUri(),
    response_type: 'code',
    scope: ['https://mail.google.com/', 'email', 'profile'].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: String(state || '')
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: getOAuthRedirectUri(),
    grant_type: 'authorization_code'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'OAuth token exchange failed');
  }
  return data;
}

async function fetchGoogleProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.email) {
    throw new Error('Failed to load Google profile');
  }
  return data;
}

module.exports = {
  applyTemplate,
  verifyAccountCredentials,
  sendMail,
  isGoogleOAuthConfigured,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleProfile,
  getOAuthRedirectUri,
  normalizeSmtpSettings,
  inferSmtpPreset,
  SMTP_PRESETS
};
