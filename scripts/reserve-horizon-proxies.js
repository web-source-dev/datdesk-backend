/**
 * Ensure the Horizon-reserved proxy pool (config/working-proxies.js →
 * RESERVED_FOR_HORIZON) exists in the DB and is enabled/"working", then move
 * any user who is NOT label=horizon off those proxies onto a different
 * working proxy. Horizon-labeled users already on a reserved proxy are left
 * in place.
 *
 * Usage (from NEWDATAPP/backend):
 *   node scripts/reserve-horizon-proxies.js --dry-run
 *   node scripts/reserve-horizon-proxies.js
 *
 * Safe to re-run: upserts proxies by host+port, only reassigns users who are
 * currently on a reserved proxy and not label=horizon.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Proxy = require('../src/models/Proxy');
const User = require('../src/models/User');
const { parseProxy } = require('../src/utils/proxy');
const { RESERVED_FOR_HORIZON } = require('../config/working-proxies');
const { assignLeastLoadedProxyForUser } = require('../src/utils/proxyLoadBalance');

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newdatapp';

async function ensureProxyDoc(line) {
  const parsed = parseProxy(line);
  if (!parsed) throw new Error(`Bad proxy line: ${line}`);

  const existing = await Proxy.findOne({ host: parsed.host, port: parsed.port });
  if (existing) {
    let changed = false;
    if (existing.username !== (parsed.username || '')) {
      existing.username = parsed.username || '';
      changed = true;
    }
    if (existing.password !== (parsed.password || '')) {
      existing.password = parsed.password || '';
      changed = true;
    }
    if (existing.enabled !== true) {
      existing.enabled = true;
      changed = true;
    }
    if (changed && !DRY_RUN) await existing.save();
    return { doc: existing, action: changed ? (DRY_RUN ? 'would-update' : 'updated') : 'unchanged' };
  }

  const payload = {
    name: `Horizon · ${parsed.host}:${parsed.port}`,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username || '',
    password: parsed.password || '',
    note: 'Reserved exclusively for label=horizon users',
    enabled: true
  };

  if (DRY_RUN) return { doc: { ...payload, _id: null }, action: 'would-create' };
  const created = await Proxy.create(payload);
  return { doc: created, action: 'created' };
}

async function main() {
  console.log(DRY_RUN ? '[DRY RUN] No writes will be saved.\n' : '');
  console.log('Target DB:', TARGET_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));
  await mongoose.connect(TARGET_URI);
  console.log('Connected.\n');

  console.log('--- Ensuring reserved Horizon proxies exist & are enabled ---');
  const proxyDocs = [];
  for (const line of RESERVED_FOR_HORIZON) {
    const result = await ensureProxyDoc(line);
    console.log(`${result.action.padEnd(14)} ${line}`);
    proxyDocs.push(result.doc);
  }

  const proxyIds = proxyDocs.map((d) => d._id).filter(Boolean);
  if (!proxyIds.length) {
    console.log('\n[DRY RUN] Nothing persisted yet — skipping user reassignment scan.');
    await mongoose.disconnect();
    return;
  }

  console.log('\n--- Scanning users currently on reserved Horizon proxies ---');
  const usersOnReserved = await User.find({ proxyId: { $in: proxyIds } });
  console.log(`Found ${usersOnReserved.length} user(s) on reserved Horizon proxies.\n`);

  let moved = 0;
  let kept = 0;
  for (const user of usersOnReserved) {
    const isHorizon = String(user.label || '').trim().toLowerCase() === 'horizon';
    if (isHorizon) {
      kept += 1;
      console.log(`  KEEP  ${user.email}  (label=horizon) — stays on reserved proxy`);
      continue;
    }

    const nextProxy = await assignLeastLoadedProxyForUser({ label: user.label, plan: user.plan });
    console.log(
      `  MOVE  ${user.email}  (label=${user.label || 'none'}, plan=${user.plan}) → ${
        nextProxy ? `${nextProxy.host}:${nextProxy.port} (${nextProxy.name})` : 'NO PROXY AVAILABLE'
      }`
    );

    if (!DRY_RUN) {
      user.proxyId = nextProxy ? nextProxy._id : null;
      await user.save();
    }
    moved += 1;
  }

  console.log(`\nDone. kept=${kept} moved=${moved}${DRY_RUN ? ' (dry run, no writes)' : ''}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
