const SWIFT_SOLUTIONS_LABEL = 'swiftSolutions';
const TEST_LABEL = 'test';
const HORIZON_LABEL = 'horizon';

const COOKIE_CHANNELS = {
  SINGLE: 'single',
  DOUBLE: 'double',
  MULTI: 'multi',
  HORIZON: 'horizon',
  SWIFT_SOLUTIONS: 'swiftSolutions',
  TEST: 'test'
};

const CHANNEL_ACTIVE_FIELD = {
  [COOKIE_CHANNELS.SINGLE]: 'isActiveSingle',
  [COOKIE_CHANNELS.DOUBLE]: 'isActiveDouble',
  [COOKIE_CHANNELS.MULTI]: 'isActiveMulti',
  [COOKIE_CHANNELS.HORIZON]: 'isActiveHorizon',
  [COOKIE_CHANNELS.SWIFT_SOLUTIONS]: 'isActiveSwiftSolutions',
  [COOKIE_CHANNELS.TEST]: 'isActiveTest'
};

const CHANNEL_LABELS = {
  single: 'Single',
  double: 'Double',
  multi: 'Multi',
  horizon: 'Horizon',
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
  if (lower === 'horizon') return COOKIE_CHANNELS.HORIZON;
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
    lower === 'horizon' ||
    lower === 'test' ||
    lower === 'swift' ||
    lower === 'swiftsolutions' ||
    raw === COOKIE_CHANNELS.SWIFT_SOLUTIONS
  );
}

function getActiveFieldForChannel(channel) {
  return CHANNEL_ACTIVE_FIELD[normalizeCookieChannel(channel)] || 'isActiveSingle';
}

const SWIFT_LABEL_MATCH = [
  { label: 'swiftSolutions' },
  { label: /^swift\s*solutions$/i },
  { label: 'swift_solutions' },
  { label: 'swift-solutions' },
  { label: 'swift' }
];

/** Labels that route to their own cookie channel instead of the plan channel. */
const SPECIAL_LABEL_NOR = [{ label: 'test' }, { label: 'horizon' }, ...SWIFT_LABEL_MATCH];

/**
 * Accounts whose next Open DAT reads this channel's active cookie.
 * Test / Horizon / Swift labels are not included in a plan channel.
 */
function userQueryForCookieChannel(channel) {
  const id = normalizeCookieChannel(channel);
  if (id === COOKIE_CHANNELS.TEST) return { label: 'test' };
  if (id === COOKIE_CHANNELS.HORIZON) return { label: 'horizon' };
  if (id === COOKIE_CHANNELS.SWIFT_SOLUTIONS) return { $or: SWIFT_LABEL_MATCH };
  return { plan: id, $nor: SPECIAL_LABEL_NOR };
}

/**
 * label=test → test channel
 * label=swiftSolutions → Swift Solutions channel
 * label=horizon → Horizon channel (separate from Dat Desk / Smart Dat plan channels)
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

  if (label === HORIZON_LABEL) return COOKIE_CHANNELS.HORIZON;

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
  HORIZON_LABEL,
  COOKIE_CHANNELS,
  CHANNEL_ACTIVE_FIELD,
  CHANNEL_LABELS,
  normalizeCookieChannel,
  isValidCookieChannel,
  getActiveFieldForChannel,
  getCookieChannelForUser,
  userQueryForCookieChannel
};
