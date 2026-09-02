const { TEMPLATE_PLACEHOLDERS } = require('../constants/defaultEmailTemplates');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60000;

function openRouterConfigured() {
  return Boolean(String(process.env.OPENROUTER_API_KEY || '').trim());
}

function openRouterModel() {
  return String(process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free').trim();
}

function stripFences(text) {
  return String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractJsonObject(text) {
  const raw = stripFences(text);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

function normalizeTemplate(parsed, fallback = {}) {
  const name = clip(parsed?.name || fallback.name, 120) || 'Load inquiry';
  const subject = clip(parsed?.subject || fallback.subject, 300);
  const body = clip(parsed?.body || fallback.body, 20000);
  if (!subject || !body) return null;
  return { name, subject, body };
}

function buildSystemPrompt() {
  return [
    'You write short freight email templates for US truckload dispatchers emailing brokers.',
    'Return JSON only with keys name, subject, and body. No markdown, no extra keys.',
    'Use these placeholders when a load field belongs in the message:',
    TEMPLATE_PLACEHOLDERS.join(' '),
    'Keep the body 4–8 short lines, professional, and ready to send.',
    'Do not invent a company name, phone, or signature block. End with Thanks, or Best,',
    'Do not mention DAT, Smart Dat, AI, or that this is a template.'
  ].join(' ');
}

function buildUserPrompt({ prompt, name, subject, body, mode }) {
  const lines = [];
  lines.push(mode === 'edit' ? 'Improve the current email template.' : 'Create an email template.');
  lines.push(`Request: ${clip(prompt, 2000) || 'Write a professional load inquiry for a DAT load row.'}`);
  if (name || subject || body) {
    lines.push('Current draft:');
    if (name) lines.push(`name: ${clip(name, 120)}`);
    if (subject) lines.push(`subject: ${clip(subject, 300)}`);
    if (body) lines.push(`body:\n${clip(body, 4000)}`);
  }
  lines.push('Return JSON: {"name":"...","subject":"...","body":"..."}');
  return lines.join('\n');
}

async function generateEmailTemplate(input = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('AI template helper is not configured');
    err.code = 'AI_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const prompt = clip(input.prompt, 2000);
  if (!prompt && !clip(input.subject, 300) && !clip(input.body, 4000)) {
    const err = new Error('Describe the email you want, or keep a draft in the form.');
    err.code = 'AI_PROMPT_REQUIRED';
    err.status = 400;
    throw err;
  }

  const referer = String(process.env.PUBLIC_API_URL || 'https://api.datdesk.apexskillzone.com').replace(
    /\/+$/,
    ''
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'HTTP-Referer': referer,
        'X-Title': 'Smart Dat'
      },
      body: JSON.stringify({
        model: openRouterModel(),
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: buildUserPrompt({
              prompt,
              name: input.name,
              subject: input.subject,
              body: input.body,
              mode: input.mode === 'edit' ? 'edit' : 'create'
            })
          }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    const err = new Error(
      error?.name === 'AbortError'
        ? 'AI took too long. Try a shorter request.'
        : 'Could not reach the AI helper. Try again.'
    );
    err.code = error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_NETWORK';
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const detail = String(data?.error?.message || data?.message || '').slice(0, 180);
    const err = new Error(detail || 'AI helper could not write that template.');
    err.code = 'AI_PROVIDER_ERROR';
    err.status = res.status >= 400 && res.status < 500 ? 400 : 502;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  const template = normalizeTemplate(parsed, {
    name: input.name,
    subject: input.subject,
    body: input.body
  });
  if (!template) {
    const err = new Error('AI returned an unusable draft. Try again.');
    err.code = 'AI_BAD_RESPONSE';
    err.status = 502;
    throw err;
  }
  return template;
}

module.exports = {
  openRouterConfigured,
  generateEmailTemplate
};
