const jwt = require('jsonwebtoken');
const User = require('../models/User');
const EmailAccount = require('../models/EmailAccount');
const EmailTemplate = require('../models/EmailTemplate');
const EmailSent = require('../models/EmailSent');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');
const { logActivity } = require('../services/activityLogService');
const { DEFAULT_LOAD_INQUIRY } = require('../constants/defaultEmailTemplates');
const { generateEmailTemplate } = require('../services/openRouterService');
const {
  assertCanCreateEmailAccount,
  assertCanCreateTemplate,
  applyAllowedOnConnect,
  buildLimitsPayload,
  ensureDefaultAmongAllowed,
  getMaxTemplates,
  getMaxEmailAccounts,
  getUsableAccountIds,
  listUserAccounts,
  syncAllowedAccounts,
  unusableAccountMessage
} = require('../services/emailLimits');
const {
  applyTemplate,
  verifyAccountCredentials,
  sendMail,
  isGoogleOAuthConfigured,
  googleOAuthMissingKeys,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleProfile,
  getOAuthRedirectUri,
  normalizeSmtpSettings,
  probeSmtpTcp
} = require('../services/mailService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** In-memory OAuth progress so the extension can leave the waiting screen on cancel. */
const oauthResults = new Map();

function rememberOAuth(userId, patch) {
  if (!userId) return;
  const id = String(userId);
  oauthResults.set(id, { ...(oauthResults.get(id) || {}), ...patch, at: Date.now() });
}

function oauthStateSecrets() {
  return [
    ...new Set(
      [
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.EMAIL_SECRET,
        process.env.JWT_SECRET,
        'default-secret-change-this'
      ].filter(Boolean)
    )
  ];
}

function signOAuthState(userId, redirectUri) {
  return jwt.sign(
    {
      userId: String(userId),
      purpose: 'gmail_oauth',
      redirectUri: redirectUri ? String(redirectUri) : undefined
    },
    oauthStateSecrets()[0],
    { expiresIn: '15m' }
  );
}

function verifyOAuthStateStrict(state) {
  const raw = String(state || '');
  for (const secret of oauthStateSecrets()) {
    try {
      const payload = jwt.verify(raw, secret);
      if (payload.purpose === 'gmail_oauth' && payload.userId) return payload;
    } catch {
      // next secret
    }
  }
  return null;
}

function decodeOAuthState(state) {
  try {
    const payload = jwt.decode(String(state || ''));
    if (payload?.purpose === 'gmail_oauth' && payload.userId) return payload;
  } catch {
    // ignore
  }
  return null;
}

function isLoopbackHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function cloudOAuthCallbackUrl() {
  const explicit = String(process.env.OAUTH_CLOUD_CALLBACK_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const publicApi = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (publicApi && !/localhost|127\.0\.0\.1/i.test(publicApi)) {
    return `${publicApi}/email/oauth/callback`;
  }
  return 'https://api.datdesk.apexskillzone.com/email/oauth/callback';
}

function shouldFinishOnCloud(req) {
  const host = String(req.get('x-forwarded-host') || req.get('host') || '');
  if (!isLoopbackHost(host)) return false;
  try {
    const cloud = new URL(cloudOAuthCallbackUrl());
    return !isLoopbackHost(cloud.hostname);
  } catch {
    return false;
  }
}

async function finishOAuthOnCloud(req) {
  const target = new URL(cloudOAuthCallbackUrl());
  for (const [key, value] of Object.entries(req.query || {})) {
    if (value == null || value === '') continue;
    target.searchParams.set(key, Array.isArray(value) ? String(value[0]) : String(value));
  }
  let cloudRes;
  try {
    cloudRes = await fetch(target.toString(), {
      method: 'GET',
      headers: { Accept: 'text/html', 'User-Agent': 'DatDesk-OAuth-Forward/1' },
      redirect: 'follow'
    });
  } catch (err) {
    return { ok: false, email: '', message: err.message || 'Could not reach the cloud API', status: 0 };
  }
  const html = await cloudRes.text();
  const ok = /(?:inbox|email) connected/i.test(html);
  let email = '';
  const emailMatch = html.match(/class="email">([^<]+)/i);
  if (emailMatch) email = String(emailMatch[1] || '').trim();
  let message = '';
  const msgMatch = html.match(/<p>([^<]+)<\/p>/i);
  if (msgMatch && !ok) message = String(msgMatch[1] || '').trim();
  return { ok, email, message, status: cloudRes.status };
}

async function listAccounts(userId) {
  return listUserAccounts(userId);
}

function serializeAccounts(accounts, permissions) {
  const list = Array.isArray(accounts) ? accounts : [];
  const usableIds = getUsableAccountIds(list, getMaxEmailAccounts(permissions));
  return list.map((a) => {
    const id = String(a._id || a.id);
    const usable = usableIds.has(id);
    return {
      ...(typeof a.toSafeJSON === 'function'
        ? a.toSafeJSON()
        : { id, email: a.email, isDefault: Boolean(a.isDefault), allowed: usable }),
      allowed: usable,
      usable
    };
  });
}

async function finishConnectedAccount(account, userId, permissions, { created, makeDefault }) {
  await applyAllowedOnConnect(account, userId, permissions, created);
  const current = await EmailAccount.findById(account._id);
  if (makeDefault && current && current.allowed === true) {
    await ensureDefaultAmongAllowed(userId, current._id);
  } else {
    await ensureDefaultAmongAllowed(userId);
  }
  return EmailAccount.findById(account._id);
}

async function ensureDefaultLoadInquiry(userId, permissions) {
  const existing = await EmailTemplate.findOne({
    userId,
    name: DEFAULT_LOAD_INQUIRY.name
  }).select('_id');
  if (existing) return;
  const max = getMaxTemplates(permissions);
  if (max > 0) {
    const count = await EmailTemplate.countDocuments({ userId });
    if (count >= max) return;
  }
  const hasDefault = await EmailTemplate.exists({ userId, isDefault: true });
  try {
    await EmailTemplate.create({
      userId,
      name: DEFAULT_LOAD_INQUIRY.name,
      subject: DEFAULT_LOAD_INQUIRY.subject,
      body: DEFAULT_LOAD_INQUIRY.body,
      isDefault: !hasDefault
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

async function getStatus(req, res) {
  try {
    await ensureDefaultLoadInquiry(req.user.userId, req.user.permissions);
    const [accounts, templates] = await Promise.all([
      syncAllowedAccounts(req.user.userId, req.user.permissions),
      EmailTemplate.find({ userId: req.user.userId })
        .sort({ isDefault: -1, updatedAt: -1 })
        .lean()
    ]);
    const withUsable = serializeAccounts(accounts, req.user.permissions);
    const defaultAccount =
      withUsable.find((a) => a.isDefault && a.usable) ||
      withUsable.find((a) => a.usable) ||
      withUsable[0] ||
      null;

    return res.json({
      connected: withUsable.some((a) => a.usable),
      account: defaultAccount,
      accounts: withUsable,
      oauthAvailable: isGoogleOAuthConfigured(),
      limits: buildLimitsPayload(
        req.user.permissions,
        accounts.length,
        templates.length,
        withUsable.filter((a) => a.usable).length
      ),
      templates: templates.map((t) => ({
        id: String(t._id),
        name: t.name,
        subject: t.subject,
        body: t.body,
        isDefault: Boolean(t.isDefault),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to load email status' });
  }
}

async function connectAppPassword(req, res) {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const appPassword = String(req.body?.appPassword || '').replace(/\s+/g, '');
    const displayName = String(req.body?.displayName || '').trim();
    const makeDefault = req.body?.isDefault !== false;

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }
    if (!appPassword || appPassword.length < 8) {
      return res.status(400).json({ message: 'Enter a valid Gmail app password' });
    }

    const existingForLimit = await EmailAccount.findOne({
      userId: req.user.userId,
      email
    }).select('_id');
    if (!existingForLimit) {
      await assertCanCreateEmailAccount(req.user.userId, req.user.permissions);
    }

    const draft = new EmailAccount({
      userId: req.user.userId,
      email,
      method: 'app_password',
      appPasswordEnc: encryptSecret(appPassword),
      displayName,
      connectedAt: new Date(),
      isDefault: false
    });

    try {
      await verifyAccountCredentials(draft);
    } catch (err) {
      return res.status(400).json({
        message:
          err.message ||
          'Could not connect. Use a Gmail App Password (Google Account → Security → App passwords).',
        code: err.code || 'SMTP_VERIFY_FAILED'
      });
    }

    let account = await EmailAccount.findOne({
      userId: req.user.userId,
      email
    }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');

    const created = !account;
    if (account) {
      account.method = 'app_password';
      account.appPasswordEnc = encryptSecret(appPassword);
      account.refreshTokenEnc = '';
      account.accessTokenEnc = '';
      account.accessTokenExpiresAt = null;
      account.displayName = displayName;
      account.smtpHost = '';
      account.smtpPort = 587;
      account.smtpSecure = false;
      account.connectedAt = new Date();
      await account.save();
    } else {
      draft.allowed = true;
      await draft.save();
      account = draft;
    }

    account = await finishConnectedAccount(account, req.user.userId, req.user.permissions, {
      created,
      makeDefault
    });

    await logActivity({
      userId: req.user.userId,
      actorEmail: req.user.email,
      action: 'email.connect',
      category: 'email',
      status: 'success',
      message: `Connected ${email} via app password`,
      meta: { accountId: String(account._id), email, method: 'app_password' },
      req
    });

    return res.status(account.wasNew ? 201 : 200).json({
      message: 'Email connected',
      account: account.toSafeJSON()
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to connect email',
      code: error.code
    });
  }
}

async function connectSmtp(req, res) {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || req.body?.appPassword || '').replace(/\s+/g, '');
    const displayName = String(req.body?.displayName || '').trim();
    const smtpUser = String(req.body?.smtpUser || req.body?.username || '').trim() || email;
    const makeDefault = req.body?.isDefault !== false;

    const normalized = normalizeSmtpSettings({
      email,
      smtpHost: req.body?.smtpHost,
      smtpPort: req.body?.smtpPort,
      smtpSecure: req.body?.smtpSecure
    });

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }
    if (!password || password.length < 3) {
      return res.status(400).json({ message: 'SMTP password is required' });
    }
    if (!normalized.host) {
      return res.status(400).json({
        message:
          'SMTP host is required (e.g. smtp.gmail.com, smtp.office365.com). Leave blank only for known providers like Gmail/Outlook/Yahoo.'
      });
    }

    const existingForLimit = await EmailAccount.findOne({
      userId: req.user.userId,
      email
    }).select('_id');
    if (!existingForLimit) {
      await assertCanCreateEmailAccount(req.user.userId, req.user.permissions);
    }

    console.log('[SMTP] connect request', {
      email,
      smtpUser,
      host: normalized.host,
      port: normalized.port,
      secure: normalized.secure,
      passLen: password.length,
      userId: String(req.user?.userId || ''),
      skipVerify: Boolean(req.body?.skipVerify || req.body?.clientVerified)
    });

    const draft = new EmailAccount({
      userId: req.user.userId,
      email,
      method: 'smtp',
      appPasswordEnc: encryptSecret(password),
      displayName,
      smtpHost: normalized.host,
      smtpPort: normalized.port,
      smtpSecure: normalized.secure,
      smtpUser,
      connectedAt: new Date(),
      isDefault: false
    });

    const skipVerify = Boolean(req.body?.skipVerify || req.body?.clientVerified);
    let working;
    if (skipVerify) {
      console.log('[SMTP] skipping server verify — client already verified from this PC');
      working = {
        host: normalized.host,
        port: normalized.port,
        secure: normalized.secure
      };
    } else {
      try {
        working = await verifyAccountCredentials(draft);
        console.log('[SMTP] connect verified', {
          email,
          host: working?.host || normalized.host,
          port: working?.port || normalized.port,
          secure: working?.secure != null ? working.secure : normalized.secure
        });
      } catch (err) {
        console.warn('[SMTP] connect verify failed', {
          email,
          host: normalized.host,
          port: normalized.port,
          code: err.code || '',
          message: err.message || String(err)
        });
        return res.status(400).json({
          message: err.message || 'Could not verify SMTP credentials. Check host, port, and password.',
          code: err.code || 'SMTP_VERIFY_FAILED'
        });
      }
    }

    const finalHost = working?.host || normalized.host;
    const finalPort = working?.port || normalized.port;
    const finalSecure = working?.secure != null ? working.secure : normalized.secure;

    let account = await EmailAccount.findOne({
      userId: req.user.userId,
      email
    }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');

    const created = !account;
    if (account) {
      account.method = 'smtp';
      account.appPasswordEnc = encryptSecret(password);
      account.refreshTokenEnc = '';
      account.accessTokenEnc = '';
      account.accessTokenExpiresAt = null;
      account.displayName = displayName;
      account.smtpHost = finalHost;
      account.smtpPort = finalPort;
      account.smtpSecure = finalSecure;
      account.smtpUser = smtpUser;
      account.connectedAt = new Date();
      await account.save();
      console.log('[SMTP] connect saved existing', { email, host: finalHost, port: finalPort, secure: finalSecure });
    } else {
      draft.smtpHost = finalHost;
      draft.smtpPort = finalPort;
      draft.smtpSecure = finalSecure;
      draft.allowed = true;
      await draft.save();
      account = draft;
      console.log('[SMTP] connect saved new', { email, host: finalHost, port: finalPort, secure: finalSecure });
    }

    account = await finishConnectedAccount(account, req.user.userId, req.user.permissions, {
      created,
      makeDefault
    });

    await logActivity({
      userId: req.user.userId,
      actorEmail: req.user.email,
      action: 'email.connect',
      category: 'email',
      status: 'success',
      message: `Connected ${email} via SMTP`,
      meta: {
        accountId: String(account._id),
        email,
        method: 'smtp',
        smtpHost: finalHost,
        smtpPort: finalPort
      },
      req
    });

    return res.status(201).json({ message: 'SMTP connected', account: account.toSafeJSON() });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to connect SMTP',
      code: error.code
    });
  }
}

async function disconnect(req, res) {
  return res.status(403).json({
    message: 'Connected emails can only be removed by an admin.',
    code: 'EMAIL_ACCOUNT_REMOVE_FORBIDDEN'
  });
}

async function setDefaultAccount(req, res) {
  try {
    const accountId = req.body?.accountId;
    if (!accountId) return res.status(400).json({ message: 'accountId is required' });
    const accounts = await syncAllowedAccounts(req.user.userId, req.user.permissions);
    const match = accounts.find((a) => String(a._id) === String(accountId));
    if (!match) return res.status(404).json({ message: 'Account not found' });
    if (match.allowed === false) {
      return res.status(403).json({
        message: unusableAccountMessage(),
        code: 'EMAIL_ACCOUNT_UNUSABLE'
      });
    }
    const account = await ensureDefaultAmongAllowed(req.user.userId, accountId);
    const next = await listAccounts(req.user.userId);
    const withUsable = serializeAccounts(next, req.user.permissions);
    const safeDefault = withUsable.find((a) => a.id === String(account?._id || accountId)) || withUsable.find((a) => a.usable);
    return res.json({
      message: 'Default account updated',
      account: safeDefault,
      accounts: withUsable
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to set default account',
      code: error.code
    });
  }
}

async function listTemplates(req, res) {
  try {
    await ensureDefaultLoadInquiry(req.user.userId, req.user.permissions);
    const templates = await EmailTemplate.find({ userId: req.user.userId }).sort({
      isDefault: -1,
      updatedAt: -1
    });
    return res.json({ templates: templates.map((t) => t.toSafeJSON()) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list templates' });
  }
}

async function generateTemplateAi(req, res) {
  try {
    const template = await generateEmailTemplate({
      prompt: req.body?.prompt,
      name: req.body?.name,
      subject: req.body?.subject,
      body: req.body?.body,
      mode: req.body?.mode
    });
    return res.json({ template });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to generate template',
      code: error.code || 'AI_FAILED'
    });
  }
}

async function createTemplate(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    const subject = String(req.body?.subject || '').trim();
    const body = String(req.body?.body || '');
    const isDefault = Boolean(req.body?.isDefault);

    if (!name || !subject || !body.trim()) {
      return res.status(400).json({ message: 'Name, subject, and body are required' });
    }

    await assertCanCreateTemplate(req.user.userId, req.user.permissions);

    if (isDefault) {
      await EmailTemplate.updateMany({ userId: req.user.userId }, { $set: { isDefault: false } });
    }

    const template = await EmailTemplate.create({
      userId: req.user.userId,
      name,
      subject,
      body,
      isDefault
    });

    return res.status(201).json({ template: template.toSafeJSON() });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'A template with that name already exists' });
    }
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to create template',
      code: error.code
    });
  }
}

async function updateTemplate(req, res) {
  try {
    const template = await EmailTemplate.findOne({
      _id: req.params.id,
      userId: req.user.userId
    });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    if (req.body?.name != null) template.name = String(req.body.name).trim();
    if (req.body?.subject != null) template.subject = String(req.body.subject).trim();
    if (req.body?.body != null) template.body = String(req.body.body);
    if (req.body?.isDefault === true) {
      await EmailTemplate.updateMany({ userId: req.user.userId }, { $set: { isDefault: false } });
      template.isDefault = true;
    } else if (req.body?.isDefault === false) {
      template.isDefault = false;
    }

    if (!template.name || !template.subject || !String(template.body).trim()) {
      return res.status(400).json({ message: 'Name, subject, and body are required' });
    }

    await template.save();
    return res.json({ template: template.toSafeJSON() });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'A template with that name already exists' });
    }
    return res.status(500).json({ message: error.message || 'Failed to update template' });
  }
}

async function deleteTemplate(req, res) {
  try {
    const result = await EmailTemplate.deleteOne({
      _id: req.params.id,
      userId: req.user.userId
    });
    if (!result.deletedCount) return res.status(404).json({ message: 'Template not found' });
    return res.json({ message: 'Template deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to delete template' });
  }
}

async function findSendingAccount(userId, accountId, permissions) {
  await syncAllowedAccounts(userId, permissions);
  const accounts = await EmailAccount.find({ userId })
    .sort({ isDefault: -1, connectedAt: -1 })
    .select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');
  if (!accounts.length) return null;
  const usableIds = getUsableAccountIds(accounts, getMaxEmailAccounts(permissions));
  if (accountId) {
    const match = accounts.find((a) => String(a._id) === String(accountId));
    if (!match) return null;
    if (!usableIds.has(String(match._id))) {
      const err = new Error(unusableAccountMessage());
      err.code = 'EMAIL_ACCOUNT_UNUSABLE';
      err.status = 403;
      throw err;
    }
    return match;
  }
  return (
    accounts.find((a) => a.isDefault && usableIds.has(String(a._id))) ||
    accounts.find((a) => usableIds.has(String(a._id))) ||
    null
  );
}

async function deliverQueuedEmail({ sentId, actorEmail = '', ip = '', userAgent = '' }) {
  const sent = await EmailSent.findOneAndUpdate(
    { _id: sentId, status: { $in: ['queued', 'sending'] } },
    { $set: { status: 'sending' } },
    { new: true }
  );
  if (!sent) return null;

  const account = await EmailAccount.findOne({
    _id: sent.accountId,
    userId: sent.userId
  }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');

  if (!account) {
    sent.status = 'failed';
    sent.error = 'Email no longer connected';
    await sent.save();
    await logActivity({
      userId: sent.userId,
      actorEmail,
      action: 'email.send',
      category: 'email',
      status: 'failure',
      message: `Failed to send email to ${sent.to}`,
      meta: { to: sent.to, subject: sent.subject, emailSentId: String(sent._id) },
      ip,
      userAgent
    });
    return sent;
  }

  const owner = await User.findById(sent.userId).select('permissions');
  await syncAllowedAccounts(sent.userId, owner?.permissions);
  const peers = await EmailAccount.find({ userId: sent.userId }).select('_id isDefault connectedAt allowed');
  const usableIds = getUsableAccountIds(peers, getMaxEmailAccounts(owner?.permissions));
  if (!usableIds.has(String(account._id))) {
    sent.status = 'failed';
    sent.error = unusableAccountMessage();
    await sent.save();
    await logActivity({
      userId: sent.userId,
      actorEmail,
      action: 'email.send',
      category: 'email',
      status: 'failure',
      message: unusableAccountMessage(),
      meta: { to: sent.to, subject: sent.subject, emailSentId: String(sent._id) },
      ip,
      userAgent
    });
    return sent;
  }

  try {
    const result = await sendMail({
      account,
      to: sent.to,
      subject: sent.subject,
      body: sent.body
    });
    sent.status = 'sent';
    sent.error = '';
    sent.messageId = result?.messageId || result?.id || '';
    sent.sentAt = new Date();
    sent.method = account.method || sent.method || 'unknown';
    await sent.save();
    await logActivity({
      userId: sent.userId,
      actorEmail,
      action: 'email.send',
      category: 'email',
      status: 'success',
      message: `Sent email to ${sent.to}`,
      meta: {
        accountId: String(account._id),
        from: account.email,
        to: sent.to,
        subject: sent.subject,
        method: account.method,
        emailSentId: String(sent._id),
        messageId: sent.messageId,
        queued: true
      },
      ip,
      userAgent
    });
  } catch (error) {
    sent.status = 'failed';
    sent.error = String(error.message || 'Failed to send email').slice(0, 1000);
    await sent.save();
    await logActivity({
      userId: sent.userId,
      actorEmail,
      action: 'email.send',
      category: 'email',
      status: 'failure',
      message: error.message || 'Failed to send email',
      meta: {
        to: sent.to,
        subject: sent.subject,
        emailSentId: String(sent._id)
      },
      ip,
      userAgent
    });
  }
  return sent;
}

async function resumeQueuedEmails() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    await EmailSent.updateMany(
      { status: 'queued', createdAt: { $lt: cutoff } },
      { $set: { status: 'failed', error: 'Send timed out in queue' } }
    );
    const pending = await EmailSent.find({
      status: { $in: ['queued', 'sending'] },
      createdAt: { $gte: cutoff }
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .select('_id');
    for (const doc of pending) {
      deliverQueuedEmail({ sentId: doc._id }).catch((err) => {
        console.warn('[email] resume queued send failed:', err?.message || err);
      });
    }
    if (pending.length) {
      console.log(`[email] resumed ${pending.length} queued send(s)`);
    }
  } catch (err) {
    console.warn('[email] resume queued emails skipped:', err?.message || err);
  }
}

async function sendEmail(req, res) {
  try {
    const account = await findSendingAccount(
      req.user.userId,
      req.body?.accountId,
      req.user.permissions
    );

    if (!account) {
      return res.status(400).json({ message: 'Connect an email account first' });
    }

    const to = String(req.body?.to || '')
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(to)) {
      return res.status(400).json({ message: 'Enter a valid recipient email' });
    }

    let subject = String(req.body?.subject || '').trim();
    let body = String(req.body?.body || '');
    const templateId = req.body?.templateId;

    const vars = {
      email: to,
      to,
      ...(req.body?.vars && typeof req.body.vars === 'object' ? req.body.vars : {})
    };

    if (templateId) {
      const template = await EmailTemplate.findOne({
        _id: templateId,
        userId: req.user.userId
      }).lean();
      if (!template) return res.status(404).json({ message: 'Template not found' });
      if (!subject) subject = applyTemplate(template.subject, vars);
      if (!body.trim()) body = applyTemplate(template.body, vars);
      else {
        subject = applyTemplate(subject, vars);
        body = applyTemplate(body, vars);
      }
    } else {
      subject = applyTemplate(subject, vars);
      body = applyTemplate(body, vars);
    }

    if (!subject || !body.trim()) {
      return res.status(400).json({ message: 'Subject and body are required' });
    }

    const queued = await EmailSent.create({
      userId: req.user.userId,
      accountId: account._id,
      templateId: templateId || null,
      from: account.email,
      to,
      subject,
      body,
      method: account.method || 'unknown',
      messageId: '',
      vars,
      status: 'queued',
      queuedAt: new Date()
    });

    const smtpish = account.method === 'smtp' || account.method === 'app_password';
    if (smtpish) {
      const host = account.smtpHost || 'smtp.gmail.com';
      const port = Number(account.smtpPort) || 587;
      const reachable = await probeSmtpTcp(host, port, 2500);
      console.log('[SMTP] send tcp probe', `${host}:${port}`, reachable ? 'open' : 'blocked');
      if (!reachable) {
        return res.json({
          message: 'Send from this PC',
          queued: false,
          via: 'client-smtp',
          id: String(queued._id),
          clientSmtp: {
            host,
            port,
            secure: Boolean(account.smtpSecure) || port === 465,
            user: account.smtpUser || account.email,
            pass: decryptSecret(account.appPasswordEnc),
            from: account.displayName
              ? `"${String(account.displayName).replace(/"/g, '')}" <${account.email}>`
              : account.email,
            to,
            subject,
            body
          }
        });
      }
    }

    const job = {
      sentId: queued._id,
      actorEmail: req.user.email,
      ip: req.ip,
      userAgent: req.get('user-agent') || ''
    };
    setImmediate(() => {
      deliverQueuedEmail(job).catch((err) => {
        console.warn('[email] background send failed:', err?.message || err);
      });
    });

    return res.json({
      message: 'Sending',
      queued: true,
      id: String(queued._id),
      from: account.email,
      to
    });
  } catch (error) {
    await logActivity({
      userId: req.user?.userId,
      actorEmail: req.user?.email,
      action: 'email.send',
      category: 'email',
      status: 'failure',
      message: error.message || 'Failed to send email',
      meta: {
        to: req.body?.to,
        subject: req.body?.subject
      },
      req
    });
    return res.status(error.status || 500).json({
      message: error.message || 'Failed to send email',
      code: error.code
    });
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oauthResultHtml({ ok, email, message }) {
  const title = ok ? 'Email connected' : "Couldn't connect that email";
  const emailLine = email
    ? `<p class="email">${escapeHtml(email)}</p>`
    : '';
  const desc = ok
    ? 'You can close this window and return to DAT.'
    : escapeHtml(message || 'Google denied the request or the window was closed before approval.');
  const payload = JSON.stringify({
    type: 'DAT_EMAIL_OAUTH_DONE',
    ok: Boolean(ok),
    email: email || '',
    message: message || ''
  }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #f1f5f9; color: #1e293b; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card {
      width: min(380px, 100%);
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 28px 24px 24px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
    }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 10px; color: #475569; font-size: 13px; line-height: 1.45; }
    .email { font-weight: 700; color: #0f172a; word-break: break-all; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      ${emailLine}
      <p>${desc}</p>
    </div>
  </div>
  <script>
    (function () {
      var payload = ${payload};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, '*');
        }
      } catch (e) {}
      try {
        localStorage.setItem('dat-email-oauth-result', JSON.stringify(Object.assign({}, payload, { at: Date.now() })));
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}

function redirectOAuthResult(res, params) {
  const ok = String(params?.status || '').toLowerCase() === 'ok';
  const html = oauthResultHtml({
    ok,
    email: params?.email,
    message: params?.message
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}

async function getOAuthUrl(req, res) {
  try {
    if (!isGoogleOAuthConfigured()) {
      const missing = googleOAuthMissingKeys();
      return res.status(400).json({
        message:
          'Google OAuth is not configured on this API server' +
          (missing.length ? ` (missing ${missing.join(', ')})` : '') +
          '. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in backend/.env and restart, or use App Password / SMTP.',
        code: 'OAUTH_NOT_CONFIGURED',
        missing
      });
    }
    const redirectUri = getOAuthRedirectUri(req);
    const state = signOAuthState(req.user.userId, redirectUri);
    rememberOAuth(req.user.userId, { status: 'pending', email: '', message: '' });
    return res.json({
      url: buildGoogleAuthUrl(state, redirectUri),
      redirectUri
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to start Google connect' });
  }
}

async function getOAuthResult(req, res) {
  const row = oauthResults.get(String(req.user.userId)) || { status: 'idle' };
  return res.json(row);
}

async function oauthCallback(req, res) {
  const fail = (msg, userId) => {
    rememberOAuth(userId, { status: 'error', message: String(msg || 'OAuth failed').slice(0, 300) });
    return redirectOAuthResult(res, {
      status: 'error',
      message: String(msg || 'OAuth failed').slice(0, 300)
    });
  };

  let userId = null;
  try {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    if (error) return fail(errorDescription || error, userId);
    if (!code || !state) return fail('Missing OAuth code', userId);

    const verified = verifyOAuthStateStrict(state);
    const decoded = decodeOAuthState(state);
    userId = (verified && verified.userId) || (decoded && decoded.userId) || userId;

    // Old Google clients may still land on localhost. Finish on the public API.
    if (shouldFinishOnCloud(req)) {
      console.log('[EMAIL] OAuth callback on localhost — finishing on public API');
      const cloud = await finishOAuthOnCloud(req);
      if (cloud.ok) {
        if (!cloud.email && userId) {
          const newest = await EmailAccount.findOne({ userId, method: 'oauth' }).sort({ connectedAt: -1 });
          if (newest?.email) cloud.email = newest.email;
        }
        rememberOAuth(userId, { status: 'ok', email: cloud.email, message: '' });
        return redirectOAuthResult(res, { status: 'ok', email: cloud.email });
      }
      console.warn('[EMAIL] Cloud OAuth finish failed:', cloud.status, cloud.message);
      return fail(
        cloud.message || 'Google rejected the sign-in. Close this window and click Connect Gmail once more.',
        userId
      );
    }

    if (!userId) return fail('Invalid OAuth state');
    const redirectUri = getOAuthRedirectUri();
    const tokens = await exchangeGoogleCode(String(code), redirectUri);
    const profile = await fetchGoogleProfile(tokens.access_token);
    const email = String(profile.email).toLowerCase();

    const payload = {
      userId,
      email,
      method: 'oauth',
      displayName: profile.name || '',
      refreshTokenEnc: encryptSecret(tokens.refresh_token || ''),
      accessTokenEnc: encryptSecret(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000),
      appPasswordEnc: '',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      connectedAt: new Date()
    };

    const existingOauth = await EmailAccount.findOne({ userId, email }).select('+refreshTokenEnc');
    let owner = null;
    if (!existingOauth) {
      owner = await User.findById(userId).select('permissions');
      try {
        await assertCanCreateEmailAccount(userId, owner?.permissions);
      } catch (limitErr) {
        return fail(limitErr.message, userId);
      }
    }

    if (!tokens.refresh_token) {
      if (existingOauth?.refreshTokenEnc) {
        payload.refreshTokenEnc = existingOauth.refreshTokenEnc;
      } else {
        return fail('Google did not return a refresh token. Remove app access and try again.', userId);
      }
    }

    if (!existingOauth) payload.allowed = true;

    const account = await EmailAccount.findOneAndUpdate({ userId, email }, payload, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    if (!owner) owner = await User.findById(userId).select('permissions');
    await applyAllowedOnConnect(account, userId, owner?.permissions, !existingOauth);
    if (!existingOauth) {
      await ensureDefaultAmongAllowed(userId, account.allowed === true ? account._id : null);
    } else {
      await ensureDefaultAmongAllowed(userId);
    }

    await logActivity({
      userId,
      actorEmail: email,
      action: 'email.connect',
      category: 'email',
      status: 'success',
      message: `Connected ${email} via Google OAuth`,
      meta: { accountId: String(account._id), email, method: 'oauth' },
      req
    });

    rememberOAuth(userId, { status: 'ok', email: profile.email, message: '' });
    return redirectOAuthResult(res, {
      status: 'ok',
      email: profile.email
    });
  } catch (error) {
    const raw = String(error.message || 'OAuth failed');
    const msg = /^unauthorized$/i.test(raw)
      ? 'Google rejected the sign-in. Close this window and click Connect Gmail once more.'
      : raw;
    console.warn('[EMAIL] OAuth callback failed:', raw);
    return fail(msg, userId);
  }
}

async function ackClientSend(req, res) {
  try {
    const sent = await EmailSent.findOne({
      _id: req.body?.id,
      userId: req.user.userId
    });
    if (!sent) return res.status(404).json({ message: 'Send record not found' });
    const ok = req.body?.ok !== false;
    sent.status = ok ? 'sent' : 'failed';
    sent.error = ok ? '' : String(req.body?.message || 'Desktop SMTP send failed');
    if (ok) {
      sent.sentAt = new Date();
      sent.messageId = String(req.body?.messageId || sent.messageId || '');
    }
    await sent.save();
    return res.json({ ok: true, status: sent.status });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to update send' });
  }
}

module.exports = {
  getStatus,
  connectAppPassword,
  connectSmtp,
  disconnect,
  setDefaultAccount,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  generateTemplateAi,
  sendEmail,
  ackClientSend,
  resumeQueuedEmails,
  getOAuthUrl,
  getOAuthResult,
  oauthCallback
};
