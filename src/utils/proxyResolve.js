const AppSettings = require('../models/AppSettings');
const Proxy = require('../models/Proxy');
const { formatProxy, isValidProxy } = require('./proxy');
const { buildProxyString } = require('../controllers/userProxyController');

async function getAppSettings() {
  let settings = await AppSettings.findOne({ key: 'app' });
  if (!settings) {
    settings = await AppSettings.create({ key: 'app' });
  }
  return settings;
}

function proxyDocToString(doc) {
  if (!doc) return '';
  return formatProxy({
    host: doc.host,
    port: doc.port,
    username: doc.username,
    password: doc.password
  });
}

/**
 * Resolve effective proxy for a user.
 * Priority: customProxy (Ctrl+Shift+P) → user.proxyId → global → legacy user.proxy
 */
async function resolveProxyForUser(user) {
  if (!user) {
    return { proxy: null, source: null, proxyDoc: null, message: 'User not found' };
  }

  const custom = buildProxyString(user.customProxy);
  if (custom && isValidProxy(custom)) {
    return {
      proxy: custom,
      source: 'custom',
      proxyDoc: null,
      proxyId: null,
      message: null
    };
  }

  if (user.proxyId) {
    const personal = await Proxy.findById(user.proxyId);
    if (personal && personal.enabled !== false) {
      const str = proxyDocToString(personal);
      if (isValidProxy(str)) {
        return {
          proxy: str,
          source: 'user',
          proxyDoc: personal,
          proxyId: personal._id,
          message: null
        };
      }
    }
  }

  const settings = await getAppSettings();
  if (settings.globalProxyEnabled && settings.globalProxyId) {
    const global = await Proxy.findById(settings.globalProxyId);
    if (global && global.enabled !== false) {
      const str = proxyDocToString(global);
      if (isValidProxy(str)) {
        return {
          proxy: str,
          source: 'global',
          proxyDoc: global,
          proxyId: global._id,
          message: null
        };
      }
    }
  }

  // Legacy inline string on user (back-compat)
  if (user.proxy && isValidProxy(user.proxy)) {
    return {
      proxy: user.proxy,
      source: 'legacy',
      proxyDoc: null,
      proxyId: null,
      message: null
    };
  }

  return {
    proxy: null,
    source: null,
    proxyDoc: null,
    proxyId: null,
    message:
      'No proxy available. Assign a user proxy or enable a global proxy in Admin → Proxies.'
  };
}

module.exports = {
  getAppSettings,
  proxyDocToString,
  resolveProxyForUser
};
