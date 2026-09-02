const DEFAULT_PERMISSIONS = {
  openDat: true,
  datMultitab: false,
  datMultitabNumbers: 1,
  webMultitab: false,
  webMultitabNumbers: 1,
  /** Load managed Chromium extensions (Signal, etc.) into the desktop apps */
  extensionsEnabled: true,
  /** When false, desktop apps must use a direct connection (no proxy). */
  proxyEnabled: true,
  /** 0 = unlimited. Caps how many sending emails this user can connect. */
  maxEmailAccounts: 0,
  /** 0 = unlimited. Caps how many email templates this user can create. */
  maxTemplates: 0,
  customTabs: []
};

function clampTabCount(n, fallback = 1) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(10, Math.max(1, Math.round(num)));
}

function clampLimit(n, fallback = 0) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(100, Math.max(0, Math.round(num)));
}

function normalizeCustomTab(tab) {
  if (!tab || typeof tab !== 'object') return null;
  const title = String(tab.title || '').trim();
  const url = String(tab.url || '').trim();
  if (!title || !url) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  return {
    id: String(tab.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    title,
    url,
    enabled: tab.enabled !== false,
    openMode: tab.openMode === 'external' ? 'external' : 'app'
  };
}

function normalizePermissions(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const customTabs = Array.isArray(src.customTabs)
    ? src.customTabs.map(normalizeCustomTab).filter(Boolean)
    : [];

  return {
    openDat: src.openDat !== false,
    datMultitab: !!src.datMultitab,
    datMultitabNumbers: clampTabCount(src.datMultitabNumbers, 1),
    webMultitab: !!src.webMultitab,
    webMultitabNumbers: clampTabCount(src.webMultitabNumbers, 1),
    extensionsEnabled: src.extensionsEnabled !== false,
    proxyEnabled: src.proxyEnabled !== false,
    maxEmailAccounts: clampLimit(src.maxEmailAccounts, DEFAULT_PERMISSIONS.maxEmailAccounts),
    maxTemplates: clampLimit(src.maxTemplates, DEFAULT_PERMISSIONS.maxTemplates),
    customTabs
  };
}

function isExtensionsEnabled(permissions) {
  return normalizePermissions(permissions).extensionsEnabled !== false;
}

function isProxyEnabled(permissions) {
  return normalizePermissions(permissions).proxyEnabled !== false;
}

function getEnabledCustomTabs(permissions) {
  const perms = normalizePermissions(permissions);
  return perms.customTabs.filter((t) => t.enabled);
}

function getMaxEmailAccounts(permissions) {
  return normalizePermissions(permissions).maxEmailAccounts;
}

function getMaxTemplates(permissions) {
  return normalizePermissions(permissions).maxTemplates;
}

function isAtLimit(used, max) {
  const cap = Number(max) || 0;
  if (cap <= 0) return false;
  return Number(used) >= cap;
}

module.exports = {
  DEFAULT_PERMISSIONS,
  normalizePermissions,
  getEnabledCustomTabs,
  isExtensionsEnabled,
  isProxyEnabled,
  getMaxEmailAccounts,
  getMaxTemplates,
  isAtLimit,
  clampTabCount,
  clampLimit
};
