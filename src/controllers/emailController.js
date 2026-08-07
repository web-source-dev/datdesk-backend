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
  fetchGoogleProfile
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

async function getStatus(req, res) {
  try {
    const account = await EmailAccount.findOne({ userId: req.user.userId });
    const templates = await EmailTemplate.find({ userId: req.user.userId })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean();

    return res.json({
      connected: Boolean(account),
      account: account ? account.toSafeJSON() : null,
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
      connectedAt: new Date()
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

    const existing = await EmailAccount.findOne({ userId: req.user.userId }).select(
      '+appPasswordEnc +refreshTokenEnc +accessTokenEnc'
    );

    if (existing) {
      existing.email = email;
      existing.method = 'app_password';
      existing.appPasswordEnc = encryptSecret(appPassword);
      existing.refreshTokenEnc = '';
      existing.accessTokenEnc = '';
      existing.accessTokenExpiresAt = null;
      existing.displayName = displayName;
      existing.connectedAt = new Date();
      await existing.save();
      return res.json({ message: 'Email connected', account: existing.toSafeJSON() });
    }

    await draft.save();
    return res.status(201).json({ message: 'Email connected', account: draft.toSafeJSON() });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to connect email' });
  }
}

async function disconnect(req, res) {
  try {
    await EmailAccount.deleteOne({ userId: req.user.userId });
    return res.json({ message: 'Email disconnected', connected: false });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to disconnect' });
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
    const account = await EmailAccount.findOne({ userId: req.user.userId }).select(
      '+appPasswordEnc +refreshTokenEnc +accessTokenEnc'
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
    return res.json({ message: 'Email sent', ...result });
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to send email' });
  }
}

async function getOAuthUrl(req, res) {
  try {
    if (!isGoogleOAuthConfigured()) {
      return res.status(400).json({
        message:
          'Google OAuth is not configured. Use App Password, or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server.'
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

    const payload = {
      userId,
      email: String(profile.email).toLowerCase(),
      method: 'oauth',
      displayName: profile.name || '',
      refreshTokenEnc: encryptSecret(tokens.refresh_token || ''),
      accessTokenEnc: encryptSecret(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000),
      appPasswordEnc: '',
      connectedAt: new Date()
    };

    if (!tokens.refresh_token) {
      const existing = await EmailAccount.findOne({ userId }).select('+refreshTokenEnc');
      if (existing?.refreshTokenEnc) {
        payload.refreshTokenEnc = existing.refreshTokenEnc;
      } else {
        return fail('Google did not return a refresh token. Remove app access and try again.');
      }
    }

    await EmailAccount.findOneAndUpdate({ userId }, payload, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    return res.send(
      `<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#f8fafc;color:#0f172a">
        <h2 style="margin:0 0 8px">Gmail connected</h2>
        <p style="margin:0 0 16px">Signed in as <strong>${profile.email}</strong>. You can close this window and return to Horizon.</p>
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
  disconnect,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  sendEmail,
  getOAuthUrl,
  oauthCallback
};
