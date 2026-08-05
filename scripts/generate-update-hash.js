#!/usr/bin/env node
/**
 * Generate latest.yml for Dat Desk auto-updates (electron-updater).
 * Usage: node scripts/generate-update-hash.js "<Setup.exe>" [version]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
const versionArg = process.argv[3];

if (!filePath) {
  console.error('Usage: node scripts/generate-update-hash.js <installer.exe> [version]');
  process.exit(1);
}

const fullPath = path.resolve(filePath);
if (!fs.existsSync(fullPath)) {
  console.error(`File not found: ${fullPath}`);
  process.exit(1);
}

const fileName = path.basename(fullPath);
const version =
  versionArg ||
  (fileName.match(/(\d+\.\d+\.\d+)/) || [])[1] ||
  '1.0.0';

const fileBuffer = fs.readFileSync(fullPath);
const sha512 = crypto.createHash('sha512').update(fileBuffer).digest('base64');
const size = fs.statSync(fullPath).size;
const releaseDate = new Date().toISOString();

const ymlContent = `version: ${version}
files:
  - url: ${fileName}
    sha512: ${sha512}
    size: ${size}
path: ${fileName}
sha512: ${sha512}
releaseDate: '${releaseDate}'
`;

const ymlPath = path.join(path.dirname(fullPath), 'latest.yml');
fs.writeFileSync(ymlPath, ymlContent);

console.log('Wrote', ymlPath);
console.log({ version, fileName, size, sha512: `${sha512.slice(0, 24)}…` });
