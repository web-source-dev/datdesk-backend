/**
 * Import DATHUB DAT sessions, FreightDesk ProxyIp pool, and user custom proxies
 * into Dat Desk `Proxy` collection.
 *
 * Usage (from NEWDATAPP/backend):
 *   node scripts/import-dathub-proxies.js
 *   node scripts/import-dathub-proxies.js --dry-run
 *
 * Env:
 *   MONGODB_URI          — Dat Desk target DB (default from .env)
 *   DATHUB_MONGODB_URI   — DATHUB source DB (required unless set below)
 *
 * Safe to re-run: upserts by importKey in `note` (or host+port+username match).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const Proxy = require('../src/models/Proxy');
const { parseProxy, formatProxy } = require('../src/utils/proxy');

const DRY_RUN = process.argv.includes('--dry-run');

const TARGET_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newdatapp';
const SOURCE_URI =
  process.env.DATHUB_MONGODB_URI ||
  process.env.DATHUB_MONGO_URI ||
  '';

function importKeyTag(key) {
  return `importKey:${key}`;
}

function buildNote(importKey, extra = '') {
  const parts = [importKeyTag(importKey)];
  if (extra) parts.push(String(extra).trim());
  return parts.filter(Boolean).join(' | ').slice(0, 500);
}

function parseHostPortUserPass(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && raw.host) {
    const host = String(raw.host || '').trim();
    const port = String(raw.port || '').trim();
    if (!host || !port) return null;
    return {
      host,
      port,
      username: String(raw.username || '').trim(),
      password: raw.password != null ? String(raw.password) : ''
    };
  }
  return parseProxy(raw);
}

async function upsertProxy(fields) {
  const { name, host, port, username, password, note, enabled, importKey } = fields;
  if (!host || !port) return { action: 'skip', reason: 'missing host/port' };

  const tag = importKeyTag(importKey);
  let existing = await Proxy.findOne({ note: new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  if (!existing) {
    existing = await Proxy.findOne({
      host,
      port: String(port),
      username: username || ''
    });
  }

  const payload = {
    name: String(name || `${host}:${port}`).trim().slice(0, 120),
    host,
    port: String(port),
    username: username || '',
    password: password || '',
    note: note || buildNote(importKey),
    enabled: enabled !== false
  };

  if (DRY_RUN) {
    return { action: existing ? 'would-update' : 'would-create', name: payload.name };
  }

  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return { action: 'updated', id: existing._id, name: payload.name };
  }

  const created = await Proxy.create(payload);
  return { action: 'created', id: created._id, name: payload.name };
}

async function importDatSessions(sourceDb) {
  const sessions = await sourceDb.collection('datsessions').find({}).toArray();
  const stats = { total: sessions.length, created: 0, updated: 0, skipped: 0, would: 0 };

  for (const session of sessions) {
    const parsed = parseHostPortUserPass(session.proxy);
    if (!parsed) {
      stats.skipped += 1;
      continue;
    }

    const key = `dathub-session:${session.externalId || session._id}`;
    const result = await upsertProxy({
      importKey: key,
      name: session.name ? `Session · ${session.name}` : `Session · ${key}`,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      enabled: true,
      note: buildNote(
        key,
        `DAT session${session.label ? ` · label=${session.label}` : ''}${
          session.externalId ? ` · ext=${session.externalId}` : ''
        }`
      )
    });

    if (result.action === 'created') stats.created += 1;
    else if (result.action === 'updated') stats.updated += 1;
    else if (String(result.action).startsWith('would')) stats.would += 1;
    else stats.skipped += 1;
  }

  return stats;
}

async function importProxyIps(sourceDb) {
  const rows = await sourceDb.collection('proxyips').find({}).toArray();
  const stats = { total: rows.length, created: 0, updated: 0, skipped: 0, would: 0 };

  for (const row of rows) {
    const parsed =
      parseHostPortUserPass(row.proxyString) ||
      parseHostPortUserPass({
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password
      });

    if (!parsed) {
      stats.skipped += 1;
      continue;
    }

    const container = String(row.container || '').toUpperCase() || String(row._id);
    const provider = String(row.providerName || '').trim();
    const isHorizon = /horizon/i.test(provider);
    const isCustom = /custom/i.test(provider);
    const key = `dathub-proxyip:${container}`;

    let namePrefix = 'FD';
    if (isHorizon) namePrefix = 'Horizon';
    else if (isCustom) namePrefix = 'Custom pool';

    const result = await upsertProxy({
      importKey: key,
      name: `${namePrefix} · ${container}`,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      enabled: row.isActive !== false,
      note: buildNote(
        key,
        [
          provider ? `provider=${provider}` : '',
          row.legacyId != null ? `legacyId=${row.legacyId}` : ''
        ]
          .filter(Boolean)
          .join(' · ')
      )
    });

    if (result.action === 'created') stats.created += 1;
    else if (result.action === 'updated') stats.updated += 1;
    else if (String(result.action).startsWith('would')) stats.would += 1;
    else stats.skipped += 1;
  }

  return stats;
}

async function importUserCustomProxies(sourceDb) {
  const users = await sourceDb
    .collection('users')
    .find({
      $or: [
        { 'customProxy.host': { $exists: true, $nin: [null, ''] } },
        { 'customProxy.enabled': true }
      ]
    })
    .project({ email: 1, name: 1, customProxy: 1 })
    .toArray();

  const stats = { total: users.length, created: 0, updated: 0, skipped: 0, would: 0 };

  for (const user of users) {
    const parsed = parseHostPortUserPass(user.customProxy);
    if (!parsed) {
      stats.skipped += 1;
      continue;
    }

    const key = `dathub-custom:${user._id}`;
    const label = user.email || user.name || String(user._id);
    const result = await upsertProxy({
      importKey: key,
      name: `Custom · ${label}`,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      enabled: user.customProxy?.enabled !== false,
      note: buildNote(key, `user=${label}`)
    });

    if (result.action === 'created') stats.created += 1;
    else if (result.action === 'updated') stats.updated += 1;
    else if (String(result.action).startsWith('would')) stats.would += 1;
    else stats.skipped += 1;
  }

  return stats;
}

async function main() {
  if (!SOURCE_URI) {
    console.error(
      'Missing DATHUB_MONGODB_URI.\n' +
        'Set it in backend/.env, e.g.:\n' +
        '  DATHUB_MONGODB_URI=mongodb+srv://.../\n' +
        'Then run: node scripts/import-dathub-proxies.js'
    );
    process.exit(1);
  }

  console.log(DRY_RUN ? '[DRY RUN] No writes will be saved.\n' : '');
  console.log('Source (DATHUB):', SOURCE_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));
  console.log('Target (Dat Desk):', TARGET_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));

  const source = await mongoose.createConnection(SOURCE_URI).asPromise();
  await mongoose.connect(TARGET_URI);

  console.log('\nConnected. Importing…\n');

  const sessions = await importDatSessions(source.db);
  console.log('DAT sessions → proxies:', sessions);

  const proxyIps = await importProxyIps(source.db);
  console.log('FreightDesk / pool ProxyIp → proxies:', proxyIps);

  const customs = await importUserCustomProxies(source.db);
  console.log('User custom proxies → proxies:', customs);

  const totalCreated = sessions.created + proxyIps.created + customs.created;
  const totalUpdated = sessions.updated + proxyIps.updated + customs.updated;

  console.log('\nDone.');
  console.log(
    DRY_RUN
      ? `Would create/update from ${sessions.total + proxyIps.total + customs.total} source rows.`
      : `Created ${totalCreated}, updated ${totalUpdated}.`
  );

  await source.close();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Import failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
