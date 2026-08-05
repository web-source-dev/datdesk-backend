'use strict';

/**
 * Tunnel update packages from the primary VPS when PRIMARY_ASSET_URL is set.
 * Cookie payloads live in MongoDB and do not need tunnelling.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getPrimaryAssetUrl, shouldTunnelAssets } = require('./assetOrigin');

function pickAgent(url) {
  return url.protocol === 'https:' ? https : http;
}

function publicBaseFromReq(req) {
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

function rewriteFeedDownloadHosts(body, primaryBase, publicBase) {
  if (!body || !primaryBase || !publicBase) return body;
  const from = primaryBase.replace(/\/+$/, '');
  const to = publicBase.replace(/\/+$/, '');
  if (from === to) return body;
  return String(body).split(from).join(to);
}

/**
 * Proxy an update feed/download/check request to the primary VPS.
 * Rewrites feed download hosts so the installer still downloads via this backend.
 */
function tunnelUpdateRequest(req, res) {
  const base = getPrimaryAssetUrl();
  if (!base) {
    res.status(503).json({ success: false, message: 'PRIMARY_ASSET_URL is not configured' });
    return;
  }

  const fullPath = req.originalUrl || req.url;
  const target = new URL(fullPath, `${base}/`);
  const forwardHeaders = {};
  for (const key of ['user-agent', 'accept', 'accept-encoding', 'range', 'if-none-match', 'if-modified-since']) {
    if (req.headers[key]) forwardHeaders[key] = req.headers[key];
  }

  console.log('[UPDATE_TUNNEL]', req.method, fullPath, '→', target.href);

  const upstream = pickAgent(target).request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method || 'GET',
      headers: forwardHeaders,
      timeout: 300000
    },
    (upRes) => {
      const status = upRes.statusCode || 502;
      const contentType = String(upRes.headers['content-type'] || '');
      const isTextFeed = /text|json|yaml|yml/i.test(contentType) || fullPath.includes('/feed');

      if (isTextFeed && !fullPath.includes('/download/')) {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf8');
          text = rewriteFeedDownloadHosts(text, base, publicBaseFromReq(req));
          res.status(status);
          if (contentType) res.setHeader('Content-Type', contentType);
          res.send(text);
        });
        return;
      }

      res.status(status);
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (value == null) continue;
        if (['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) continue;
        res.setHeader(key, value);
      }
      upRes.pipe(res);
    }
  );

  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) {
      res.status(504).json({ success: false, message: 'Primary update server timed out' });
    }
  });

  upstream.on('error', (err) => {
    console.error('[UPDATE_TUNNEL] error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: 'Failed to reach primary update server' });
    }
  });

  req.pipe(upstream);
}

module.exports = {
  shouldTunnelAssets,
  tunnelUpdateRequest,
  rewriteFeedDownloadHosts,
  publicBaseFromReq
};
