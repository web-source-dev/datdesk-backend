/**
 * Deep freight email rules — filtering, cleaning, extraction, classification.
 * Tuned via: npm run tune:freight
 */

const US_STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

const STATE_SET = new Set(US_STATES.split('|'));

/** Exact domains / suffixes that are almost never freight counterparties */
const NOISE_DOMAINS = [
  'github.com',
  'google.com',
  'googleapis.com',
  'googlemail.com',
  'gmail.com', // personal noise when analyzing *counterparty* — still allow employee accounts as own
  'vercel.com',
  'mongodb.com',
  'supabase.com',
  'ahrefs.com',
  'rumble.com',
  'printful.com',
  'sketchfab.com',
  'zapier.com',
  'linkedin.com',
  'facebookmail.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'amazon.com',
  'amazonaws.com',
  'microsoft.com',
  'office365.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'apple.com',
  'icloud.com',
  'mailchimp.com',
  'sendgrid.net',
  'brevosend.com',
  'meezanbank.com',
  'sociablekit.com',
  'notion.so',
  'slack.com',
  'atlassian.com',
  'jira.com',
  'dropbox.com',
  'box.com',
  'zoom.us',
  'calendly.com',
  'stripe.com',
  'paypal.com',
  'shopify.com',
  'hubspot.com',
  'intercom.io',
  'zendesk.com',
  'freshdesk.com',
  'docusign.com',
  'docusign.net',
  'adobe.com',
  'figma.com',
  'canva.com',
  'medium.com',
  'substack.com',
  'beehiiv.com',
  'convertkit.com',
  'klaviyo.com',
  'constantcontact.com',
  'mailgun.org',
  'postmarkapp.com',
  'sendinblue.com',
  'brevo.com',
  'campaign-archive.com',
  'list-manage.com',
  'email.ngrok.com',
  'cursor.com',
  'openai.com',
  'anthropic.com',
  'reddit.com',
  'redditmail.com',
  'youtube.com',
  'youtubemail.com',
  'tiktok.com',
  'instagram.com',
  'pinterest.com',
  'ebay.com',
  'etsy.com',
  'walmart.com',
  'target.com',
  'netflix.com',
  'spotify.com',
  'noreply.github.com',
  'users.noreply.github.com',
  'email.ngrok.dev'
];

const NOISE_LOCAL_PARTS = new Set([
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'newsletter',
  'news',
  'marketing',
  'promo',
  'promotions',
  'notifications',
  'notification',
  'alerts',
  'alert',
  'updates',
  'update',
  'billing',
  'receipts',
  'invoice',
  'invoices',
  'security',
  'verify',
  'verification',
  'support+noreply'
]);

const NOISE_SUBJECT = [
  /\bunsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bverification code\b/i,
  /\bone[- ]time (pass)?code\b/i,
  /\botp\b/i,
  /\bsecurity (alert|code|vulnerabilit|notice)\b/i,
  /\bpassword reset\b/i,
  /\breset your password\b/i,
  /\bdependabot\b/i,
  /\bsudo authentication\b/i,
  /\btwo[- ]factor\b/i,
  /\b2fa\b/i,
  /\bmfa code\b/i,
  /\binvoice from (google|apple|microsoft|amazon)\b/i,
  /\byour (receipt|statement|invoice) from\b/i,
  /\baction required:\s*security\b/i,
  /\bweekly digest\b/i,
  /\bdaily digest\b/i,
  /\bcommunity update\b/i,
  /\bjust reported a record\b/i,
  /\bdomains need configuration\b/i,
  /\bpage indexing\b/i,
  /\bslow page\b/i,
  /\bhealth score\b/i
];

const NOISE_BODY = [
  /\bunsubscribe from this (email|list|project)\b/i,
  /\bif you(?:'|’)re having trouble viewing this email\b/i,
  /\bview (this )?email in (your )?browser\b/i,
  /\bmanage (your )?preferences\b/i,
  /\bthis is an automated message\b/i,
  /\bdo not reply to this (email|message)\b/i
];

/** Soft freight signals — alone not enough */
const SOFT_FREIGHT = [
  { re: /\bload\b/i, w: 1 },
  { re: /\btruck\b/i, w: 1 },
  { re: /\btrailer\b/i, w: 1 },
  { re: /\bcarrier\b/i, w: 1 },
  { re: /\bbroker\b/i, w: 1.5 },
  { re: /\bfreight\b/i, w: 1.5 },
  { re: /\bdispatch\b/i, w: 1 },
  { re: /\bpick\s*up\b/i, w: 1 },
  { re: /\bdelivery\b/i, w: 0.5 },
  { re: /\blane\b/i, w: 1 },
  { re: /\bshipment\b/i, w: 1 },
  { re: /\bbol\b/i, w: 1.5 },
  { re: /\bcommodity\b/i, w: 1 },
  { re: /\bmiles?\b/i, w: 0.5 }
];

/** Hard freight signals — strongly indicate freight */
const HARD_FREIGHT = [
  { re: /\brate\s*con(?:firmation)?\b/i, w: 3 },
  { re: /\bratecon\b/i, w: 3 },
  { re: /\bpod\b/i, w: 2.5 },
  { re: /\bproof\s+of\s+delivery\b/i, w: 3 },
  { re: /\bdry\s*van\b/i, w: 2.5 },
  { re: /\breefer\b/i, w: 2.5 },
  { re: /\bflatbed\b/i, w: 2.5 },
  { re: /\bstep\s*deck\b/i, w: 2.5 },
  { re: /\bpower\s*only\b/i, w: 2 },
  { re: /\bmc\s*#?\s*\d{5,}/i, w: 3 },
  { re: /\bdot\s*#?\s*\d{5,}/i, w: 3 },
  { re: /\bload\s*(?:#|no\.?|number)\s*[:#]?\s*[A-Z0-9-]/i, w: 3 },
  { re: /\ball[- ]?in\b/i, w: 1.5 },
  { re: /\bcarrier\s+packet\b/i, w: 3 },
  { re: /\bwe\s+can\s+cover\b/i, w: 3 },
  { re: /\bload\s+available\b/i, w: 3 },
  { re: /\bneed\s+(a\s+)?truck\b/i, w: 2.5 },
  { re: /\bdriver\s+(loaded|empty)\b/i, w: 2.5 },
  { re: /\bno\s+longer\s+available\b/i, w: 2.5 },
  { re: /\bcovered\s+already\b/i, w: 2.5 },
  { re: /\bgoing\s+with\s+another\b/i, w: 2.5 },
  { re: /\bload\s+(is\s+)?(gone|covered|taken)\b/i, w: 2.5 },
  { re: new RegExp(
      `\\b[A-Za-z .'-]{2,30},\\s*(?:${US_STATES})\\s*(?:→|->|to)\\s*[A-Za-z .'-]{2,30},\\s*(?:${US_STATES})\\b`,
      'i'
    ), w: 3 },
  { re: new RegExp(
      `\\b[A-Za-z .'-]{2,30}\\s+(?:${US_STATES})\\s+(?:→|->|to)\\s+[A-Za-z .'-]{2,30}\\s+(?:${US_STATES})\\b`,
      'i'
    ), w: 3 },
  { re: /\$\s*\d{3,5}(?:\.\d{2})?\b/, w: 1 }
];

const BROKER_PHRASES = [
  { re: /\bload\s+available\b/i, w: 2 },
  { re: /\bhave\s+(a\s+)?load\b/i, w: 2 },
  { re: /\bnew\s+(load\s+)?posting\b/i, w: 2 },
  { re: /\brate\s+confirmation\b/i, w: 2 },
  { re: /\brate\s*con\b/i, w: 1.5 },
  { re: /\bratecon\b/i, w: 2 },
  { re: /\bcarrier\s+packet\b/i, w: 3 },
  { re: /\bneed\s+(a\s+)?truck\b/i, w: 2 },
  { re: /\blooking\s+for\s+(a\s+)?(truck|carrier)\b/i, w: 2 },
  { re: /\bplease\s+advise\s+if\s+you\s+can\s+cover\b/i, w: 3 },
  { re: /\bissue\s+(the\s+)?rate\s+confirmation\b/i, w: 2 },
  { re: /\bsend\s+(your\s+)?(carrier\s+)?packet\b/i, w: 2 },
  { re: /\bbroker(?:age)?\b/i, w: 2 },
  { re: /\btender\b/i, w: 2 },
  { re: /\bmc\s*#?\s*\d{5,}/i, w: 1 },
  { re: /\ball[- ]?in\b/i, w: 1.5 },
  { re: /\bshipper\b/i, w: 1 },
  { re: /\bcustomer\s+load\b/i, w: 2 },
  { re: /\bcovering?\s+authority\b/i, w: 2 },
  { re: /\bgoing\s+with\s+another\s+carrier\b/i, w: 2 },
  { re: /\bno\s+longer\s+available\b/i, w: 1.5 },
  { re: /\bwe\s+have\s+(a\s+)?load\b/i, w: 2 },
  { re: /\bposting\b/i, w: 1 },
  { re: /\bpay\s+as\b/i, w: 1 },
  { re: /\bfacility\b/i, w: 0.5 }
];

const CARRIER_PHRASES = [
  { re: /\bwe\s+can\s+cover\b/i, w: 3 },
  { re: /\bcan\s+cover\b/i, w: 2 },
  { re: /\bdriver\s+(is\s+)?(loaded|empty|en\s*route|rolling)\b/i, w: 3 },
  { re: /\bpicked\s+up\b/i, w: 2 },
  { re: /\bpod\s+attached\b/i, w: 3 },
  { re: /\bproof\s+of\s+delivery\b/i, w: 3 },
  { re: /\bwe\s+have\s+(a\s+)?(truck|trailer|power)\b/i, w: 2.5 },
  { re: /\bavailable\s+(truck|trailer|power)\b/i, w: 2.5 },
  { re: /\bpower\s+only\b/i, w: 2 },
  { re: /\bour\s+dispatch\b/i, w: 2 },
  { re: /\bdispatch\s*[-–—:]/i, w: 1.5 },
  { re: /\bdot\s*#?\s*\d{5,}/i, w: 2 },
  { re: /\bempty\s+in\b/i, w: 2 },
  { re: /\brolling\s+to\b/i, w: 2 },
  { re: /\beta\s+(delivery|del|pu|pickup)\b/i, w: 2 },
  { re: /\bplease\s+send\s+(the\s+)?(rate\s+)?(con|confirmation)\b/i, w: 2 },
  { re: /\btruck\s+available\b/i, w: 2 },
  { re: /\bcan\s+pick\s+up\b/i, w: 2 },
  { re: /\bis\s+this\s+load\s+still\s+available\b/i, w: 2 },
  { re: /\bstill\s+available\b/i, w: 1 },
  { re: /\blooking\s+for\s+details\b/i, w: 1.5 },
  { re: /\btrucking\b/i, w: 1.5 },
  { re: /\bunit\s*#?\s*\d+/i, w: 1.5 },
  { re: /\btractor\b/i, w: 1.5 }
];

const STATUS_RULES = [
  {
    status: 'delivered',
    confidence: 0.96,
    patterns: [
      /\bpod\b/i,
      /\bproof\s+of\s+delivery\b/i,
      /\bdelivered\b/i,
      /\bunloaded\b/i,
      /\bdelivery\s+complete\b/i,
      /\bemailed\s+pod\b/i
    ],
    title: 'Delivered / POD'
  },
  {
    status: 'picked_up',
    confidence: 0.92,
    patterns: [
      /\bdriver\s+loaded\b/i,
      /\bpicked\s+up\b/i,
      /\bloaded\s+(and\s+)?rolling\b/i,
      /\bin\s+transit\b/i,
      /\brolling\s+to\b/i,
      /\bloaded\s+at\b/i,
      /\ben\s*route\b/i,
      /\bleft\s+the\s+shipper\b/i
    ],
    title: 'Picked up / in transit'
  },
  {
    status: 'booked',
    confidence: 0.9,
    patterns: [
      /\bwe(?:'|’)?ll\s+take\s+it\b/i,
      /\bwe\s+can\s+take\s+it\b/i,
      /\bwe\s+can\s+cover\b/i,
      /\bcan\s+cover\s+(this|it|the\s+load)?\b/i,
      /\bbook(?:ed|ing)\b/i,
      /\bcover(?:ed|ing)?\s+(it|this|the\s+load)\b/i,
      /\baccept(?:ed|ing)?\s+(the\s+)?(rate|load)\b/i,
      /\byes[,.]?\s+\$?\d/i,
      /\bworks\s+for\s+us\b/i,
      /\b\$?\d[\d,]*\s+works\b/i,
      /\bagreed\b/i,
      /\bconfirmed\s+at\s+\$/i,
      /\bwe(?:'|’)?ll\s+book\s+it\b/i,
      /\bplease\s+send\s+(the\s+)?(rate\s+)?(con|confirmation)\b/i,
      /\bsend\s+(over\s+)?(the\s+)?rate\s+confirmation\b/i,
      /\bput\s+(us|me)\s+on\s+(it|the\s+load)\b/i
    ],
    title: 'Booked / accepted'
  },
  {
    status: 'confirmed',
    confidence: 0.94,
    patterns: [
      /\brate\s+confirmation\s+attached\b/i,
      /\bratecon\b/i,
      /\brc\s+attached\b/i,
      /\bsign\s+and\s+return\s+(the\s+)?rc\b/i,
      /\brate\s+confirmation\s*[-–—:]/i,
      /^rate\s+confirmation\b/im,
      /\brate\s+con\s+sent\b/i
    ],
    title: 'Rate confirmation'
  },
  {
    status: 'lost',
    confidence: 0.93,
    patterns: [
      /\bgoing\s+with\s+another\b/i,
      /\bcovered\s+(elsewhere|already)\b/i,
      /\bno\s+longer\s+available\b/i,
      /\bload\s+(is\s+)?(gone|covered|taken)\b/i,
      /\bcancel(?:led|ed)?\b/i,
      /\bpass(?:ing)?\s+on\s+(this|it)\b/i,
      /\bcovered\s+already\b/i,
      /\bfell\s+off\b/i,
      /\btomorrow'?s?\s+truck\b/i
    ],
    title: 'Lost / covered elsewhere'
  },
  {
    status: 'negotiating',
    confidence: 0.84,
    patterns: [
      /\bcan\s+you\s+do\s+\$/i,
      /\bbest\s+rate\b/i,
      /\bcounter\b/i,
      /\bhow\s+about\s+\$/i,
      /\bneed\s+\$\d/i,
      /\btoo\s+low\b/i,
      /\bcan\s+you\s+do\b/i,
      /\bwork\s+with\b/i,
      /\bany\s+flex(?:ibility)?\s+on\s+(the\s+)?rate\b/i,
      /\bwhat(?:'|’)s\s+your\s+best\b/i,
      /\bmax\s+(I|we)\s+can\s+do\b/i
    ],
    title: 'Rate negotiation'
  },
  {
    status: 'inquiry',
    confidence: 0.8,
    patterns: [
      /\bstill\s+available\b/i,
      /\bis\s+this\s+load\s+available\b/i,
      /\bany\s+updates?\b/i,
      /\bdetails\s+on\s+(this\s+)?load\b/i,
      /\blooking\s+for\s+details\b/i,
      /\bdims?\s*(and|&)?\s*weight\b/i,
      /\bwhat(?:'|’)s\s+the\s+weight\b/i
    ],
    title: 'Availability inquiry'
  },
  {
    status: 'open',
    confidence: 0.74,
    patterns: [
      /\bload\s+available\b/i,
      /\bhave\s+(a\s+)?load\b/i,
      /\bnew\s+load\b/i,
      /\bnew\s+(load\s+)?posting\b/i,
      /\bposting\b/i,
      /\bneed\s+(a\s+)?truck\b/i,
      /\bplease\s+advise\s+if\s+you\s+can\s+cover\b/i,
      /\blooking\s+for\s+(a\s+)?truck\b/i
    ],
    title: 'Load offer / open'
  }
];

const LOAD_BLOCKLIST = new Set([
  'ATTACHED',
  'AVAILABLE',
  'CONFIRMATION',
  'PLEASE',
  'THANKS',
  'REGARDS',
  'SUBJECT',
  'HTTPS',
  'HTTP',
  'TRUCK',
  'CARRIER',
  'BROKER',
  'PACKET',
  'TOMORROW',
  'MORNING',
  'AFTERNOON',
  'DALLAS',
  'CHICAGO',
  'HOUSTON',
  'ATLANTA',
  'MIAMI',
  'ORLANDO',
  'PHOENIX',
  'DENVER',
  'LOADED',
  'EMPTY',
  'DRIVER',
  'WEIGHT',
  'EQUIPMENT',
  'PICKUP',
  'DELIVERY',
  'ORIGIN',
  'DESTINATION'
]);

function normalizeEmail(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function domainOf(email) {
  const e = normalizeEmail(email);
  const parts = e.split('@');
  return parts.length === 2 ? parts[1] : '';
}

function localPartOf(email) {
  const e = normalizeEmail(email);
  return e.split('@')[0] || '';
}

function companyFromDomain(domain) {
  if (!domain) return '';
  const root = domain.split('.')[0] || '';
  return root.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function isNoiseDomain(domain, { allowPersonalWebmail = false } = {}) {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  const personal = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'yahoo.com', 'aol.com']);
  if (allowPersonalWebmail && personal.has(d)) return false;
  for (const n of NOISE_DOMAINS) {
    if (d === n || d.endsWith(`.${n}`)) return true;
  }
  if (/\b(newsletter|mailer|email|em|updates?|notif)\./i.test(d)) return true;
  return false;
}

/**
 * Strip quoted replies, signatures, and HTML-ish noise before analysis.
 */
function cleanEmailBody(raw) {
  let text = String(raw || '');
  // HTML tags
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  // Quoted reply blocks
  text = text.replace(/^>+.*$/gm, ' ');
  text = text.replace(/\nOn .{10,120} wrote:\s*[\s\S]*$/i, '\n');
  text = text.replace(/\nFrom:\s*.{0,80}\nSent:\s*[\s\S]*$/i, '\n');
  text = text.replace(/\n-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i, '\n');
  // Signature separators
  text = text.replace(/\n--\s*\n[\s\S]*$/i, '\n');
  text = text.replace(/\n_{5,}[\s\S]*$/i, '\n');
  text = text.replace(/\nSent from my (iPhone|Android|Galaxy)[\s\S]*$/i, '\n');
  text = text.replace(/\nGet Outlook for[\s\S]*$/i, '\n');
  // Tracking / unsubscribe clutter
  text = text.replace(/https?:\/\/\S+/gi, ' ');
  text = text.replace(/\[[^\]]{0,40}\]/g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text.trim().slice(0, 60000);
}

function textBlob(message) {
  const subject = String(message.subject || '');
  const snippet = String(message.snippet || '');
  const body = cleanEmailBody(message.body || '');
  return [subject, snippet, body].join('\n').replace(/\0/g, ' ').slice(0, 80000);
}

function scorePatterns(list, text) {
  let score = 0;
  let hits = 0;
  for (const item of list) {
    const re = item.re || item;
    const w = item.w != null ? item.w : 1;
    if (re.test(text)) {
      score += w;
      hits += 1;
    }
  }
  return { score, hits };
}

/**
 * Deep freight relevance filter with multi-signal scoring.
 */
function assessFreightRelevance(message, { ownEmail = '' } = {}) {
  const from = normalizeEmail(message.from);
  const fromDomain = domainOf(from);
  const local = localPartOf(from);
  const subject = String(message.subject || '');
  const text = textBlob(message);
  const reasons = [];

  // Own outbound is always allowed through domain noise of recipient later
  const isOwn = ownEmail && from === normalizeEmail(ownEmail);

  if (!isOwn && isNoiseDomain(fromDomain, { allowPersonalWebmail: false })) {
    // Allow personal webmail counterparties — they can be brokers/carriers using gmail
    if (!['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'].includes(fromDomain)) {
      return { freightRelated: false, score: 0, reasons: ['noise_domain'], text };
    }
  }

  if (!isOwn && NOISE_LOCAL_PARTS.has(local)) {
    return { freightRelated: false, score: 0, reasons: ['noise_local_part'], text };
  }

  if (NOISE_SUBJECT.some((re) => re.test(subject))) {
    return { freightRelated: false, score: 0, reasons: ['noise_subject'], text };
  }

  // Heavy newsletter body markers + weak freight → reject
  const noiseBodyHits = NOISE_BODY.filter((re) => re.test(text)).length;
  const soft = scorePatterns(SOFT_FREIGHT, text);
  const hard = scorePatterns(HARD_FREIGHT, text);
  let score = soft.score + hard.score;

  // Route / load# / rate bonuses computed lightly
  const hasRoute = new RegExp(
    `\\b[A-Za-z .'-]{2,30},\\s*(?:${US_STATES})\\s*(?:→|->|to|-)\\s*[A-Za-z .'-]{2,30},\\s*(?:${US_STATES})\\b`,
    'i'
  ).test(text);
  if (hasRoute) {
    score += 2.5;
    reasons.push('route');
  }

  const hasLoadNum = /\b(?:load|ref|rc)\s*(?:#|no\.?|number)?\s*[:#-]?\s*[A-Z0-9]*\d[A-Z0-9-]{2,}/i.test(
    text
  );
  if (hasLoadNum) {
    score += 2.5;
    reasons.push('load_number');
  }

  const hasMoney = /\$\s*\d{3,5}/.test(text);
  if (hasMoney && (hasRoute || hasLoadNum || hard.hits > 0)) {
    score += 1;
    reasons.push('rate');
  }

  if (hard.hits) reasons.push(`hard:${hard.hits}`);
  if (soft.hits) reasons.push(`soft:${soft.hits}`);

  if (noiseBodyHits >= 2 && hard.hits === 0 && !hasRoute && !hasLoadNum) {
    return { freightRelated: false, score, reasons: ['newsletter_body', ...reasons], text };
  }

  // Threshold: need real freight evidence, not a lone "delivery" word
  const freightRelated =
    hard.hits >= 1 ||
    (hasRoute && soft.hits >= 1) ||
    (hasLoadNum && soft.hits >= 1) ||
    score >= 4;

  if (!freightRelated) reasons.push('below_threshold');
  return { freightRelated, score, reasons, text, softHits: soft.hits, hardHits: hard.hits };
}

function extractLoadNumbers(text) {
  const out = new Set();
  const patterns = [
    /\b(?:load|ref|reference|po|pro|shipment|order)\s*(?:#|no\.?|number|num)?\s*[:#-]?\s*([A-Z0-9][-A-Z0-9]{3,20})\b/gi,
    /\b(?:RC|RATECON|REF)\s*[:#-]?\s*([A-Z0-9][-A-Z0-9]{3,20})\b/gi,
    /\b(?:load\s*#)\s*([A-Z0-9][-A-Z0-9]{3,20})\b/gi,
    /\bLoad\s+([A-Z0-9][-A-Z0-9]{3,20})\b/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const v = String(m[1] || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '');
      if (v.length < 4 || LOAD_BLOCKLIST.has(v)) continue;
      if (/^[A-Z]{4,}$/.test(v) && !/\d/.test(v)) continue;
      if (/^\d{8,}$/.test(v)) continue; // phone-like
      out.add(v);
    }
  }
  for (const m of text.matchAll(/\b#\s*([A-Z0-9]*\d[A-Z0-9-]{2,17})\b/gi)) {
    const v = String(m[1] || '')
      .trim()
      .toUpperCase();
    if (v.length >= 4 && !LOAD_BLOCKLIST.has(v) && !/^\d{8,}$/.test(v)) out.add(v);
  }
  return [...out];
}

function extractRates(text) {
  const rates = [];
  const push = (raw) => {
    const n = Number(String(raw).replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 100 && n <= 25000) rates.push(n);
  };

  const labeled = [
    ...text.matchAll(
      /\b(?:rate|all[- ]?in|paying|pay|offer(?:ed|ing)?|buy|sell|booked\s+at)\s*[:\-]?\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,5})(?:\.\d{2})?/gi
    )
  ];
  for (const m of labeled) push(m[1]);

  // $2,400 or $2400 — never stop at $240 from $2400
  const money = [
    ...text.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,5})(?:\.\d{2})?/g)
  ];
  for (const m of money) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 150 || n > 25000) continue;
    const idx = m.index || 0;
    const window = text.slice(Math.max(0, idx - 40), idx + 40);
    if (
      /\b(rate|all-?in|load|pay|offer|cover|book|lane|rpm|works)\b/i.test(window) ||
      labeled.length === 0
    ) {
      rates.push(n);
    }
  }

  return [...new Set(rates)].sort((a, b) => b - a);
}

function cleanCity(s) {
  return String(s || '')
    .replace(
      /\b(from|to|origin|destination|pickup|delivery|pu|del|available|have|new|load|for|the|a|an|posting|ref|equipment|equip|van|dry|weight|miles|rate|re|fw)\b/gi,
      ''
    )
    .replace(/[^a-zA-Z .'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function extractRoute(text) {
  const patterns = [
    new RegExp(
      `\\b([A-Za-z .'-]{2,30}),\\s*(${US_STATES})\\s*(?:→|->|–|—|to)\\s*([A-Za-z .'-]{2,30}),\\s*(${US_STATES})\\b`,
      'i'
    ),
    new RegExp(
      `([A-Za-z .'-]{2,30})[,\\s]+(${US_STATES})\\s*(?:→|->|–|—|to)\\s*([A-Za-z .'-]{2,30})[,\\s]+(${US_STATES})`,
      'i'
    ),
    new RegExp(
      `\\b(?:from|origin|pu|pickup)\\s*[:\\-]?\\s*([A-Za-z .'-]{2,30}),?\\s*(${US_STATES})\\b[\\s\\S]{0,120}?\\b(?:to|destination|del|delivery|dest)\\s*[:\\-]?\\s*([A-Za-z .'-]{2,30}),?\\s*(${US_STATES})\\b`,
      'i'
    ),
    new RegExp(
      `\\b([A-Za-z .'-]{2,30})\\s+(${US_STATES})\\s*[-–—/]\\s*([A-Za-z .'-]{2,30})\\s+(${US_STATES})\\b`,
      'i'
    ),
    new RegExp(
      `\\b([A-Za-z .'-]{2,30})\\s+(${US_STATES})\\s+(?:to|TO)\\s+([A-Za-z .'-]{2,30})\\s+(${US_STATES})\\b`,
      'i'
    )
  ];

  for (const re of patterns) {
    const arrow = text.match(re);
    if (!arrow) continue;
    const pickupCity = cleanCity(arrow[1]);
    const deliveryCity = cleanCity(arrow[3]);
    const ps = arrow[2].toUpperCase();
    const ds = arrow[4].toUpperCase();
    if (!pickupCity || !deliveryCity || !STATE_SET.has(ps) || !STATE_SET.has(ds)) continue;
    if (pickupCity.length < 2 || deliveryCity.length < 2) continue;
    return {
      pickup: { city: pickupCity, state: ps, raw: `${pickupCity}, ${ps}` },
      delivery: { city: deliveryCity, state: ds, raw: `${deliveryCity}, ${ds}` }
    };
  }
  return { pickup: {}, delivery: {} };
}

function extractEquipment(text) {
  const m = text.match(
    /\b(dry\s*van|53['’]?\s*dry\s*van|reefer|flatbed|step\s*deck|power\s*only|box\s*truck|hotshot|van|flat|sd|rgn|lowboy)\b/i
  );
  return m ? String(m[1]).replace(/\s+/g, ' ').toUpperCase() : '';
}

function extractWeight(text) {
  const m =
    text.match(/\b(?:wt|weight)\s*[:\-]?\s*(\d{2,3}(?:,\d{3})?k?|\d{4,5})\s*(?:lbs?|pounds|#)?\b/i) ||
    text.match(/\b(\d{2,3}(?:,\d{3})?|\d{4,5})\s*(?:lbs?|pounds)\b/i);
  return m ? m[0] : '';
}

function extractMiles(text) {
  const m = text.match(/\b(\d{2,4})\s*(?:mi|miles)\b/i);
  return m ? Number(m[1]) : null;
}

function extractMcDot(text) {
  const mc = text.match(/\bmc\s*#?\s*(\d{5,8})\b/i);
  const dot = text.match(/\bdot\s*#?\s*(\d{5,9})\b/i);
  return {
    mc: mc ? mc[1] : '',
    dot: dot ? dot[1] : ''
  };
}

function extractPhones(text) {
  const phones = [];
  for (const m of text.matchAll(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g)) {
    phones.push(m[0]);
  }
  return [...new Set(phones)].slice(0, 3);
}

function extractContactName(text, email) {
  // "Thanks,\nJohn - ABC Logistics"
  const m =
    text.match(/(?:thanks|regards|best|sincerely)[,!]?\s*\n\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*(?:[-–—,|]|$)/i) ||
    text.match(/\n([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[-–—]\s*[A-Z][^\n]{2,40}/);
  if (m) return m[1].trim();
  const local = localPartOf(email);
  if (local && !NOISE_LOCAL_PARTS.has(local) && /^[a-z.]+$/i.test(local)) {
    return local
      .split(/[._]/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }
  return '';
}

function classifyPartyFromText(text, direction) {
  const broker = scorePatterns(BROKER_PHRASES, text);
  const carrier = scorePatterns(CARRIER_PHRASES, text);
  let partyType = 'unknown';
  let confidence = 0.4;

  if (broker.score > carrier.score && broker.hits > 0) {
    partyType = 'broker';
    confidence = Math.min(0.98, 0.5 + broker.score * 0.08);
  } else if (carrier.score > broker.score && carrier.hits > 0) {
    partyType = 'carrier';
    confidence = Math.min(0.98, 0.5 + carrier.score * 0.08);
  } else if (broker.hits > 0 && carrier.hits > 0) {
    partyType = direction === 'inbound' ? 'broker' : 'carrier';
    confidence = 0.55;
  }

  return {
    partyType,
    confidence,
    brokerSignals: broker.hits,
    carrierSignals: carrier.hits,
    brokerScore: broker.score,
    carrierScore: carrier.score
  };
}

function detectStatus(text) {
  for (const rule of STATUS_RULES) {
    const matched = [];
    for (const re of rule.patterns) {
      if (re.test(text)) matched.push(re.source);
    }
    if (matched.length) {
      return {
        status: rule.status,
        confidence: Math.min(0.99, rule.confidence + (matched.length - 1) * 0.02),
        title: rule.title,
        signals: matched.slice(0, 5)
      };
    }
  }
  return { status: 'unknown', confidence: 0, title: '', signals: [] };
}

/**
 * Full pure analysis for one email.
 */
function analyzeEmailText(message, opts = {}) {
  const relevance = assessFreightRelevance(message, opts);
  if (!relevance.freightRelated) {
    return {
      freightRelated: false,
      freightScore: relevance.score,
      filterReasons: relevance.reasons,
      loadNumbers: [],
      rates: [],
      route: { pickup: {}, delivery: {} },
      equipment: '',
      weight: '',
      miles: null,
      mc: '',
      dot: '',
      phones: [],
      contactName: '',
      statusHit: { status: 'unknown', confidence: 0, title: '', signals: [] },
      partyHint: { partyType: 'unknown', confidence: 0, brokerSignals: 0, carrierSignals: 0 }
    };
  }

  const text = relevance.text;
  const loadNumbers = extractLoadNumbers(text);
  const rates = extractRates(text);
  const route = extractRoute(text);
  const equipment = extractEquipment(text);
  const weight = extractWeight(text);
  const miles = extractMiles(text);
  const { mc, dot } = extractMcDot(text);
  const phones = extractPhones(text);
  const statusHit = detectStatus(text);
  const partyHint = classifyPartyFromText(text, message.direction || 'inbound');
  const contactName = extractContactName(text, message.from);

  // Extraction confidence
  let extractionConfidence = 0.4;
  if (loadNumbers.length) extractionConfidence += 0.25;
  if (route.pickup?.city && route.delivery?.city) extractionConfidence += 0.2;
  if (rates.length) extractionConfidence += 0.1;
  if (equipment) extractionConfidence += 0.05;
  if (statusHit.status !== 'unknown') extractionConfidence += 0.05;
  extractionConfidence = Math.min(0.99, extractionConfidence);

  return {
    freightRelated: true,
    freightScore: relevance.score,
    filterReasons: relevance.reasons,
    loadNumbers,
    rates,
    route,
    equipment,
    weight,
    miles,
    mc,
    dot,
    phones,
    contactName,
    statusHit,
    partyHint,
    extractionConfidence
  };
}

module.exports = {
  US_STATES,
  STATUS_RULES,
  analyzeEmailText,
  assessFreightRelevance,
  cleanEmailBody,
  textBlob,
  extractLoadNumbers,
  extractRates,
  extractRoute,
  extractEquipment,
  extractWeight,
  extractMiles,
  extractMcDot,
  extractPhones,
  extractContactName,
  classifyPartyFromText,
  detectStatus,
  normalizeEmail,
  domainOf,
  companyFromDomain,
  isNoiseDomain
};
