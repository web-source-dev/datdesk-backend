'use strict';

const freightdeskApiService = require('../services/freightdeskApiService');
const freightdeskImportService = require('../services/freightdeskImportService');
const freightdeskImportJobs = require('../services/freightdeskImportJobs');
const {
  normalizeCookieChannel,
  isValidCookieChannel
} = require('../utils/cookieChannels');
const { normalizeCookiePayload } = require('../utils/cookies');
const { sessionIdentity, shortAccountId, matchIdentities } = require('../utils/sessionIdentity');

async function enrichSessions(sessions = []) {
  const enriched = [];
  const identities = [];

  for (const item of sessions) {
    const container = String(item.container || '').toUpperCase();
    const status = await freightdeskImportService.getImportedCookieStatus(container);
    const imported = status.cookie;
    const remoteCookieCount =
      item.cookieCount || item.session?.['dat.com']?.cookies?.length || 0;
    // What "Import changed only" would do with this container right now.
    const remotePayload = item.session ? normalizeCookiePayload(item.session) : null;
    const plan = remotePayload
      ? freightdeskImportService.planFdImport(imported, remotePayload, 'changed')
      : null;
    // Which DAT account the cookies log into: FreightDesk's copy, else the DB copy.
    const remoteIdentity = remotePayload ? sessionIdentity(remotePayload) : null;
    const dbIdentity = imported?.data ? sessionIdentity(imported.data) : null;
    const identity =
      remoteIdentity && (remoteIdentity.accountId || !dbIdentity?.accountId) ? remoteIdentity : dbIdentity;
    if (identity) identities.push({ container, identity });

    enriched.push({
      container,
      cookieCount: imported?.cookieCount ?? remoteCookieCount,
      remoteCookieCount,
      localCookieCount: imported?.cookieCount ?? 0,
      lastUpdated:
        item.lastUpdated ||
        item.session?.['dat.com']?.lastUpdated ||
        imported?.lastUpdated ||
        imported?.updatedAt ||
        null,
      imported: status.imported,
      ready: status.ready,
      cookieId: imported?._id || null,
      fileName: imported?.fileName || freightdeskImportService.containerFileName(container),
      label: item.label || imported?.label || 'new',
      isActiveSingle: Boolean(imported?.isActiveSingle),
      isActiveDouble: Boolean(imported?.isActiveDouble),
      isActiveMulti: Boolean(imported?.isActiveMulti),
      isActiveHorizon: Boolean(imported?.isActiveHorizon),
      isActiveSwiftSolutions: Boolean(imported?.isActiveSwiftSolutions),
      isActiveTest: Boolean(imported?.isActiveTest),
      isActive: Boolean(imported?.isActive),
      isWorking: Boolean(imported?.isWorking),
      changeStatus: plan ? plan.status : null,
      changeReason: plan ? plan.reason : null,
      diff: plan ? plan.diff : null,
      authExpiresAt: imported?.authExpiresAt || null,
      fdImportedAt: imported?.fdImportedAt || null,
      syncedAt: imported?.syncedAt || null,
      syncedBy: imported?.syncedBy || '',
      accountId: identity?.accountId || '',
      accountShortId: shortAccountId(identity?.accountId),
      accountEmail: identity?.email || '',
      accountName: identity?.name || '',
      accountPlan: identity?.plan || '',
      accountSource: identity?.source || '',
      // Remote (FreightDesk) vs DB (imported) account details, so the card can show both
      // when they differ (someone pushed a different account on the same container).
      remoteAccountShortId: shortAccountId(remoteIdentity?.accountId),
      remoteAccountEmail: remoteIdentity?.email || '',
      remoteAccountName: remoteIdentity?.name || '',
      dbAccountEmail: dbIdentity?.email || '',
      dbAccountName: dbIdentity?.name || '',
      // FreightDesk now holds a different DAT account than the DB copy.
      accountChanged: Boolean(
        remoteIdentity?.accountId &&
          dbIdentity?.accountId &&
          remoteIdentity.accountId !== dbIdentity.accountId
      ),
      dbAccountShortId: shortAccountId(dbIdentity?.accountId)
    });
  }

  const matches = matchIdentities(identities);
  for (const entry of enriched) {
    const match = matches.get(entry.container);
    entry.sameAccountAs = match?.sameAccountAs || [];
    entry.sameBrowserAs = match?.sameBrowserAs || [];
  }

  return enriched.sort((a, b) => a.container.localeCompare(b.container));
}

async function getStatus(_req, res) {
  res.json({
    configured: freightdeskApiService.isConfigured(),
    apiUrl: process.env.FREIGHTDESK_API_URL || 'https://freightdesk.rtnglobal.co'
  });
}

async function listSessions(_req, res) {
  try {
    const data = await freightdeskApiService.fetchAllSessions();
    const sessions = await enrichSessions(data.sessions || []);

    res.json({
      success: true,
      count: sessions.length,
      failed: data.failed || 0,
      sessions,
      errors: data.errors || {}
    });
  } catch (error) {
    console.error('[FreightDesk] listSessions error:', error);
    res.status(error.status || 500).json({
      message: error.message || 'Failed to load FreightDesk container sessions.'
    });
  }
}

async function importContainer(req, res) {
  try {
    const container = String(req.params.container || '').toUpperCase();
    const activate = Boolean(req.body?.activate);
    const mode = freightdeskImportService.normalizeImportMode(req.body?.mode);
    const rawChannel = req.body?.channel || 'single';

    if (activate && !isValidCookieChannel(rawChannel)) {
      return res.status(400).json({ message: 'Invalid cookie channel.' });
    }
    const channel = normalizeCookieChannel(rawChannel);

    if (activate) {
      const result = await freightdeskImportService.activateImportedCookie(container, channel, {
        mode
      });
      const kept = result.status === 'kept-newer' || result.status === 'unchanged';
      return res.json({
        success: true,
        message: kept
          ? `Activated container ${container} for ${result.channelName} (kept server copy: ${result.reason})`
          : `Imported and activated container ${container} for ${result.channelName}`,
        container,
        cookie: result.cookie,
        activated: true,
        channel,
        imported: !kept,
        status: result.status,
        reason: result.reason,
        diff: result.diff
      });
    }

    const outcome = await freightdeskImportService.importContainerFromRemote(container, { mode });
    const imported = outcome.action === 'import';

    res.json({
      success: true,
      message: imported
        ? `Imported container ${container}`
        : `Not imported ${container}: ${outcome.reason}`,
      container,
      cookie: freightdeskImportService.toSafeCookie(outcome.cookie),
      activated: false,
      channel: null,
      imported,
      status: outcome.status,
      reason: outcome.reason,
      diff: outcome.diff
    });
  } catch (error) {
    console.error('[FreightDesk] importContainer error:', error);
    res.status(error.status || 500).json({
      message: error.message || 'Failed to import FreightDesk container session.'
    });
  }
}

async function importAllContainers(req, res) {
  try {
    // Background job — avoids reverse-proxy timeouts that look like CORS failures.
    const job = await freightdeskImportJobs.startImportAllJob({
      activate: Boolean(req.body?.activate),
      channel: req.body?.channel || 'single',
      mode: freightdeskImportService.normalizeImportMode(req.body?.mode)
    });

    return res.status(202).json({
      success: true,
      isAsync: true,
      async: true,
      jobId: job.id,
      status: job.status,
      message: 'Import started…'
    });
  } catch (error) {
    console.error('[FreightDesk] importAllContainers error:', error);
    if (error.status === 409 && error.jobId) {
      return res.status(409).json({
        message: error.message,
        jobId: error.jobId,
        status: 'running'
      });
    }
    res.status(error.status || 500).json({
      message: error.message || 'Failed to import FreightDesk container sessions.'
    });
  }
}

async function getImportAllJob(req, res) {
  try {
    const job = await freightdeskImportJobs.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ message: 'Import job not found (expired or invalid id).' });
    }
    res.json({
      success: true,
      ...freightdeskImportJobs.publicJob(job)
    });
  } catch (error) {
    console.error('[FreightDesk] getImportAllJob error:', error);
    res.status(500).json({ message: error.message || 'Failed to read import job.' });
  }
}

async function activateImportedCookie(req, res) {
  try {
    const container = String(req.params.container || '').toUpperCase();
    const result = await freightdeskImportService.activateImportedCookie(
      container,
      req.body?.channel || 'single'
    );

    res.json({
      success: true,
      message: `Activated container ${container} for ${result.channelName}`,
      container: result.container,
      channel: result.channel,
      cookie: result.cookie
    });
  } catch (error) {
    console.error('[FreightDesk] activateImportedCookie error:', error);
    res.status(error.status === 404 ? 404 : 500).json({
      message: error.message || 'Failed to activate imported cookie.'
    });
  }
}

async function updateContainerLabel(req, res) {
  try {
    const container = String(req.params.container || '').toUpperCase();
    const { label } = req.body || {};

    const cookie = await freightdeskImportService.updateContainerLabel(container, label);

    res.json({
      success: true,
      message: `Label updated to ${label} for container ${container}`,
      container,
      cookie
    });
  } catch (error) {
    console.error('[FreightDesk] updateContainerLabel error:', error);
    res.status(500).json({
      message: error.message || 'Failed to update container label.'
    });
  }
}

async function setWorkingStatus(req, res) {
  try {
    const container = String(req.params.container || '').toUpperCase();
    const isWorking = req.body?.isWorking === true || req.body?.isWorking === 'true';

    const cookie = await freightdeskImportService.setWorkingStatus(container, isWorking);

    res.json({
      success: true,
      message: `Container ${container} marked as ${isWorking ? 'working' : 'not working'}`,
      container,
      cookie
    });
  } catch (error) {
    console.error('[FreightDesk] setWorkingStatus error:', error);
    res.status(error.message?.includes('Import this') ? 404 : 500).json({
      message: error.message || 'Failed to update working status.'
    });
  }
}

/**
 * POST /freightdesk/import-separate/:container
 * "Keep both": import FreightDesk's CURRENT session as a new standalone cookie without
 * overwriting the existing imported copy. For when FreightDesk holds a different account
 * than the DB copy and the admin wants both available on the Cookies page.
 */
async function importSeparate(req, res) {
  try {
    const container = String(req.params.container || '').toUpperCase();
    const result = await freightdeskImportService.importContainerAsSeparate(container);
    const safe = result.cookie.toObject();
    delete safe.data;
    return res.json({
      success: true,
      message:
        `Added a separate cookie for container ${container}` +
        (result.email ? ` (${result.email})` : '') +
        '. Activate it on the Cookies page.',
      container,
      cookie: safe,
      accountId: result.accountId,
      email: result.email,
      name: result.name
    });
  } catch (error) {
    console.error('[FD] importSeparate error:', error);
    return res
      .status(500)
      .json({ message: error.message || 'Failed to import container as a separate cookie' });
  }
}

module.exports = {
  getStatus,
  listSessions,
  importContainer,
  importSeparate,
  importAllContainers,
  getImportAllJob,
  activateImportedCookie,
  updateContainerLabel,
  setWorkingStatus
};
