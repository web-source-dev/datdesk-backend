/**
 * Which cookie files may appear in automatic mode on the Swift partner dashboard.
 * Display names are never required for manual mode (admin picks cookies by ID).
 */

function isShehrozExcluded(name) {
  if (/avva/i.test(name)) return false;
  return /shehroz/i.test(name);
}

function matchesExcludedRule(name, rule) {
  if (rule === 'shehroz') return isShehrozExcluded(name);
  return rule.test(name);
}

const EXCLUDED_SESSION_RULES = [
  /\bfmr\b/i,
  /\bfmr\s*2\b/i,
  'shehroz',
  /naqvi/i,
  /dream\s*dat/i,
  /all\s*trans/i,
  /\btrans\s*(1st|2nd|first|second)\b/i
];

function normalizeSessionName(name) {
  return String(name || '').trim();
}

function isAvvaSessionName(sessionName) {
  return /avva/i.test(normalizeSessionName(sessionName));
}

function getIncludedSessionRules() {
  const fromEnv = (process.env.PARTNER_SWIFT_INCLUDED_SESSION_SUBSTRINGS ?? 'aneeq,avva')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (fromEnv.length === 0 || fromEnv.includes('*')) {
    return [];
  }

  return fromEnv.map(
    (substr) => new RegExp(substr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  );
}

function isExcludedSessionName(sessionName) {
  const name = normalizeSessionName(sessionName);
  if (!name) return true;
  if (isAvvaSessionName(name)) return false;
  return EXCLUDED_SESSION_RULES.some((rule) => matchesExcludedRule(name, rule));
}

function isIncludedSessionName(sessionName) {
  const name = normalizeSessionName(sessionName);
  if (!name) return false;
  const includeRules = getIncludedSessionRules();
  if (includeRules.length === 0) return true;
  return includeRules.some((rule) => rule.test(name));
}

function isPartnerSwiftSessionVisible(sessionName) {
  const name = normalizeSessionName(sessionName);
  if (!name) return false;
  if (isExcludedSessionName(name)) return false;
  return isIncludedSessionName(name);
}

module.exports = {
  isPartnerSwiftSessionVisible,
  isExcludedSessionName,
  isIncludedSessionName,
  isAvvaSessionName
};
