'use strict';

/**
 * Extension ZIPs must be reachable from every API host (Render + VPS).
 * Metadata already lives in Mongo; the package bytes go in GridFS so a download
 * on api.datdesk.apexskillzone.com works even when the ZIP was uploaded on the VPS.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const { getPrimaryAssetUrl } = require('./assetOrigin');

const BUCKET_NAME = 'extensionPackages';
const TUNNEL_HEADER = 'x-datdesk-asset-tunnel';

function getBucket() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB is not connected');
  }
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function saveExtensionPackage(buffer, filename) {
  const bucket = getBucket();
  return new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(filename || `extension-${Date.now()}.zip`, {
      contentType: 'application/zip'
    });
    upload.on('error', reject);
    upload.on('finish', () => resolve(upload.id));
    upload.end(buffer);
  });
}

async function deleteExtensionPackage(id) {
  if (!id) return;
  try {
    await getBucket().delete(id);
  } catch (err) {
    const msg = String(err?.message || '');
    if (/FileNotFound|not found|ENOENT/i.test(msg)) return;
    console.warn('[EXTENSION] GridFS delete failed:', msg);
  }
}

async function readExtensionPackage(id) {
  if (!id) return null;
  try {
    return await streamToBuffer(getBucket().openDownloadStream(id));
  } catch (err) {
    console.warn('[EXTENSION] GridFS read failed:', err.message);
    return null;
  }
}

/**
 * Fetch the ZIP from the primary VPS when this host has metadata but no bytes.
 * Skips if PRIMARY_ASSET_URL is unset (the VPS itself) or if this request is
 * already a tunnel hop.
 */
function fetchPackageFromPrimary(req, extId) {
  const base = getPrimaryAssetUrl();
  if (!base || !extId) return Promise.resolve(null);
  if (req?.headers?.[TUNNEL_HEADER]) return Promise.resolve(null);

  const target = new URL(`/extension/${extId}/download`, `${base}/`);
  const agent = target.protocol === 'https:' ? https : http;
  const headers = {
    [TUNNEL_HEADER]: '1',
    accept: 'application/zip, application/octet-stream, */*'
  };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  return new Promise((resolve) => {
    console.log('[EXTENSION] Tunnel download', target.href);
    const upstream = agent.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        timeout: 120000
      },
      (upRes) => {
        const status = upRes.statusCode || 502;
        streamToBuffer(upRes)
          .then((buf) => {
            if (status < 200 || status >= 300 || !buf.length) {
              console.warn('[EXTENSION] Tunnel download HTTP', status, `${buf.length} bytes`);
              resolve(null);
              return;
            }
            resolve(buf);
          })
          .catch((err) => {
            console.warn('[EXTENSION] Tunnel stream failed:', err.message);
            resolve(null);
          });
      }
    );
    upstream.on('timeout', () => {
      upstream.destroy();
      console.warn('[EXTENSION] Tunnel download timed out');
      resolve(null);
    });
    upstream.on('error', (err) => {
      console.warn('[EXTENSION] Tunnel download error:', err.message);
      resolve(null);
    });
    upstream.end();
  });
}

module.exports = {
  sha256,
  saveExtensionPackage,
  deleteExtensionPackage,
  readExtensionPackage,
  fetchPackageFromPrimary,
  TUNNEL_HEADER
};
