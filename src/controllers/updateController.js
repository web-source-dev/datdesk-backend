const path = require('path');
const fs = require('fs');
const AppUpdateSetting = require('../models/AppUpdateSetting');
const { shouldTunnelAssets, tunnelUpdateRequest } = require('../utils/assetTunnel');

// Default app for legacy clients that call the update API WITHOUT an `app` param.
// All currently-released/active installs are DAT GO and send no app param, so we
// must serve them dat-go updates (this matches the pre-namespacing behaviour).
const DEFAULT_APP = process.env.DEFAULT_UPDATE_APP || 'datdesk';

/**
 * Public origin for absolute download URLs in latest.yml.
 * Behind nginx, req.protocol is often "http" even when clients use HTTPS, which
 * makes electron-updater follow http→https redirects and can fail with 405.
 */
function getPublicBaseUrl(req) {
  const fromEnv = (process.env.PUBLIC_BASE_URL || process.env.UPDATE_PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (fromEnv) return fromEnv;

  const xfProto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  let protocol = xfProto || req.protocol || 'https';
  const isLocal =
    !host ||
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host);
  if (protocol === 'http' && !isLocal) protocol = 'https';
  return `${protocol}://${host}`;
}

/**
 * Sanitize the `app` query/param so each application gets its own update folder.
 * Multiple desktop apps (e.g. dat-hub, dat-go) share this backend, so updates are
 * namespaced under updates/<app>/<platform>/. Returns:
 *   - a safe slug string when a valid app is provided
 *   - '' when no app is provided (caller then falls back to DEFAULT_APP)
 *   - null when the value is unsafe/invalid
 */
function sanitizeApp(app) {
  if (app === undefined || app === null || app === '') return '';
  const slug = String(app).toLowerCase().trim();
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return slug;
}

/**
 * Resolve the effective app slug: the provided one, or DEFAULT_APP for legacy
 * (no-app) requests. Returns null only when the provided value was invalid.
 */
function resolveApp(rawApp) {
  const appSub = sanitizeApp(rawApp);
  if (appSub === null) return null;
  return appSub || DEFAULT_APP;
}

/**
 * Resolve the base updates directory, namespaced by app.
 */
function resolveBaseDir(appSub) {
  const UPDATE_DIR = process.env.UPDATE_DIR || path.join(__dirname, '../../updates');
  return appSub ? path.join(UPDATE_DIR, appSub) : UPDATE_DIR;
}

/**
 * Whether auto-updates are currently enabled for an app. Controlled from the
 * admin panel and stored in MongoDB (shared across all backend deployments).
 * Default ON when no setting exists. Fails open (returns true) on a DB error so
 * a transient hiccup never silently blocks updates.
 */
async function areUpdatesEnabled(app) {
  try {
    const doc = await AppUpdateSetting.findOne({ app });
    return doc ? doc.updatesEnabled !== false : true;
  } catch (error) {
    console.error('[UPDATE] Failed to read update setting for', app, '-', error.message);
    return true;
  }
}

/**
 * List app slugs that have an updates folder on disk (dat-go, dat-hub, ...).
 */
function listKnownApps() {
  const UPDATE_DIR = process.env.UPDATE_DIR || path.join(__dirname, '../../updates');
  try {
    return fs.readdirSync(UPDATE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[a-z0-9-]+$/.test(name));
  } catch (error) {
    return [];
  }
}

/**
 * Get update information
 * GET /update/check?platform=win32&arch=x64&version=1.0.0&app=dat-go
 * Returns update metadata for electron-updater
 */
async function checkUpdate(req, res) {
  if (shouldTunnelAssets()) {
    return tunnelUpdateRequest(req, res);
  }
  try {
    const { platform, arch, version } = req.query;

    // Validate required parameters
    if (!platform || !arch || !version) {
      return res.status(400).json({
        success: false,
        message: 'platform, arch, and version query parameters are required'
      });
    }

    // Resolve the per-app update folder (shared backend serves multiple apps).
    // Legacy clients send no app param -> falls back to DEFAULT_APP (dat-go).
    const effectiveApp = resolveApp(req.query.app);
    if (effectiveApp === null) {
      return res.status(400).json({ success: false, message: 'Invalid app identifier' });
    }

    // Auto-updates can be turned off per app from the admin panel.
    if (!(await areUpdatesEnabled(effectiveApp))) {
      return res.json({
        success: true,
        available: false,
        message: 'Auto-updates are currently disabled',
        currentVersion: version
      });
    }

    const baseDir = resolveBaseDir(effectiveApp);
    const appSegment = `/${effectiveApp}`;

    // Determine platform-specific directory
    let platformDir = '';
    if (platform === 'win32') {
      platformDir = arch === 'ia32' ? 'win32-ia32' : 'win32-x64';
    } else if (platform === 'darwin') {
      platformDir = 'darwin';
    } else if (platform === 'linux') {
      platformDir = arch === 'ia32' ? 'linux-ia32' : 'linux-x64';
    } else {
      return res.status(400).json({
        success: false,
        message: `Unsupported platform: ${platform}`
      });
    }

    const updatePath = path.join(baseDir, platformDir);

    // Check if update directory exists
    if (!fs.existsSync(updatePath)) {
      return res.status(404).json({
        success: false,
        message: 'No updates available',
        available: false
      });
    }

    // Read latest.yml or latest.json (electron-updater format)
    let latestFile = null;
    let latestData = null;
    
    const ymlPath = path.join(updatePath, 'latest.yml');
    const jsonPath = path.join(updatePath, 'latest.json');
    
    if (fs.existsSync(ymlPath)) {
      latestFile = ymlPath;
      // Parse YAML-like format (simplified parser for electron-updater format)
      const ymlContent = fs.readFileSync(ymlPath, 'utf8');
      latestData = parseLatestYml(ymlContent);
    } else if (fs.existsSync(jsonPath)) {
      latestFile = jsonPath;
      latestData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } else {
      return res.status(404).json({
        success: false,
        message: 'No update metadata found',
        available: false
      });
    }

    // Compare versions
    const currentVersion = version;
    const latestVersion = latestData.version;

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      return res.json({
        success: true,
        available: false,
        message: 'You are using the latest version',
        currentVersion,
        latestVersion
      });
    }

    // Update is available
    
    // Get file info
    const fileName = latestData.path || latestData.fileName;
    const filePath = fileName ? path.join(updatePath, fileName) : null;
    let fileSize = null;
    
    if (filePath && fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      fileSize = stats.size;
    }

    // Return update info in electron-updater format
    res.json({
      success: true,
      available: true,
      version: latestVersion,
      currentVersion: currentVersion,
      releaseDate: latestData.releaseDate || new Date().toISOString(),
      releaseNotes: latestData.releaseNotes || latestData.releaseName || `Update to version ${latestVersion}`,
      path: fileName ? `/update/download${appSegment}/${platformDir}/${fileName}` : null,
      sha512: latestData.sha512 || null,
      size: fileSize,
      // For electron-updater generic provider
      url: fileName
        ? `${getPublicBaseUrl(req)}/update/download${appSegment}/${platformDir}/${fileName}`
        : null
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Download update file
 * GET /update/download/:platform/:fileName
 * GET /update/download/:app/:platform/:fileName   (app-namespaced)
 */
async function downloadUpdate(req, res) {
  if (shouldTunnelAssets()) {
    return tunnelUpdateRequest(req, res);
  }
  try {
    const { platform, fileName } = req.params;

    // Express automatically URL-decodes route parameters
    // So fileName will be decoded (e.g., "DAT GO Setup 1.1.0.exe" instead of "DAT%20GO%20Setup%201.1.0.exe")
    const decodedFileName = decodeURIComponent(fileName);

    // Validate parameters
    if (!platform || !decodedFileName) {
      return res.status(400).json({
        success: false,
        message: 'platform and fileName are required'
      });
    }

    // Resolve per-app namespace. Legacy (no app segment) -> DEFAULT_APP (dat-go).
    const effectiveApp = resolveApp(req.params.app);
    if (effectiveApp === null) {
      return res.status(400).json({ success: false, message: 'Invalid app identifier' });
    }

    // Security: Prevent directory traversal
    if (decodedFileName.includes('..') || platform.includes('..')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file path'
      });
    }

    // Get update directory (namespaced by app)
    const baseDir = resolveBaseDir(effectiveApp);
    const filePath = path.join(baseDir, platform, decodedFileName);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Update file not found'
      });
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    
    // Set headers for file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${decodedFileName}"`);
    res.setHeader('Content-Length', stats.size);
    
    // Stream file to response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get update feed (for electron-updater generic provider)
 * GET /update/feed?platform=win32&arch=x64
 * Returns latest.yml content or JSON metadata
 */
async function getUpdateFeed(req, res) {
  if (shouldTunnelAssets()) {
    return tunnelUpdateRequest(req, res);
  }
  try {
    // Try to get platform and arch from query params first
    let { platform, arch } = req.query;
    
    // If not in query params, try to extract from User-Agent header
    // electron-updater sends User-Agent like: "electron-updater/6.x.x (Windows NT 10.0; Win64; x64)"
    if (!platform || !arch) {
      const userAgent = req.get('User-Agent') || '';
      
      // Extract platform from User-Agent
      if (userAgent.includes('Windows')) {
        platform = platform || 'win32';
      } else if (userAgent.includes('Mac') || userAgent.includes('Darwin')) {
        platform = platform || 'darwin';
      } else if (userAgent.includes('Linux')) {
        platform = platform || 'linux';
      }
      
      // Extract arch from User-Agent
      if (userAgent.includes('x64') || userAgent.includes('Win64') || userAgent.includes('x86_64')) {
        arch = arch || 'x64';
      } else if (userAgent.includes('ia32') || userAgent.includes('x86')) {
        arch = arch || 'ia32';
      } else if (userAgent.includes('arm64')) {
        arch = arch || 'arm64';
      }
    }
    
    if (!platform || !arch) {
      // Default to win32-x64 if we can't determine
      platform = platform || 'win32';
      arch = arch || 'x64';
    }

    // Resolve the per-app update folder (shared backend serves multiple apps).
    // Legacy clients send no app param -> falls back to DEFAULT_APP (dat-go).
    const effectiveApp = resolveApp(req.query.app);
    if (effectiveApp === null) {
      return res.status(400).json({ success: false, message: 'Invalid app identifier' });
    }
    const appSegment = `/${effectiveApp}`;

    // Auto-updates can be turned off per app from the admin panel.
    const updatesEnabled = await areUpdatesEnabled(effectiveApp);

    // Determine platform-specific directory
    let platformDir = '';
    if (platform === 'win32') {
      platformDir = arch === 'ia32' ? 'win32-ia32' : 'win32-x64';
    } else if (platform === 'darwin') {
      platformDir = 'darwin';
    } else if (platform === 'linux') {
      platformDir = arch === 'ia32' ? 'linux-ia32' : 'linux-x64';
    } else {
      return res.status(400).json({
        success: false,
        message: `Unsupported platform: ${platform}`
      });
    }

    const updatePath = path.join(resolveBaseDir(effectiveApp), platformDir);

    if (!fs.existsSync(updatePath)) {
      return res.status(404).json({
        success: false,
        message: 'No updates available'
      });
    }

    // Try to read latest.yml first (electron-updater format)
    const ymlPath = path.join(updatePath, 'latest.yml');
    if (fs.existsSync(ymlPath)) {
      let ymlContent = fs.readFileSync(ymlPath, 'utf8');

      // Auto-updates disabled for this app: report version 0.0.0 so every client
      // (all >= 1.0.0) sees itself as up-to-date. electron-updater then fires a
      // clean "update-not-available" with no error and no download attempt.
      if (!updatesEnabled) {
        ymlContent = ymlContent.replace(/^version:\s*.+$/m, 'version: 0.0.0');
        res.setHeader('Content-Type', 'text/plain');
        return res.send(ymlContent);
      }

      // Parse the YAML to get the filename
      const latestData = parseLatestYml(ymlContent);
      const fileName = latestData.path || latestData.fileName;
      
      if (!fileName) {
        console.error('[UPDATE] No filename found in latest.yml');
        return res.status(500).json({
          success: false,
          message: 'Invalid latest.yml: missing path field'
        });
      }
      
      // Construct the absolute download URL prefix for this app/platform.
      // electron-updater's generic provider accepts absolute URLs, so we rewrite
      // every relative file reference in the manifest to point at our namespaced
      // download route (/update/download/<app>/<platformDir>/<file>).
      const baseUrl = getPublicBaseUrl(req);
      const downloadPrefix = `${baseUrl}/update/download${appSegment}/${platformDir}`;
      const toAbsolute = (relName) => `${downloadPrefix}/${encodeURIComponent(relName)}`;

      // Rewrite each `files: - url:` entry. THIS is what electron-updater v6+
      // actually downloads from; leaving it relative makes the client resolve it
      // against the feed URL (.../update/feed/...), which 404s and silently aborts
      // the update. Skip values that are already absolute. Handles multiple
      // entries (e.g. installer + .blockmap), each keyed to its own filename.
      ymlContent = ymlContent.replace(
        /^(\s*-\s*url:\s*)(.+)$/gm,
        (match, prefix, value) => {
          const name = value.trim();
          if (/^https?:\/\//i.test(name)) return match;
          return `${prefix}${toAbsolute(name)}`;
        }
      );

      // Rewrite the deprecated top-level `path:` for older electron-updater clients.
      ymlContent = ymlContent.replace(
        /^(path:\s*)(.+)$/m,
        (match, prefix, value) => {
          const name = value.trim();
          if (/^https?:\/\//i.test(name)) return match;
          return `${prefix}${toAbsolute(name)}`;
        }
      );

      // Return as text/plain for electron-updater
      res.setHeader('Content-Type', 'text/plain');
      return res.send(ymlContent);
    }

    // Fallback to latest.json
    const jsonPath = path.join(updatePath, 'latest.json');
    if (fs.existsSync(jsonPath)) {
      const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // Auto-updates disabled: report version 0.0.0 so clients stay put.
      if (!updatesEnabled) {
        jsonData.version = '0.0.0';
      }
      // Convert to electron-updater format
      return res.json(jsonData);
    }

    return res.status(404).json({
      success: false,
      message: 'No update metadata found'
    });

  } catch (error) {
    console.error('[UPDATE] Get feed error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Helper function to parse latest.yml (simplified parser)
 * Electron-updater uses YAML format but we'll parse key fields
 * Supports both quoted and unquoted values
 */
function parseLatestYml(content) {
  const data = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      let value = trimmed.substring(colonIndex + 1).trim();
      
      // Remove quotes if present (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // Try to parse as number if it's a numeric string
      if (key === 'size' && !isNaN(value)) {
        data[key] = parseInt(value, 10);
      } else {
        data[key] = value;
      }
    }
  }
  
  return data;
}

/**
 * Compare version strings (semantic versioning)
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 * Handles versions like "1.0.0", "1.0.0-beta", "1.0.0-alpha.1"
 */
function compareVersions(v1, v2) {
  // Remove any pre-release identifiers for comparison
  const cleanV1 = v1.split('-')[0].split('+')[0];
  const cleanV2 = v2.split('-')[0].split('+')[0];
  
  const parts1 = cleanV1.split('.').map(Number);
  const parts2 = cleanV2.split('.').map(Number);
  
  const maxLength = Math.max(parts1.length, parts2.length);
  
  for (let i = 0; i < maxLength; i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 < part2) return -1;
    if (part1 > part2) return 1;
  }
  
  return 0;
}

/**
 * Get per-app auto-update config (admin)
 * GET /update/config
 * Returns every known app (folders on disk + any stored settings) with its
 * current updatesEnabled flag (default true).
 */
async function getUpdateConfig(req, res) {
  try {
    const docs = await AppUpdateSetting.find({});
    const enabledByApp = new Map(docs.map((d) => [d.app, d.updatesEnabled !== false]));

    const apps = new Set([DEFAULT_APP, ...listKnownApps(), ...enabledByApp.keys()]);
    const data = Array.from(apps)
      .sort()
      .map((app) => ({
        app,
        updatesEnabled: enabledByApp.has(app) ? enabledByApp.get(app) : true
      }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('[UPDATE] Get config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load update config',
      error: error.message
    });
  }
}

/**
 * Set per-app auto-update on/off (admin)
 * PUT /update/config/:app   body: { updatesEnabled: boolean }
 */
async function setUpdateConfig(req, res) {
  try {
    const app = sanitizeApp(req.params.app);
    if (!app) {
      return res.status(400).json({ success: false, message: 'Invalid app identifier' });
    }

    const { updatesEnabled } = req.body || {};
    if (typeof updatesEnabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'updatesEnabled (boolean) is required' });
    }

    const doc = await AppUpdateSetting.findOneAndUpdate(
      { app },
      { app, updatesEnabled },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, data: { app: doc.app, updatesEnabled: doc.updatesEnabled } });
  } catch (error) {
    console.error('[UPDATE] Set config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update config',
      error: error.message
    });
  }
}

module.exports = {
  checkUpdate,
  downloadUpdate,
  getUpdateFeed,
  getUpdateConfig,
  setUpdateConfig
};

