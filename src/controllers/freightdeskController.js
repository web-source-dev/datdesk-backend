'use strict';

const freightdeskApiService = require('../services/freightdeskApiService');
const freightdeskImportService = require('../services/freightdeskImportService');
const {
  normalizeCookieChannel,
  isValidCookieChannel
} = require('../utils/cookieChannels');

async function enrichSessions(sessions = []) {
  const enriched = [];

  for (const item of sessions) {
    const container = String(item.container || '').toUpperCase();
    const status = await freightdeskImportService.getImportedCookieStatus(container);
    const imported = status.cookie;
    const remoteCookieCount =
      item.cookieCount || item.session?.['dat.com']?.cookies?.length || 0;

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
      isActiveSwiftSolutions: Boolean(imported?.isActiveSwiftSolutions),
      isActiveTest: Boolean(imported?.isActiveTest),
      isActive: Boolean(imported?.isActive),
      isWorking: Boolean(imported?.isWorking)
    });
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
    const forceReimport = req.body?.forceReimport !== false;
    const rawChannel = req.body?.channel || 'single';

    if (activate && !isValidCookieChannel(rawChannel)) {
      return res.status(400).json({ message: 'Invalid cookie channel.' });
    }
    const channel = normalizeCookieChannel(rawChannel);

    if (activate) {
      const result = await freightdeskImportService.activateImportedCookie(container, channel);
      return res.json({
        success: true,
        message: `Imported and activated container ${container} for ${result.channelName}`,
        container,
        cookie: result.cookie,
        activated: true,
        channel
      });
    }

    const cookie = await freightdeskImportService.importContainerFromRemote(container, {
      forceReimport
    });

    res.json({
      success: true,
      message: `Imported container ${container}`,
      container,
      cookie: freightdeskImportService.toSafeCookie(cookie),
      activated: false,
      channel: null
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
    const result = await freightdeskImportService.importAllContainers({
      activate: Boolean(req.body?.activate),
      channel: req.body?.channel || 'single',
      forceReimport: req.body?.forceReimport !== false
    });

    if (result.skipped) {
      return res.status(503).json({ message: result.reason });
    }

    res.json({
      success: true,
      ...result,
      message: `Imported ${result.imported} container(s)${result.failed ? `, ${result.failed} failed` : ''}`
    });
  } catch (error) {
    console.error('[FreightDesk] importAllContainers error:', error);
    res.status(error.status || 500).json({
      message: error.message || 'Failed to import FreightDesk container sessions.'
    });
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

module.exports = {
  getStatus,
  listSessions,
  importContainer,
  importAllContainers,
  activateImportedCookie,
  updateContainerLabel,
  setWorkingStatus
};
