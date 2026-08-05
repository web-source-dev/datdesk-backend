const DEFAULT_PERMISSIONS = {
  openDat: true,
  datMultitab: false,
  datMultitabNumbers: 1,
  webMultitab: false,
  webMultitabNumbers: 1,
  customTabs: []
};

function clampTabCount(n, fallback = 1) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(10, Math.max(1, Math.round(num)));
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
    customTabs
  };
}

function getEnabledCustomTabs(permissions) {
  const perms = normalizePermissions(permissions);
  return perms.customTabs.filter((t) => t.enabled);
}

module.exports = {
  DEFAULT_PERMISSIONS,
  normalizePermissions,
  getEnabledCustomTabs,
  clampTabCount
};
