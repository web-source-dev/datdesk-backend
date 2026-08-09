const jwt = require('jsonwebtoken');
const EmailAccount = require('../models/EmailAccount');
const EmailTemplate = require('../models/EmailTemplate');
const { encryptSecret } = require('../utils/secretCrypto');
const {
  applyTemplate,
  verifyAccountCredentials,
  sendMail,
  isGoogleOAuthConfigured,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleProfile,
  normalizeSmtpSettings
} = require('../services/mailService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function oauthStateSecret() {
  return process.env.EMAIL_SECRET || process.env.JWT_SECRET || 'default-secret-change-this';
}

function signOAuthState(userId) {
  return jwt.sign({ userId: String(userId), purpose: 'gmail_oauth' }, oauthStateSecret(), {
    expiresIn: '15m'
  });
}

function verifyOAuthState(state) {
  const payload = jwt.verify(String(state || ''), oauthStateSecret());
  if (payload.purpose !== 'gmail_oauth' || !payload.userId) {
    throw new Error('Invalid OAuth state');
  }
  return payload;
}

async function listAccounts(userId) {
  return EmailAccount.find({ userId }).sort({ isDefault: -1, connectedAt: -1 });
}

async function ensureDefaultAccount(userId, preferredId) {
  const accounts = await listAccounts(userId);
  if (!accounts.length) return null;
  if (preferredId) {
    const match = accounts.find((a) => String(a._id) === String(preferredId));
    if (match) {
      if (!match.isDefault) {
        await EmailAccount.updateMany({ userId }, { $set: { isDefault: false } });
        match.isDefault = true;
        await match.save();
      }
      return match;
    }
  }
  const current = accounts.find((a) => a.isDefault) || accounts[0];
  if (!current.isDefault) {
    await EmailAccount.updateMany({ userId }, { $set: { isDefault: false } });
    current.isDefault = true;
    await current.save();
  }
  return current;
}

async function getStatus(req, res) {
  try {
    const accounts = await listAccounts(req.user.userId);
    const templates = await EmailTemplate.find({ userId: req.user.userId })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean();
    const defaultAccount = accounts.find((a) => a.isDefault) || accounts[0] || null;

    return res.json({
      connected: accounts.length > 0,
      account: defaultAccount ? defaultAccount.toSafeJSON() : null,
      accounts: accounts.map((a) => a.toSafeJSON()),
      oauthAvailable: isGoogleOAuthConfigured(),
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
          'Could not connect. Use a Gmail App Password (Google Account → Security → App passwords).'
      });
    }

    let account = await EmailAccount.findOne({
      userId: req.user.userId,
      email
    }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');

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
      await draft.save();
      account = draft;
    }

    if (makeDefault || !(await EmailAccount.exists({ userId: req.user.userId, isDefault: true }))) {
      await ensureDefaultAccount(req.user.userId, account._id);
      account = await EmailAccount.findById(account._id);
    }

    return res.status(account.wasNew ? 201 : 200).json({
      message: 'Email connected',
      account: account.toSafeJSON()
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to connect email' });
  }
}

async function connectSmtp(req, res) {
  try {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || req.body?.appPassword || '').trim();
    const displayName = String(req.body?.displayName || '').trim();
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

    const draft = new EmailAccount({
      userId: req.user.userId,
      email,
      method: 'smtp',
      appPasswordEnc: encryptSecret(password),
      displayName,
      smtpHost: normalized.host,
      smtpPort: normalized.port,
      smtpSecure: normalized.secure,
      connectedAt: new Date(),
      isDefault: false
    });

    let working;
    try {
      working = await verifyAccountCredentials(draft);
    } catch (err) {
      return res.status(400).json({
        message: err.message || 'Could not verify SMTP credentials. Check host, port, and password.'
      });
    }

    const finalHost = working?.host || normalized.host;
    const finalPort = working?.port || normalized.port;
    const finalSecure = working?.secure != null ? working.secure : normalized.secure;

    let account = await EmailAccount.findOne({
      userId: req.user.userId,
      email
    }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');

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
      account.connectedAt = new Date();
      await account.save();
    } else {
      draft.smtpHost = finalHost;
      draft.smtpPort = finalPort;
      draft.smtpSecure = finalSecure;
      await draft.save();
      account = draft;
    }

    if (makeDefault || !(await EmailAccount.exists({ userId: req.user.userId, isDefault: true }))) {
      await ensureDefaultAccount(req.user.userId, account._id);
      account = await EmailAccount.findById(account._id);
    }

    return res.status(201).json({ message: 'SMTP connected', account: account.toSafeJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to connect SMTP' });
  }
}

async function disconnect(req, res) {
  try {
    const accountId = req.body?.accountId || req.query?.accountId;
    if (accountId) {
      const result = await EmailAccount.deleteOne({
        _id: accountId,
        userId: req.user.userId
      });
      if (!result.deletedCount) {
        return res.status(404).json({ message: 'Account not found' });
      }
      await ensureDefaultAccount(req.user.userId);
      const accounts = await listAccounts(req.user.userId);
      return res.json({
        message: 'Email disconnected',
        connected: accounts.length > 0,
        accounts: accounts.map((a) => a.toSafeJSON())
      });
    }

    await EmailAccount.deleteMany({ userId: req.user.userId });
    return res.json({ message: 'Email disconnected', connected: false, accounts: [] });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to disconnect' });
  }
}

async function setDefaultAccount(req, res) {
  try {
    const accountId = req.body?.accountId;
    if (!accountId) return res.status(400).json({ message: 'accountId is required' });
    const account = await ensureDefaultAccount(req.user.userId, accountId);
    if (!account) return res.status(404).json({ message: 'Account not found' });
    const accounts = await listAccounts(req.user.userId);
    return res.json({
      message: 'Default account updated',
      account: account.toSafeJSON(),
      accounts: accounts.map((a) => a.toSafeJSON())
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to set default account' });
  }
}

async function listTemplates(req, res) {
  try {
    const templates = await EmailTemplate.find({ userId: req.user.userId }).sort({
      isDefault: -1,
      updatedAt: -1
    });
    return res.json({ templates: templates.map((t) => t.toSafeJSON()) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to list templates' });
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
    return res.status(500).json({ message: error.message || 'Failed to create template' });
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

async function sendEmail(req, res) {
  try {
    const accountId = req.body?.accountId;
    let account = null;
    if (accountId) {
      account = await EmailAccount.findOne({
        _id: accountId,
        userId: req.user.userId
      }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');
    } else {
      account = await EmailAccount.findOne({
        userId: req.user.userId,
        isDefault: true
      }).select('+appPasswordEnc +refreshTokenEnc +accessTokenEnc');
      if (!account) {
        account = await EmailAccount.findOne({ userId: req.user.userId }).select(
          '+appPasswordEnc +refreshTokenEnc +accessTokenEnc'
        );
      }
    }

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
      });
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

    const result = await sendMail({ account, to, subject, body });
    return res.json({ message: 'Email sent', from: account.email, ...result });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to send email' });
  }
}

async function getOAuthUrl(req, res) {
  try {
    if (!isGoogleOAuthConfigured()) {
      return res.status(400).json({
        message:
          'Google OAuth is not configured. Use App Password or SMTP, or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server.'
      });
    }
    const state = signOAuthState(req.user.userId);
    return res.json({ url: buildGoogleAuthUrl(state) });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to start Google connect' });
  }
}

async function oauthCallback(req, res) {
  const fail = (msg) =>
    res
      .status(400)
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px"><h2>Gmail connect failed</h2><p>${String(
          msg || 'Unknown error'
        )}</p><p>You can close this window.</p></body></html>`
      );

  try {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    if (error) return fail(errorDescription || error);
    if (!code || !state) return fail('Missing OAuth code');

    const { userId } = verifyOAuthState(state);
    const tokens = await exchangeGoogleCode(String(code));
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

    if (!tokens.refresh_token) {
      const existing = await EmailAccount.findOne({ userId, email }).select('+refreshTokenEnc');
      if (existing?.refreshTokenEnc) {
        payload.refreshTokenEnc = existing.refreshTokenEnc;
      } else {
        return fail('Google did not return a refresh token. Remove app access and try again.');
      }
    }

    const account = await EmailAccount.findOneAndUpdate({ userId, email }, payload, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    const hasDefault = await EmailAccount.exists({ userId, isDefault: true });
    if (!hasDefault) {
      await ensureDefaultAccount(userId, account._id);
    }

    return res.send(
      `<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#f8fafc;color:#0f172a">
        <h2 style="margin:0 0 8px">Gmail connected</h2>
        <p style="margin:0 0 16px">Signed in as <strong>${profile.email}</strong>. You can close this window and return to DAT.</p>
        <script>setTimeout(()=>window.close(),1200)</script>
      </body></html>`
    );
  } catch (error) {
    return fail(error.message || 'OAuth failed');
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
  sendEmail,
  getOAuthUrl,
  oauthCallback
};
