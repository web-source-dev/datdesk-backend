const EmailAccount = require('../models/EmailAccount');
const EmailTemplate = require('../models/EmailTemplate');
const {
  getMaxEmailAccounts,
  getMaxTemplates,
  isAtLimit,
  normalizePermissions
} = require('../utils/permissions');

function limitError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 403;
  return err;
}

function accountLimitMessage(max) {
  if (max === 1) {
    return 'Your account allows 1 connected email. Ask an admin to remove one before adding another.';
  }
  return `Your account allows ${max} connected emails. Ask an admin to remove one before adding another.`;
}

function templateLimitMessage(max) {
  if (max === 1) {
    return 'Your account allows 1 template. Delete one to create another.';
  }
  return `Your account allows ${max} templates. Delete one to create another.`;
}

function accountIdOf(account) {
  if (!account) return '';
  return String(account.id || account._id || '');
}

function rankAccountsForLimit(accounts) {
  return (Array.isArray(accounts) ? accounts.slice() : []).sort((a, b) => {
    const da = a && a.isDefault ? 1 : 0;
    const db = b && b.isDefault ? 1 : 0;
    if (da !== db) return db - da;
    const ta = new Date(a && a.connectedAt ? a.connectedAt : 0).getTime();
    const tb = new Date(b && b.connectedAt ? b.connectedAt : 0).getTime();
    return tb - ta;
  });
}

function getUsableAccountIds(accounts, max) {
  const list = Array.isArray(accounts) ? accounts : [];
  const cap = Number(max) || 0;
  if (!list.length) return new Set();
  if (cap <= 0) return new Set(list.map(accountIdOf).filter(Boolean));
  return new Set(rankAccountsForLimit(list).slice(0, cap).map(accountIdOf).filter(Boolean));
}

function isAccountUsable(account, accounts, max) {
  const id = accountIdOf(account);
  if (!id) return false;
  return getUsableAccountIds(accounts, max).has(id);
}

function unusableAccountMessage() {
  return 'This email is over your limit and cannot send. Turn on Use default to use it, or ask an admin to remove extras.';
}

async function assertCanCreateEmailAccount(userId, permissions) {
  const max = getMaxEmailAccounts(permissions);
  if (!max) return;
  const used = await EmailAccount.countDocuments({ userId });
  if (isAtLimit(used, max)) {
    throw limitError('EMAIL_ACCOUNT_LIMIT', accountLimitMessage(max));
  }
}

async function assertCanCreateTemplate(userId, permissions) {
  const max = getMaxTemplates(permissions);
  if (!max) return;
  const used = await EmailTemplate.countDocuments({ userId });
  if (isAtLimit(used, max)) {
    throw limitError('EMAIL_TEMPLATE_LIMIT', templateLimitMessage(max));
  }
}

function buildLimitsPayload(permissions, accountsUsed, templatesUsed, usableAccounts) {
  const perms = normalizePermissions(permissions);
  const used = Number(accountsUsed) || 0;
  const usable =
    usableAccounts == null
      ? used
      : Number(usableAccounts) || 0;
  return {
    maxEmailAccounts: perms.maxEmailAccounts,
    maxTemplates: perms.maxTemplates,
    emailAccountsUsed: used,
    emailAccountsUsable: perms.maxEmailAccounts > 0 ? Math.min(used, usable) : used,
    templatesUsed: Number(templatesUsed) || 0
  };
}

module.exports = {
  assertCanCreateEmailAccount,
  assertCanCreateTemplate,
  buildLimitsPayload,
  getMaxTemplates,
  getMaxEmailAccounts,
  getUsableAccountIds,
  isAccountUsable,
  accountIdOf,
  unusableAccountMessage
};
