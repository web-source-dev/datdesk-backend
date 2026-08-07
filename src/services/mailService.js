const nodemailer = require('nodemailer');
const { decryptSecret, encryptSecret } = require('../utils/secretCrypto');

const GMAIL_SMTP = {
  host: 'smtp.gmail.com',
  port: 465,
  secure: true
};

function applyTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

async function createAppPasswordTransport(account) {
  const password = decryptSecret(account.appPasswordEnc);
  if (!password) throw new Error('Email account is missing credentials');
  return nodemailer.createTransport({
    ...GMAIL_SMTP,
    auth: {
      user: account.email,
      pass: password
    }
  });
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
    }
  });
}

async function getTransportForAccount(account) {
  if (account.method === 'oauth') return createOAuthTransport(account);
  return createAppPasswordTransport(account);
}

async function verifyAccountCredentials(account) {
  const transport = await getTransportForAccount(account);
  await transport.verify();
  return true;
}

async function sendMail({ account, to, subject, body, replyTo }) {
  const transport = await getTransportForAccount(account);
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
  getOAuthRedirectUri
};
