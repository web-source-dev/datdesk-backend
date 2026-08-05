/**
 * One-time: copy legacy uploads/cookies/*.json into Cookie.data in MongoDB.
 * Safe to re-run — skips records that already have data.
 *
 *   node scripts/migrate-cookies-to-db.js
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Cookie = require('../src/models/Cookie');
const {
  normalizeCookiePayload,
  countCookiesInData
} = require('../src/utils/cookies');

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/newdatapp';
  await mongoose.connect(uri);

  const docs = await Cookie.find({
    $or: [{ data: null }, { data: { $exists: false } }]
  });

  let migrated = 0;
  for (const doc of docs) {
    if (!doc.filePath || !fs.existsSync(doc.filePath)) {
      console.warn('Skip (no file):', doc.fileName);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(doc.filePath, 'utf8'));
    const normalized = normalizeCookiePayload(raw);
    const cookieCount = countCookiesInData(normalized);
    doc.data = normalized;
    doc.cookieCount = cookieCount;
    doc.hasCookies = cookieCount > 0;
    doc.fileSize = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    await doc.save();
    migrated += 1;
    console.log('Migrated:', doc.fileName);
  }

  console.log(`Done. Migrated ${migrated} / ${docs.length} cookie records.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
