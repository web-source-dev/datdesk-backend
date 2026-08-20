/**
 * Copy DATHUB users with label "Horizon" into Dat Desk (NEWDATAPP).
 * Existing emails are skipped (not updated). New users get a shared password.
 *
 * Usage (from NEWDATAPP/backend):
 *   node scripts/import-dathub-horizon-users.js
 *   node scripts/import-dathub-horizon-users.js --dry-run
 *
 * Env:
 *   MONGODB_URI          — Dat Desk target DB
 *   DATHUB_MONGODB_URI   — DATHUB source DB
 *   HORIZON_IMPORT_PASSWORD — default Horizon999000
 */

require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');
const { normalizePermissions, DEFAULT_PERMISSIONS } = require('../src/utils/permissions');

const DRY_RUN = process.argv.includes('--dry-run');
const PASSWORD = process.env.HORIZON_IMPORT_PASSWORD || 'Horizon999000';
const TARGET_URI = process.env.MONGODB_URI;
const SOURCE_URI = process.env.DATHUB_MONGODB_URI || process.env.DATHUB_MONGO_URI;

function mapRole(role) {
  if (role === 'admin') return 'admin';
  return 'user';
}

function mapPermissions(permDoc) {
  if (!permDoc) return { ...DEFAULT_PERMISSIONS };
  return normalizePermissions({
    openDat: true,
    datMultitab: !!permDoc.datMultitab,
    datMultitabNumbers: permDoc.datMultitabNumbers,
    webMultitab: !!permDoc.webMultitab,
    webMultitabNumbers: permDoc.webMultitabNumbers,
    customTabs: []
  });
}

async function main() {
  if (!TARGET_URI) throw new Error('MONGODB_URI is not set');
  if (!SOURCE_URI) throw new Error('DATHUB_MONGODB_URI is not set');

  const source = await mongoose.createConnection(SOURCE_URI).asPromise();
  const sourceUsers = source.collection('users');
  const sourcePerms = source.collection('permissions');

  const horizonUsers = await sourceUsers
    .find({ label: { $regex: '^horizon$', $options: 'i' } })
    .project({
      name: 1,
      email: 1,
      role: 1,
      plan: 1,
      label: 1,
      isBanned: 1,
      phone: 1,
      anydeskid: 1,
      note: 1,
      customProxy: 1
    })
    .toArray();

  console.log(`DATHUB Horizon users: ${horizonUsers.length}`);
  console.log(`Password for new users: ${PASSWORD}`);
  console.log(DRY_RUN ? 'DRY RUN — no writes\n' : '');

  await mongoose.connect(TARGET_URI);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const src of horizonUsers) {
    const email = String(src.email || '')
      .trim()
      .toLowerCase();
    if (!email) {
      console.log('SKIP (no email)', src._id);
      skipped += 1;
      continue;
    }

    const existing = await User.findOne({ email });
    if (existing) {
      console.log(`SKIP exists  ${email}`);
      skipped += 1;
      continue;
    }

    const permDoc = await sourcePerms.findOne({ userId: src._id });
    const payload = {
      name: src.name || email,
      email,
      password: PASSWORD,
      role: mapRole(src.role),
      isBanned: !!src.isBanned,
      plan: src.plan === 'double' || src.plan === 'multi' ? src.plan : 'single',
      label: src.label || 'Horizon',
      phone: src.phone || '',
      anydeskid: src.anydeskid || '',
      note: src.note || '',
      domain: permDoc?.domain || 'https://one.dat.com/search-loads',
      permissions: mapPermissions(permDoc),
      customProxy: {
        enabled: !!src.customProxy?.enabled,
        host: src.customProxy?.host || '',
        port: src.customProxy?.port || 0,
        username: src.customProxy?.username || '',
        password: src.customProxy?.password || ''
      }
    };

    if (DRY_RUN) {
      console.log(`CREATE        ${email}  (${payload.name}, ${payload.plan})`);
      created += 1;
      continue;
    }

    try {
      await User.create(payload);
      console.log(`CREATED       ${email}  (${payload.name}, ${payload.plan})`);
      created += 1;
    } catch (err) {
      console.error(`FAILED        ${email}:`, err.message);
      failed += 1;
    }
  }

  await mongoose.disconnect();
  await source.close();

  console.log('');
  console.log(`Created: ${created}`);
  console.log(`Skipped (already existed): ${skipped}`);
  console.log(`Failed: ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
