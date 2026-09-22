/**
 * Move EVERY label=horizon user onto the Horizon-reserved proxy pool
 * (config/working-proxies.js → RESERVED_FOR_HORIZON), evenly distributed by
 * current load. Also sweeps the reserved proxies for any non-horizon user
 * and moves them off (defense in depth — normally none should be there).
 *
 * Usage (from NEWDATAPP/backend):
 *   node scripts/assign-horizon-users-to-reserved.js --dry-run
 *   node scripts/assign-horizon-users-to-reserved.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const ProxyModel = require('../src/models/Proxy');
const User = require('../src/models/User');
const { parseProxy } = require('../src/utils/proxy');
const { RESERVED_FOR_HORIZON } = require('../config/working-proxies');
const { assignLeastLoadedProxyForUser } = require('../src/utils/proxyLoadBalance');

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newdatapp';

async function getReservedProxyDocs() {
  const docs = [];
  for (const line of RESERVED_FOR_HORIZON) {
    const parsed = parseProxy(line);
    const doc = await ProxyModel.findOne({ host: parsed.host, port: parsed.port });
    if (!doc) throw new Error(`Reserved proxy missing from DB: ${line}`);
    docs.push(doc);
  }
  return docs;
}

async function main() {
  console.log(DRY_RUN ? '[DRY RUN] No writes will be saved.\n' : '');
  console.log('Target DB:', TARGET_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));
  await mongoose.connect(TARGET_URI);
  console.log('Connected.\n');

  const reservedDocs = await getReservedProxyDocs();
  const reservedIds = reservedDocs.map((d) => String(d._id));

  console.log('--- Reserved Horizon proxies ---');
  reservedDocs.forEach((d) => console.log(`  ${d.host}:${d.port} (${d.name})`));

  // 1) Sweep: any non-horizon user still on a reserved proxy gets moved off.
  console.log('\n--- Sweeping reserved proxies for non-horizon users ---');
  const onReserved = await User.find({ proxyId: { $in: reservedDocs.map((d) => d._id) } });
  let swept = 0;
  for (const user of onReserved) {
    const isHorizon = String(user.label || '').trim().toLowerCase() === 'horizon';
    if (isHorizon) continue;
    const next = await assignLeastLoadedProxyForUser({ label: user.label, plan: user.plan });
    console.log(
      `  MOVE OFF  ${user.email} (label=${user.label || 'none'}) → ${
        next ? `${next.host}:${next.port} (${next.name})` : 'NO PROXY AVAILABLE'
      }`
    );
    if (!DRY_RUN) {
      user.proxyId = next ? next._id : null;
      await user.save();
    }
    swept += 1;
  }
  if (!swept) console.log('  none found');

  // 2) Distribute every label=horizon user across the 4 reserved proxies,
  //    balancing by current load (recomputed after the sweep above).
  console.log('\n--- Assigning all label=horizon users onto reserved proxies ---');
  const horizonUsers = await User.find({ label: 'horizon' }).sort({ _id: 1 });
  console.log(`Found ${horizonUsers.length} horizon user(s).\n`);

  const counts = Object.fromEntries(reservedIds.map((id) => [id, 0]));
  // Seed counts with horizon users already correctly placed so we balance
  // around real current load rather than resetting everyone to zero.
  for (const u of horizonUsers) {
    if (u.proxyId && counts[String(u.proxyId)] !== undefined) {
      counts[String(u.proxyId)] += 1;
    }
  }

  let moved = 0;
  let kept = 0;
  for (const user of horizonUsers) {
    const currentId = user.proxyId ? String(user.proxyId) : null;
    if (currentId && counts[currentId] !== undefined) {
      kept += 1;
      console.log(`  KEEP  ${user.email} — already on a reserved proxy`);
      continue;
    }

    // pick the reserved proxy with the lowest count
    let bestId = reservedIds[0];
    for (const id of reservedIds) {
      if (counts[id] < counts[bestId]) bestId = id;
    }
    const target = reservedDocs.find((d) => String(d._id) === bestId);
    counts[bestId] += 1;

    console.log(
      `  MOVE  ${user.email} (plan=${user.plan}) → ${target.host}:${target.port} (${target.name})`
    );
    if (!DRY_RUN) {
      user.proxyId = target._id;
      await user.save();
    }
    moved += 1;
  }

  console.log(`\nDone. kept=${kept} moved=${moved} swept=${swept}${DRY_RUN ? ' (dry run, no writes)' : ''}`);
  console.log('\nFinal distribution:');
  for (const id of reservedIds) {
    const d = reservedDocs.find((x) => String(x._id) === id);
    console.log(`  ${d.host}:${d.port} (${d.name}) → ${counts[id]} horizon user(s)`);
  }

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
