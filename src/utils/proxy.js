/**
 * Proxy format: host:port:username:password
 * Password may contain colons — join remainder after username.
 */

function parseProxy(proxy) {
  const raw = String(proxy || '').trim();
  if (!raw) return null;

  const parts = raw.split(':');
  if (parts.length < 2) return null;

  const host = parts[0].trim();
  const port = String(parts[1]).trim();
  const username = parts[2] !== undefined ? parts[2] : '';
  const password = parts.length > 3 ? parts.slice(3).join(':') : '';

  if (!host || !port || !/^\d+$/.test(port)) return null;

  return { host, port, username, password, raw };
}

function isValidProxy(proxy) {
  return !!parseProxy(proxy);
}

function formatProxy({ host, port, username, password }) {
  const h = String(host || '').trim();
  const p = String(port || '').trim();
  if (!h || !p) return '';
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user && !pass) return `${h}:${p}`;
  return `${h}:${p}:${user}:${pass}`;
}

function maskProxy(proxy) {
  const parsed = parseProxy(proxy);
  if (!parsed) return '—';
  if (parsed.username) return `${parsed.host}:${parsed.port}:${parsed.username}:***`;
  return `${parsed.host}:${parsed.port}`;
}

module.exports = { parseProxy, isValidProxy, formatProxy, maskProxy };
