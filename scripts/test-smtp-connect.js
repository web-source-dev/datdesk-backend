'use strict';

/**
 * Direct SMTP verify (same approach as CargoSignal).
 * Usage:
 *   set SMTP_USER=you@domain.com
 *   set SMTP_PASS=app-password
 *   node scripts/test-smtp-connect.js
 *
 * Optional: SMTP_HOST SMTP_PORT SMTP_SECURE
 */
const nodemailer = require('nodemailer');
const dns = require('dns');
const net = require('net');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Node < 17
}

const user = String(process.env.SMTP_USER || '').trim();
const pass = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
const hostOverride = String(process.env.SMTP_HOST || '').trim();
const portOverride = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 0;
const secureOverride =
  process.env.SMTP_SECURE == null ? null : /^(1|true|yes)$/i.test(process.env.SMTP_SECURE);

if (!user || !pass) {
  console.error('Set SMTP_USER and SMTP_PASS');
  process.exit(1);
}

const attempts = [];
if (hostOverride && portOverride) {
  attempts.push({
    label: 'custom',
    host: hostOverride,
    port: portOverride,
    secure: secureOverride == null ? portOverride === 465 : secureOverride
  });
} else {
  attempts.push(
    { label: 'gmail-587-starttls (CargoSignal)', host: 'smtp.gmail.com', port: 587, secure: false },
    { label: 'gmail-465-ssl', host: 'smtp.gmail.com', port: 465, secure: true }
  );
}

function tcpProbe(host, port, ms = 8000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: `TCP timeout after ${ms}ms` });
    }, ms);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || String(err) });
    });
  });
}

async function verifyAttempt(attempt) {
  const started = Date.now();
  const tcp = await tcpProbe(attempt.host, attempt.port);
  if (!tcp.ok) {
    return { ...attempt, tcp: false, verify: false, ms: Date.now() - started, error: tcp.error };
  }

  const transport = nodemailer.createTransport({
    host: attempt.host,
    port: attempt.port,
    secure: attempt.secure,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000
  });
  try {
    await transport.verify();
    return { ...attempt, tcp: true, verify: true, ms: Date.now() - started };
  } catch (err) {
    return {
      ...attempt,
      tcp: true,
      verify: false,
      ms: Date.now() - started,
      error: err.message || String(err),
      code: err.code || ''
    };
  } finally {
    try {
      transport.close();
    } catch {
      // ignore
    }
  }
}

(async () => {
  console.log(`User: ${user}`);
  console.log(`Pass length: ${pass.length} (spaces stripped)`);
  for (const attempt of attempts) {
    console.log(`\n--- ${attempt.label} ${attempt.host}:${attempt.port} secure=${attempt.secure} ---`);
    const result = await verifyAttempt(attempt);
    if (result.verify) {
      console.log(`OK in ${result.ms}ms`);
    } else {
      console.log(`FAIL in ${result.ms}ms`);
      console.log(`tcp=${result.tcp} code=${result.code || '-'} error=${result.error || '-'}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
