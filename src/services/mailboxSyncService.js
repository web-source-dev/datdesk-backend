const cron = require('node-cron');
const EmailAccount = require('../models/EmailAccount');
const EmailSyncState = require('../models/EmailSyncState');
const MailboxMessage = require('../models/MailboxMessage');
const {
  fetchMailboxMessagesBatch,
  canFetchLifetimeForAccount
} = require('./mailService');
const { processUnprocessedMessages } = require('./freightIntelligenceService');
const { logActivity } = require('./activityLogService');

let started = false;
let running = false;
let lastRunAt = null;
let lastRunResult = null;
let cronTask = null;

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getSyncConfig() {
  return {
    enabled: envBool('MAILBOX_SYNC_CRON_ENABLED', true),
    /** every 5 minutes by default */
    cronExpr: String(process.env.MAILBOX_SYNC_CRON || '*/5 * * * *').trim(),
    perAccountLimit: envInt('MAILBOX_SYNC_BATCH_SIZE', 50),
    processLimit: envInt('MAILBOX_SYNC_PROCESS_LIMIT', 150),
    maxAccountsPerTick: envInt('MAILBOX_SYNC_MAX_ACCOUNTS', 20),
    /** skip accounts that failed many times until cooldown */
    failureCooldownMin: envInt('MAILBOX_SYNC_FAILURE_COOLDOWN_MIN', 30)
  };
}

async function ensureSyncState(account) {
  let state = await EmailSyncState.findOne({ accountId: account._id });
  if (!state) {
    state = await EmailSyncState.create({
      accountId: account._id,
      userId: account.userId,
      enabled: true
    });
  }
  return state;
}

async function syncOneAccount(account, { maxMessages = 50 } = {}) {
  if (!canFetchLifetimeForAccount(account)) {
    return { skipped: true, reason: 'unsupported_method' };
  }

  const state = await ensureSyncState(account);
  if (state.enabled === false) {
    return { skipped: true, reason: 'disabled' };
  }

  const cfg = getSyncConfig();
  if (
    state.consecutiveFailures >= 5 &&
    state.lastErrorAt &&
    Date.now() - new Date(state.lastErrorAt).getTime() < cfg.failureCooldownMin * 60_000
  ) {
    return { skipped: true, reason: 'cooldown' };
  }

  const pageToken =
    account.method === 'oauth' ? state.gmailPageToken || '' : state.imapPageToken || '';

  // Incremental: prefer recent mail. For Gmail API use newer_than query after first full-ish pull.
  const q =
    account.method === 'oauth' && state.totalFetched > 0
      ? 'newer_than:2d'
      : account.method === 'oauth'
        ? ''
        : '';

  state.lastSyncAt = new Date();
  await state.save();

  try {
    const fullAccount = await EmailAccount.findById(account._id).select(
      '+appPasswordEnc +refreshTokenEnc +accessTokenEnc'
    );
    const batch = await fetchMailboxMessagesBatch(fullAccount, {
      maxMessages,
      pageToken: state.totalFetched > 200 ? '' : pageToken,
      q
    });

    const provider = batch.provider || (account.method === 'oauth' ? 'gmail' : 'imap');
    let upserted = 0;
    for (const msg of batch.messages) {
      await MailboxMessage.findOneAndUpdate(
        { accountId: account._id, providerMessageId: msg.providerMessageId },
        {
          $set: {
            userId: account.userId,
            accountId: account._id,
            provider,
            ...msg,
            syncedAt: new Date()
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      upserted += 1;
    }

    const intel = await processUnprocessedMessages({
      limit: Math.min(cfg.processLimit, Math.max(upserted, 20)),
      accountId: account._id
    });

    if (account.method === 'oauth') {
      // Keep page token only while doing historical backfill; after that use newer_than query
      state.gmailPageToken = state.totalFetched < 500 ? batch.nextPageToken || '' : '';
    } else {
      state.imapPageToken = state.totalFetched < 500 ? batch.nextPageToken || '' : '';
    }

    state.lastSuccessAt = new Date();
    state.lastError = '';
    state.lastErrorAt = null;
    state.consecutiveFailures = 0;
    state.lastFetched = batch.fetched || 0;
    state.lastUpserted = upserted;
    state.lastProcessed = intel.processed || 0;
    state.totalFetched = (state.totalFetched || 0) + upserted;
    state.totalProcessed = (state.totalProcessed || 0) + (intel.processed || 0);
    state.meta = {
      provider,
      hasMore: Boolean(batch.nextPageToken),
      resultSizeEstimate: batch.resultSizeEstimate || 0,
      intelligence: intel
    };
    await state.save();

    return {
      skipped: false,
      accountId: String(account._id),
      email: account.email,
      upserted,
      fetched: batch.fetched || 0,
      processed: intel.processed || 0,
      loadsTouched: intel.loadsTouched || 0,
      hasMore: Boolean(batch.nextPageToken)
    };
  } catch (err) {
    state.lastErrorAt = new Date();
    state.lastError = String(err?.message || err).slice(0, 2000);
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    await state.save();
    return {
      skipped: false,
      error: true,
      accountId: String(account._id),
      email: account.email,
      message: err?.message || String(err)
    };
  }
}

/**
 * One full tick across connected accounts.
 */
async function runMailboxSyncTick({ triggeredBy = 'cron' } = {}) {
  if (running) {
    return { skipped: true, reason: 'already_running', lastRunAt, lastRunResult };
  }
  running = true;
  const startedAt = new Date();
  const cfg = getSyncConfig();

  try {
    const accounts = await EmailAccount.find({})
      .sort({ updatedAt: -1 })
      .limit(cfg.maxAccountsPerTick);

    const results = [];
    let synced = 0;
    let errors = 0;
    let upserted = 0;
    let processed = 0;

    for (const account of accounts) {
      if (!canFetchLifetimeForAccount(account)) continue;
      try {
        const r = await syncOneAccount(account, { maxMessages: cfg.perAccountLimit });
        results.push(r);
        if (r.error) errors += 1;
        else if (!r.skipped) {
          synced += 1;
          upserted += r.upserted || 0;
          processed += r.processed || 0;
        }
      } catch (err) {
        errors += 1;
        results.push({
          error: true,
          accountId: String(account._id),
          email: account.email,
          message: err?.message || String(err)
        });
        console.warn('[mailbox-sync] account failed', account.email, err?.message || err);
      }
    }

    // Sweep leftover unprocessed messages globally (noise filtered inside processor)
    const sweep = await processUnprocessedMessages({ limit: cfg.processLimit });

    lastRunAt = startedAt;
    lastRunResult = {
      triggeredBy,
      startedAt,
      finishedAt: new Date(),
      accountsConsidered: accounts.length,
      synced,
      errors,
      upserted,
      processed: processed + (sweep.processed || 0),
      sweep,
      results: results.slice(0, 50)
    };

    if (synced || errors) {
      await logActivity({
        action: 'email.mailbox_sync_tick',
        category: 'system',
        status: errors && !synced ? 'failure' : 'success',
        message: `Mailbox sync: ${synced} accounts, ${upserted} upserted, ${lastRunResult.processed} processed, ${errors} errors`,
        meta: {
          triggeredBy,
          synced,
          errors,
          upserted,
          processed: lastRunResult.processed
        }
      });
    }

    console.log(
      `[mailbox-sync] tick done — accounts=${synced}/${accounts.length} upserted=${upserted} processed=${lastRunResult.processed} errors=${errors}`
    );
    return lastRunResult;
  } finally {
    running = false;
  }
}

function getMailboxSyncStatus() {
  const cfg = getSyncConfig();
  return {
    enabled: cfg.enabled,
    cronExpr: cfg.cronExpr,
    running,
    started,
    lastRunAt,
    lastRunResult,
    config: cfg
  };
}

function startMailboxSyncCron() {
  if (started) return getMailboxSyncStatus();
  const cfg = getSyncConfig();
  if (!cfg.enabled) {
    console.log('[mailbox-sync] cron disabled (MAILBOX_SYNC_CRON_ENABLED=false)');
    return getMailboxSyncStatus();
  }
  if (!cron.validate(cfg.cronExpr)) {
    console.warn('[mailbox-sync] invalid cron expression:', cfg.cronExpr);
    return getMailboxSyncStatus();
  }

  cronTask = cron.schedule(cfg.cronExpr, () => {
    runMailboxSyncTick({ triggeredBy: 'cron' }).catch((err) => {
      console.warn('[mailbox-sync] tick failed:', err?.message || err);
    });
  });
  started = true;
  console.log(`[mailbox-sync] cron started (${cfg.cronExpr})`);

  // Kick once shortly after boot so dashboard fills without waiting
  setTimeout(() => {
    runMailboxSyncTick({ triggeredBy: 'startup' }).catch((err) => {
      console.warn('[mailbox-sync] startup tick failed:', err?.message || err);
    });
  }, 15_000);

  return getMailboxSyncStatus();
}

function stopMailboxSyncCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  started = false;
}

module.exports = {
  startMailboxSyncCron,
  stopMailboxSyncCron,
  runMailboxSyncTick,
  syncOneAccount,
  getMailboxSyncStatus,
  getSyncConfig
};
