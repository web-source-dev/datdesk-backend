'use strict';

/**
 * Primary VPS that owns cookie files + update packages on disk.
 * Backup/Render backends set PRIMARY_ASSET_URL to that VPS and tunnel
 * cookie/update traffic there. Leave empty on the VPS itself.
 */
function clean(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

function getPrimaryAssetUrl() {
  return clean(process.env.PRIMARY_ASSET_URL || process.env.ASSET_ORIGIN || '');
}

function shouldTunnelAssets() {
  return Boolean(getPrimaryAssetUrl());
}

function getInternalAssetSecret() {
  return process.env.INTERNAL_ASSET_SECRET || process.env.JWT_SECRET || '';
}

module.exports = {
  clean,
  getPrimaryAssetUrl,
  shouldTunnelAssets,
  getInternalAssetSecret
};
