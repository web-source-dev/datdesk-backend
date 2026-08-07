/**
 * Create / update the Swift Solutions master admin on BOTH databases:
 * - Swift App  (NEWDATAPP / Dat Desk Mongo)
 * - Swift Extension (DATHUB / DAT Go Mongo)
 *
 * Usage (from NEWDATAPP/backend):
 *   node scripts/create-swift-partner-admins.js
 *
 * Optional env overrides:
 *   SWIFT_PARTNER_ADMIN_EMAIL
 *   SWIFT_PARTNER_ADMIN_PASSWORD
 *   SWIFT_PARTNER_ADMIN_NAME
 *   SWIFT_APP_MONGODB_URI   (defaults to MONGODB_URI)
 *   SWIFT_EXT_MONGODB_URI   (defaults to DATHUB_MONGODB_URI)
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const EMAIL = (
  process.env.SWIFT_PARTNER_ADMIN_EMAIL || 'admin@swiftsolutions.com'
)
  .trim()
  .toLowerCase();
const PASSWORD =
  process.env.SWIFT_PARTNER_ADMIN_PASSWORD || 'swiftsolutions09890';
const NAME = process.env.SWIFT_PARTNER_ADMIN_NAME || 'Swift Solutions Admin';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function upsertAdmin(uri, label) {
  if (!uri) {
    throw new Error(`No MongoDB URI configured for ${label}`);
  }

  const conn = await mongoose.createConnection(uri).asPromise();
  const users = conn.collection('users');
  const hash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();

  const existing = await users.findOne({ email: EMAIL });

  if (existing) {
    await users.updateOne(
      { email: EMAIL },
      {
        $set: {
          name: NAME,
          password: hash,
          role: 'admin',
          isBanned: false,
          updatedAt: now
        }
      }
    );
    console.log(`[${label}] Updated admin → ${EMAIL}`);
  } else {
    await users.insertOne({
      name: NAME,
      email: EMAIL,
      password: hash,
      role: 'admin',
      isBanned: false,
      plan: 'single',
      label: '',
      note: 'Swift Solutions partner master admin',
      phone: '',
      anydeskid: '',
      domain: 'https://one.dat.com/search-loads',
      permissions: {
        openDat: true,
        datMultitab: true,
        datMultitabNumbers: 10,
        webMultitab: true,
        webMultitabNumbers: 5,
        customTabs: []
      },
      monthlyPaymentAmount: 0,
      billingDate: now.getDate(),
      sessionOpenMode: 'cookie',
      createdAt: now,
      updatedAt: now
    });
    console.log(`[${label}] Created admin → ${EMAIL}`);
  }

  await conn.close();
}

async function main() {
  const newdatEnv = loadEnvFile(
    path.join(__dirname, '../.env')
  );
  const dathubEnv = loadEnvFile(
    path.join(__dirname, '../../../DATHUB/backend/.env')
  );

  const swiftAppUri =
    process.env.SWIFT_APP_MONGODB_URI ||
    process.env.MONGODB_URI ||
    newdatEnv.MONGODB_URI;

  const swiftExtUri =
    process.env.SWIFT_EXT_MONGODB_URI ||
    process.env.DATHUB_MONGODB_URI ||
    dathubEnv.MONGODB_URI ||
    newdatEnv.DATHUB_MONGODB_URI;

  console.log('Swift Solutions partner admin seed');
  console.log(`  email: ${EMAIL}`);
  console.log(`  name:  ${NAME}`);
  console.log('');

  await upsertAdmin(swiftAppUri, 'Swift App');
  await upsertAdmin(swiftExtUri, 'Swift Extension');

  console.log('');
  console.log('Done. Use these credentials in partner-admin .env:');
  console.log(`  NEXT_PUBLIC_PARTNER_MASTER_EMAIL=${EMAIL}`);
  console.log(`  NEXT_PUBLIC_PARTNER_MASTER_PASSWORD=${PASSWORD}`);
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
