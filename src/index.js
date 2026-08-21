const path = require('path');
const fs = require('fs');

// Always load backend/.env (not process.cwd()) so pm2 / systemd / other CWDs still work.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const cookieRoutes = require('./routes/cookies');
const proxyRoutes = require('./routes/proxies');
const extensionRoutes = require('./routes/extensions');
const updateRoutes = require('./routes/update');
const freightdeskRoutes = require('./routes/freightdesk');
const emailRoutes = require('./routes/email');
const adminRoutes = require('./routes/admin');
const partnerSwiftSolutionsRoutes = require('./routes/partnerSwiftSolutions');
const { ensureCookiesDir } = require('./utils/cookies');
const {
  ensureExtensionsDir,
  backfillExtensionPackagesFromDisk
} = require('./controllers/extensionController');
const {
  isGoogleOAuthConfigured,
  getOAuthRedirectUri,
  googleOAuthMissingKeys
} = require('./services/mailService');
const { startMailboxSyncCron } = require('./services/mailboxSyncService');
const { createCorsOptions, applyCorsHeaders } = require('./utils/corsOrigins');
const { isTooLargeError, tooLargeMessage } = require('./utils/uploadLimits');

const app = express();
const PORT = process.env.PORT || 7020;

ensureCookiesDir();
ensureExtensionsDir();

app.set('trust proxy', 1);

const corsOptions = createCorsOptions();
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure CORS headers survive error responses generated after middleware
app.use((req, res, next) => {
  applyCorsHeaders(req, res);
  const originalWriteHead = res.writeHead;
  res.writeHead = function writeHeadWithCors(...args) {
    applyCorsHeaders(req, res);
    return originalWriteHead.apply(this, args);
  };
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    applyCorsHeaders(req, res);
    return originalJson(body);
  };
  next();
});

app.get('/health', (_req, res) => {
  const oauthConfigured = isGoogleOAuthConfigured();
  let mailboxSync = null;
  try {
    mailboxSync = require('./services/mailboxSyncService').getMailboxSyncStatus();
  } catch {
    mailboxSync = null;
  }
  res.json({
    ok: true,
    service: 'datdesk-backend',
    port: Number(process.env.PORT) || 7020,
    oauthConfigured,
    oauthMissing: oauthConfigured ? [] : googleOAuthMissingKeys(),
    oauthRedirectUri: getOAuthRedirectUri(),
    mailboxSync: mailboxSync
      ? {
          enabled: mailboxSync.enabled,
          cronExpr: mailboxSync.cronExpr,
          running: mailboxSync.running,
          lastRunAt: mailboxSync.lastRunAt
        }
      : null
  });
});

app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/cookie', cookieRoutes);
app.use('/proxy', proxyRoutes);
app.use('/extension', extensionRoutes);
app.use('/update', updateRoutes);
app.use('/freightdesk', freightdeskRoutes);
app.use('/email', emailRoutes);
app.use('/admin', adminRoutes);
app.use('/partner/swift-solutions', partnerSwiftSolutionsRoutes);

// Alias used by DATGO-style clients
app.get('/file/cookies/:sessionId?', require('./middleware/auth').authenticateToken, require('./controllers/cookieController').getActiveCookieForUser);

app.use((err, req, res, _next) => {
  applyCorsHeaders(req, res);
  if (isTooLargeError(err)) {
    return res.status(413).json({ message: tooLargeMessage() });
  }
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({ message: err.message || 'Internal server error' });
});

async function start() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/newdatapp';
  await mongoose.connect(uri);
  console.log('[DB] Connected:', uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));

  try {
    await backfillExtensionPackagesFromDisk();
  } catch (err) {
    console.warn('[EXTENSION] Disk backfill skipped:', err.message);
  }

  if (isGoogleOAuthConfigured()) {
    console.log('[EMAIL] Google OAuth: configured →', getOAuthRedirectUri());
  } else {
    console.warn(
      '[EMAIL] Google OAuth: NOT configured. Missing:',
      googleOAuthMissingKeys().join(', ') || '(unknown)'
    );
  }

  app.listen(PORT, () => {
    console.log(`[SERVER] Dat Desk backend listening on http://localhost:${PORT}`);
    try {
      startMailboxSyncCron();
    } catch (err) {
      console.warn('[mailbox-sync] failed to start cron:', err?.message || err);
    }
  });
}

start().catch((err) => {
  console.error('[SERVER] Failed to start:', err);
  process.exit(1);
});
