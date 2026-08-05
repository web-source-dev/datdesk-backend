const COOKIE_CHANNELS = {
  SINGLE: 'single',
  DOUBLE: 'double',
  MULTI: 'multi',
  TEST: 'test'
};

const CHANNEL_ACTIVE_FIELD = {
  [COOKIE_CHANNELS.SINGLE]: 'isActiveSingle',
  [COOKIE_CHANNELS.DOUBLE]: 'isActiveDouble',
  [COOKIE_CHANNELS.MULTI]: 'isActiveMulti',
  [COOKIE_CHANNELS.TEST]: 'isActiveTest'
};

const CHANNEL_LABELS = {
  single: 'Single',
  double: 'Double',
  multi: 'Multi',
  test: 'Test'
};

function normalizeCookieChannel(channel) {
  const lower = String(channel || COOKIE_CHANNELS.SINGLE)
    .trim()
    .toLowerCase();
  if (lower === 'test') return COOKIE_CHANNELS.TEST;
  if (lower === 'double') return COOKIE_CHANNELS.DOUBLE;
  if (lower === 'multi') return COOKIE_CHANNELS.MULTI;
  return COOKIE_CHANNELS.SINGLE;
}

function isValidCookieChannel(channel) {
  return Object.values(COOKIE_CHANNELS).includes(normalizeCookieChannel(channel));
}

function getActiveFieldForChannel(channel) {
  return CHANNEL_ACTIVE_FIELD[normalizeCookieChannel(channel)] || 'isActiveSingle';
}

/**
 * label=test → test channel; otherwise use plan (single|double|multi).
 * No Swift in NEWDATAPP.
 */
function getCookieChannelForUser(user) {
  const label = String(user?.label || '')
    .trim()
    .toLowerCase();
  if (label === 'test') return COOKIE_CHANNELS.TEST;

  const plan = String(user?.plan || 'single')
    .trim()
    .toLowerCase();
  if (plan === 'double') return COOKIE_CHANNELS.DOUBLE;
  if (plan === 'multi') return COOKIE_CHANNELS.MULTI;
  return COOKIE_CHANNELS.SINGLE;
}

module.exports = {
  COOKIE_CHANNELS,
  CHANNEL_ACTIVE_FIELD,
  CHANNEL_LABELS,
  normalizeCookieChannel,
  isValidCookieChannel,
  getActiveFieldForChannel,
  getCookieChannelForUser
};
