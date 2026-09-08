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

function isAllowedFlag(account) {
  if (!account) return false;
  return account.allowed === true;
}

/** Oldest connected first. Default must never change this order. */
function sortAccountsStable(accounts) {
  return (Array.isArray(accounts) ? accounts.slice() : []).sort((a, b) => {
    const ta = new Date(a && a.connectedAt ? a.connectedAt : 0).getTime();
    const tb = new Date(b && b.connectedAt ? b.connectedAt : 0).getTime();
    if (ta !== tb) return ta - tb;
    return String(accountIdOf(a)).localeCompare(String(accountIdOf(b)));
  });
}

function getUsableAccountIds(accounts, max) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return new Set();
  const cap = Number(max) || 0;
  if (cap <= 0) {
    return new Set(list.filter((a) => a && a.allowed !== false).map(accountIdOf).filter(Boolean));
  }
  return new Set(list.filter(isAllowedFlag).map(accountIdOf).filter(Boolean));
}

function isAccountUsable(account, accounts, max) {
  const id = accountIdOf(account);
  if (!id) return false;
  return getUsableAccountIds(accounts, max).has(id);
}

function unusableAccountMessage() {
  return 'This email is over your limit and cannot send. Ask an admin to enable it.';
}

async function listUserAccounts(userId) {
  const accounts = await EmailAccount.find({ userId });
  return sortAccountsStable(accounts);
}

async function ensureDefaultAmongAllowed(userId, preferredId) {
  const accounts = await listUserAccounts(userId);
  if (!accounts.length) return null;
  const pool = accounts.filter(isAllowedFlag);
  if (!pool.length) {
    if (accounts.some((a) => a.isDefault)) {
      await EmailAccount.updateMany({ userId }, { $set: { isDefault: false } });
    }
    return null;
  }
  let chosen = null;
  if (preferredId) {
    chosen = pool.find((a) => String(a._id) === String(preferredId)) || null;
  }
  if (!chosen) chosen = pool.find((a) => a.isDefault) || pool[0];
  await EmailAccount.updateMany({ userId }, { $set: { isDefault: false } });
  await EmailAccount.updateOne({ _id: chosen._id }, { $set: { isDefault: true } });
  chosen.isDefault = true;
  return chosen;
}

/**
 * Lock a stable allowlist to maxEmailAccounts.
 * Lowering the cap disables extra currently-allowed inboxes.
 * Raising the cap does not auto-enable extras — admin must pick them.
 */
async function syncAllowedAccounts(userId, permissions) {
  const max = getMaxEmailAccounts(permissions);
  const accounts = await listUserAccounts(userId);
  if (!accounts.length) return accounts;

  if (max <= 0) {
    const needEnable = accounts.filter((a) => a.allowed !== true);
    if (needEnable.length) {
      await EmailAccount.updateMany({ userId }, { $set: { allowed: true } });
    }
    await ensureDefaultAmongAllowed(userId);
    return listUserAccounts(userId);
  }

  const hasExplicit = accounts.some((a) => typeof a.allowed === 'boolean');
  const ordered = sortAccountsStable(accounts);

  if (!hasExplicit) {
    const keep = ordered.slice(0, max);
    const drop = ordered.slice(max);
    if (keep.length) {
      await EmailAccount.updateMany({ _id: { $in: keep.map((a) => a._id) } }, { $set: { allowed: true } });
    }
    if (drop.length) {
      await EmailAccount.updateMany(
        { _id: { $in: drop.map((a) => a._id) } },
        { $set: { allowed: false, isDefault: false } }
      );
    }
  } else {
    const currentlyAllowed = sortAccountsStable(
      accounts.filter((a) => a.allowed === true || typeof a.allowed !== 'boolean')
    );
    if (currentlyAllowed.length > max) {
      const keep = currentlyAllowed.slice(0, max);
      const drop = currentlyAllowed.slice(max);
      if (keep.length) {
        await EmailAccount.updateMany({ _id: { $in: keep.map((a) => a._id) } }, { $set: { allowed: true } });
      }
      if (drop.length) {
        await EmailAccount.updateMany(
          { _id: { $in: drop.map((a) => a._id) } },
          { $set: { allowed: false, isDefault: false } }
        );
      }
    } else {
      const persistTrue = currentlyAllowed.filter((a) => a.allowed !== true).map((a) => a._id);
      if (persistTrue.length) {
        await EmailAccount.updateMany({ _id: { $in: persistTrue } }, { $set: { allowed: true } });
      }
    }
  }

  await ensureDefaultAmongAllowed(userId);
  return listUserAccounts(userId);
}

async function applyAllowedOnConnect(account, userId, permissions, created) {
  if (!account) return account;
  if (!created) return account;
  const max = getMaxEmailAccounts(permissions);
  if (max <= 0) {
    if (account.allowed !== true) {
      account.allowed = true;
      await account.save();
    }
    return account;
  }
  const others = await EmailAccount.countDocuments({
    userId,
    allowed: true,
    _id: { $ne: account._id }
  });
  const next = others < max;
  if (account.allowed !== next) {
    account.allowed = next;
    await account.save();
  }
  return account;
}

async function setAccountAllowed(userId, accountId, allowed, permissions) {
  const account = await EmailAccount.findOne({ _id: accountId, userId });
  if (!account) {
    const err = new Error('Email account not found');
    err.status = 404;
    throw err;
  }
  const next = Boolean(allowed);
  const max = getMaxEmailAccounts(permissions);
  if (next && max > 0) {
    const count = await EmailAccount.countDocuments({
      userId,
      allowed: true,
      _id: { $ne: account._id }
    });
    if (count >= max) {
      throw limitError(
        'EMAIL_ACCOUNT_LIMIT',
        max === 1
          ? 'This user can only send from 1 email. Disable another, or raise the limit.'
          : `This user can only send from ${max} emails. Disable another, or raise the limit.`
      );
    }
  }
  account.allowed = next;
  if (!next && account.isDefault) account.isDefault = false;
  await account.save();
  await ensureDefaultAmongAllowed(userId);
  return listUserAccounts(userId);
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
  applyAllowedOnConnect,
  buildLimitsPayload,
  ensureDefaultAmongAllowed,
  getMaxTemplates,
  getMaxEmailAccounts,
  getUsableAccountIds,
  isAccountUsable,
  isAllowedFlag,
  accountIdOf,
  listUserAccounts,
  setAccountAllowed,
  syncAllowedAccounts,
  unusableAccountMessage
};
