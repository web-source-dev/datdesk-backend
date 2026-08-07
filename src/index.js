require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const cookieRoutes = require('./routes/cookies');
const proxyRoutes = require('./routes/proxies');
const extensionRoutes = require('./routes/extensions');
const updateRoutes = require('./routes/update');
const freightdeskRoutes = require('./routes/freightdesk');
const emailRoutes = require('./routes/email');
const partnerSwiftSolutionsRoutes = require('./routes/partnerSwiftSolutions');
const { ensureCookiesDir } = require('./utils/cookies');
const { ensureExtensionsDir } = require('./controllers/extensionController');

const app = express();
const PORT = process.env.PORT || 7020;

ensureCookiesDir();
ensureExtensionsDir();

app.set('trust proxy', 1);

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));


app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/cookie', cookieRoutes);
app.use('/proxy', proxyRoutes);
app.use('/extension', extensionRoutes);
app.use('/update', updateRoutes);
app.use('/freightdesk', freightdeskRoutes);
app.use('/email', emailRoutes);
app.use('/partner/swift-solutions', partnerSwiftSolutionsRoutes);

// Alias used by DATGO-style clients
app.get('/file/cookies/:sessionId?', require('./middleware/auth').authenticateToken, require('./controllers/cookieController').getActiveCookieForUser);

app.use((err, _req, res, _next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({ message: err.message || 'Internal server error' });
});

async function start() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/newdatapp';
  await mongoose.connect(uri);
  console.log('[DB] Connected:', uri);

  app.listen(PORT, () => {
    console.log(`[SERVER] Horizon backend listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[SERVER] Failed to start:', err);
  process.exit(1);
});
