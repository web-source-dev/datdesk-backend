const SWIFT_SOLUTIONS_LABEL = 'swiftSolutions';
const TEST_LABEL = 'test';

const COOKIE_CHANNELS = {
  SINGLE: 'single',
  DOUBLE: 'double',
  MULTI: 'multi',
  SWIFT_SOLUTIONS: 'swiftSolutions',
  TEST: 'test'
};

const CHANNEL_ACTIVE_FIELD = {
  [COOKIE_CHANNELS.SINGLE]: 'isActiveSingle',
  [COOKIE_CHANNELS.DOUBLE]: 'isActiveDouble',
  [COOKIE_CHANNELS.MULTI]: 'isActiveMulti',
  [COOKIE_CHANNELS.SWIFT_SOLUTIONS]: 'isActiveSwiftSolutions',
  [COOKIE_CHANNELS.TEST]: 'isActiveTest'
};

const CHANNEL_LABELS = {
  single: 'Single',
  double: 'Double',
  multi: 'Multi',
  swiftSolutions: 'Swift Solutions',
  test: 'Test'
};

function normalizeCookieChannel(channel) {
  const raw = String(channel || COOKIE_CHANNELS.SINGLE).trim();
  const lower = raw.toLowerCase().replace(/[-_\s]/g, '');

  if (lower === 'swiftsolutions' || lower === 'swift') {
    return COOKIE_CHANNELS.SWIFT_SOLUTIONS;
  }
  if (lower === 'test') return COOKIE_CHANNELS.TEST;
  if (lower === 'double') return COOKIE_CHANNELS.DOUBLE;
  if (lower === 'multi') return COOKIE_CHANNELS.MULTI;
  if (lower === 'single') return COOKIE_CHANNELS.SINGLE;
  if (raw === COOKIE_CHANNELS.SWIFT_SOLUTIONS) return COOKIE_CHANNELS.SWIFT_SOLUTIONS;

  return COOKIE_CHANNELS.SINGLE;
}

function isValidCookieChannel(channel) {
  const raw = String(channel ?? '').trim();
  if (!raw) return true; // omitted → single

  const lower = raw.toLowerCase().replace(/[-_\s]/g, '');
  return (
    lower === 'single' ||
    lower === 'double' ||
    lower === 'multi' ||
    lower === 'test' ||
    lower === 'swift' ||
    lower === 'swiftsolutions' ||
    raw === COOKIE_CHANNELS.SWIFT_SOLUTIONS
  );
}

function getActiveFieldForChannel(channel) {
  return CHANNEL_ACTIVE_FIELD[normalizeCookieChannel(channel)] || 'isActiveSingle';
}

/**
 * label=test → test channel
 * label=swiftSolutions → Swift Solutions channel
 * otherwise → plan (single|double|multi)
 */
function getCookieChannelForUser(user) {
  const labelRaw = String(user?.label || '').trim();
  const label = labelRaw.toLowerCase().replace(/[-_\s]/g, '');

  if (label === TEST_LABEL) return COOKIE_CHANNELS.TEST;

  if (
    label === 'swiftsolutions' ||
    label === 'swift' ||
    labelRaw === SWIFT_SOLUTIONS_LABEL
  ) {
    return COOKIE_CHANNELS.SWIFT_SOLUTIONS;
  }

  const plan = String(user?.plan || 'single')
    .trim()
    .toLowerCase();
  if (plan === 'double') return COOKIE_CHANNELS.DOUBLE;
  if (plan === 'multi') return COOKIE_CHANNELS.MULTI;
  return COOKIE_CHANNELS.SINGLE;
}

module.exports = {
  SWIFT_SOLUTIONS_LABEL,
  TEST_LABEL,
  COOKIE_CHANNELS,
  CHANNEL_ACTIVE_FIELD,
  CHANNEL_LABELS,
  normalizeCookieChannel,
  isValidCookieChannel,
  getActiveFieldForChannel,
  getCookieChannelForUser
};
