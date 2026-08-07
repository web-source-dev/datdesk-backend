const Cookie = require('../models/Cookie');
const { PartnerSwiftConfig, CONFIG_KEY } = require('../models/PartnerSwiftConfig');
const {
  getSlotLimit,
  getSessionAnchorForCookie,
  getCookieDisplayName,
  hasCookiePayload,
  pruneStaleDashboardSelection,
  sanitizeSelectedCookieIds,
  listPartnerExtensionAccounts
} = require('../services/partnerSwiftAccountsService');

async function getOrCreateConfig() {
  let config = await PartnerSwiftConfig.findOne({ key: CONFIG_KEY });
  if (!config) {
    config = await PartnerSwiftConfig.create({
      key: CONFIG_KEY,
      manualSelectionEnabled: false,
      selectedCookieIds: []
    });
  }
  return config;
}

function toCookieOption(cookie) {
  return {
    _id: cookie._id.toString(),
    fileName: cookie.fileName,
    sessionName: getCookieDisplayName(cookie) || null,
    sessionId: null,
    label: cookie.label || null,
    note: cookie.note || '',
    hasCookies: Boolean(cookie.hasCookies),
    ready: Boolean(cookie.hasCookies && hasCookiePayload(cookie)),
    isActiveSwiftSolutions: Boolean(cookie.isActiveSwiftSolutions)
  };
}

async function buildConfigPayload(config, { staleEntries = [], pruned = false, message } = {}) {
  const slotLimit = getSlotLimit();
  const cookies = await Cookie.find({ hasCookies: true })
    .sort({ fileName: 1 })
    .lean();

  const rawIds = (config.selectedCookieIds || []).map((id) => String(id));
  const rawAnchors = (config.selectedSessionAnchors || []).map((a) =>
    a ? String(a).trim() : null
  );
  const { validIds: selectedIds } = await sanitizeSelectedCookieIds(rawIds, rawAnchors);
  const cookieById = new Map(cookies.map((c) => [String(c._id), c]));

  const selectedAccounts = selectedIds
    .map((id) => cookieById.get(id))
    .filter(Boolean)
    .map(toCookieOption);

  const preview = await listPartnerExtensionAccounts({ maskSessionNames: false });

  return {
    ...(message ? { message } : {}),
    manualSelectionEnabled: Boolean(config.manualSelectionEnabled),
    selectedCookieIds: selectedIds,
    selectedAccounts,
    validSelectedCount: selectedAccounts.length,
    staleSelectedCount: staleEntries.length,
    staleRemoved: staleEntries,
    selectionPruned: pruned,
    slotLimit,
    availableCookies: cookies.map(toCookieOption),
    previewAccountCount: preview.accounts.length,
    previewAccounts: preview.accounts
  };
}

async function getDashboardConfig(_req, res) {
  try {
    const config = await getOrCreateConfig();
    const { staleEntries, pruned } = await pruneStaleDashboardSelection(config);

    const remapped = staleEntries.filter((e) => e.reason === 'replaced').length;
    const removed = staleEntries.length - remapped;

    return res.json(
      await buildConfigPayload(config, {
        staleEntries,
        pruned,
        ...(pruned
          ? {
              message:
                remapped > 0 && removed === 0
                  ? `Remapped ${remapped} account(s) after cookie update.`
                  : remapped > 0
                    ? `Remapped ${remapped} and removed ${removed} stale account(s).`
                    : `Removed ${removed} stale account(s) from selection.`
            }
          : {})
      })
    );
  } catch (error) {
    console.error('[PARTNER_SWIFT_CONFIG] get error:', error);
    return res.status(500).json({
      message: 'Failed to load Swift partner dashboard config',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

async function updateDashboardConfig(req, res) {
  try {
    const slotLimit = getSlotLimit();
    const { manualSelectionEnabled, selectedCookieIds } = req.body || {};
    const config = await getOrCreateConfig();

    if (manualSelectionEnabled === false) {
      config.manualSelectionEnabled = false;
      config.selectedCookieIds = [];
      config.selectedSessionAnchors = [];
    } else if (manualSelectionEnabled !== undefined) {
      config.manualSelectionEnabled = Boolean(manualSelectionEnabled);
    }

    if (selectedCookieIds !== undefined) {
      if (!Array.isArray(selectedCookieIds)) {
        return res.status(400).json({ message: 'selectedCookieIds must be an array' });
      }

      const uniqueIds = [
        ...new Set(selectedCookieIds.map((id) => String(id).trim()).filter(Boolean))
      ];

      if (uniqueIds.length > slotLimit) {
        return res.status(400).json({
          message: `You can select at most ${slotLimit} accounts for the Swift partner dashboard`
        });
      }

      const { validIds, sessionAnchors, staleEntries } =
        await sanitizeSelectedCookieIds(uniqueIds);
      const invalid = staleEntries.filter(
        (e) => e.reason === 'deleted' || e.reason === 'no_cookies'
      );

      if (invalid.length > 0) {
        return res.status(400).json({
          message:
            'One or more selected cookies are invalid or have no cookie data. Refresh and try again.',
          invalidIds: invalid.map((e) => e.id),
          staleRemoved: invalid
        });
      }

      config.selectedCookieIds = validIds;
      config.selectedSessionAnchors = sessionAnchors.filter(Boolean);
      if (validIds.length > 0) {
        config.manualSelectionEnabled = true;
      }
    } else {
      await pruneStaleDashboardSelection(config);
    }

    await config.save();

    return res.json(
      await buildConfigPayload(config, {
        message: 'Swift partner dashboard config saved'
      })
    );
  } catch (error) {
    console.error('[PARTNER_SWIFT_CONFIG] update error:', error);
    return res.status(500).json({
      message: 'Failed to update Swift partner dashboard config',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  getDashboardConfig,
  updateDashboardConfig,
  getSessionAnchorForCookie
};
