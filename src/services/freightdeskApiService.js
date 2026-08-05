'use strict';

const FREIGHTDESK_API_URL = (
  process.env.FREIGHTDESK_API_URL || 'https://freightdesk.rtnglobal.co'
).replace(/\/$/, '');
const FREIGHTDESK_PARTNER_API_KEY = process.env.FREIGHTDESK_PARTNER_API_KEY || '';

const DEFAULT_RETRIES = parseInt(process.env.FREIGHTDESK_API_RETRIES, 10) || 3;
const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.FREIGHTDESK_API_RETRY_DELAY_MS, 10) || 2000;
const REQUEST_TIMEOUT_MS = parseInt(process.env.FREIGHTDESK_API_TIMEOUT_MS, 10) || 60000;

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function isConfigured() {
  return Boolean(FREIGHTDESK_API_URL && FREIGHTDESK_PARTNER_API_KEY);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiErrorMessage(text, status) {
  const raw = String(text || '').trim();
  if (!raw) return `FreightDesk API request failed (${status})`;

  const titleMatch = raw.match(/<title>\s*([^<]+)\s*<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    if (/bad gateway|gateway timeout|service unavailable/i.test(title)) {
      return `FreightDesk API ${title} (${status}) — server overloaded or temporarily down; retry later`;
    }
    return `FreightDesk API error: ${title} (${status})`;
  }

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return parsed.error || parsed.message || `FreightDesk API request failed (${status})`;
    } catch {
      // fall through
    }
  }

  if (raw.length > 200) return `FreightDesk API request failed (${status})`;
  return raw;
}

async function partnerRequest(path, options = {}) {
  if (!isConfigured()) {
    throw new Error(
      'FreightDesk partner API is not configured. Set FREIGHTDESK_API_URL and FREIGHTDESK_PARTNER_API_KEY.'
    );
  }

  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const waitMs = retryDelayMs * attempt;
      console.log(`[FreightDesk API] Retry ${attempt}/${maxRetries} for ${path} in ${waitMs}ms...`);
      await sleep(waitMs);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(`${FREIGHTDESK_API_URL}${path}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Dathub-Partner-Key': FREIGHTDESK_PARTNER_API_KEY,
          ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeout);

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }

      if (!res.ok) {
        const message = normalizeApiErrorMessage(
          (data && typeof data === 'object' && (data.error || data.message)) || text,
          res.status
        );
        const error = new Error(message);
        error.status = res.status;

        if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
          lastError = error;
          continue;
        }

        throw error;
      }

      return data;
    } catch (err) {
      const isAbort = err.name === 'AbortError';
      const isNetwork =
        err.message?.includes('fetch failed') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT');

      if ((isAbort || isNetwork) && attempt < maxRetries) {
        lastError = new Error(
          isAbort
            ? `FreightDesk API timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `FreightDesk API network error: ${err.message}`
        );
        lastError.status = isAbort ? 504 : 503;
        continue;
      }

      throw lastError || err;
    }
  }

  throw lastError || new Error('FreightDesk API request failed after retries');
}

async function listContainers() {
  return partnerRequest('/api/partner/dathub/containers');
}

async function fetchAllSessions() {
  return partnerRequest('/api/partner/dathub/sessions');
}

async function fetchSession(container) {
  const id = encodeURIComponent(String(container).toUpperCase());
  return partnerRequest(`/api/partner/dathub/sessions/${id}`);
}

async function updateContainerLabel(container, label) {
  const id = encodeURIComponent(String(container).toUpperCase());
  return partnerRequest(`/api/partner/dathub/containers/${id}/label`, {
    method: 'PATCH',
    body: { label }
  });
}

module.exports = {
  isConfigured,
  listContainers,
  fetchAllSessions,
  fetchSession,
  updateContainerLabel
};
