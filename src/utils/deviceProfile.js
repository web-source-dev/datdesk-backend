'use strict';

/**
 * A stable, synthetic device fingerprint per DAT account.
 *
 * DAT (and its bot protection) treats one login that appears as many different machines —
 * different WebGL, timezone, CPU, user agent — as a compromised session and logs it out.
 * FreightDesk avoids that by pinning every session for an account to one synthetic machine.
 * We do the same, but derive the values deterministically from the account id, so:
 *   - every device and every app that opens account X presents the SAME fingerprint, and
 *   - two different accounts do not share one identical fingerprint (which is its own flag).
 *
 * The profile is advisory data the desktop client applies before DAT loads (user agent,
 * client hints, navigator.* overrides). Nothing here talks to DAT itself.
 */

const crypto = require('crypto');

/** Pools chosen to look like ordinary US Windows/Chrome desktops. */
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix'
];

// WebGL pools per OS. The renderer string must match the UA's OS — ANGLE/Direct3D11 only
// exists on Windows, Metal/OpenGL strings on macOS — or the pair is itself a bot signal.
const WEBGL_WIN = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' }
];
const WEBGL_MAC = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
  { vendor: 'Google Inc. (Intel Inc.)', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)' }
];
const WEBGL_LINUX = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)' },
  { vendor: 'Google Inc. (NVIDIA Corporation)', renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1060/PCIe/SSE2, OpenGL 4.6)' }
];

const HARDWARE_CONCURRENCY = [4, 8, 8, 12, 16];
const DEVICE_MEMORY = [8, 8, 16, 16];

/** Detect the OS family from a UA so the rest of the profile matches it. */
function osFromUa(userAgent) {
  const ua = String(userAgent || '');
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/(X11|Linux)/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  return 'win';
}

/** navigator.platform, Sec-CH-UA-Platform and the WebGL pool for an OS family. */
function osProfile(os) {
  if (os === 'mac') return { platform: 'MacIntel', uaPlatform: 'macOS', webgl: WEBGL_MAC };
  if (os === 'linux') return { platform: 'Linux x86_64', uaPlatform: 'Linux', webgl: WEBGL_LINUX };
  return { platform: 'Win32', uaPlatform: 'Windows', webgl: WEBGL_WIN };
}

/** A default Chrome-on-Windows UA used when the captured session had none. */
const DEFAULT_CHROME_MAJOR = 125;
function defaultUserAgent(major = DEFAULT_CHROME_MAJOR) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Deterministic byte stream from a seed, so every field pick is stable per account. */
function seededBytes(seed) {
  return crypto.createHash('sha256').update(String(seed || 'default')).digest();
}

function pick(list, byte) {
  return list[byte % list.length];
}

/** Chrome major version from a UA string, or null. */
function chromeMajorFromUa(userAgent) {
  const m = String(userAgent || '').match(/Chrome\/(\d+)\./);
  return m ? Number(m[1]) : null;
}

/** Sec-CH-UA brand list for a Chrome major (matches what Chromium actually sends). */
function uaBrands(major) {
  const v = String(major);
  return [
    { brand: 'Chromium', version: v },
    { brand: 'Google Chrome', version: v },
    { brand: 'Not.A/Brand', version: '24' }
  ];
}

/**
 * Build the device profile for an account.
 * @param {string} seed      Stable account id (DAT ajs_user_id) or container/fileName.
 * @param {string} userAgent Captured user agent, if any; otherwise a default is used.
 * @returns {object} profile the desktop client applies before DAT loads.
 */
function buildDeviceProfile(seed, userAgent = '') {
  const bytes = seededBytes(seed);
  const ua = String(userAgent || '').trim() || defaultUserAgent();
  const major = chromeMajorFromUa(ua) || DEFAULT_CHROME_MAJOR;
  // Derive platform/WebGL from the UA's OS so the whole profile is internally consistent
  // (a Mac UA with a Windows platform or a Direct3D11 GPU is itself a detection signal).
  const os = osProfile(osFromUa(ua));
  const gl = pick(os.webgl, bytes[3]);

  return {
    seed: String(seed || ''),
    userAgent: ua,
    chromeMajor: major,
    platform: os.platform,
    uaPlatform: os.uaPlatform,
    uaMobile: false,
    uaBrands: uaBrands(major),
    acceptLanguages: 'en-US,en;q=0.9',
    languages: ['en-US', 'en'],
    language: 'en-US',
    timezone: pick(TIMEZONES, bytes[0]),
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY, bytes[1]),
    deviceMemory: pick(DEVICE_MEMORY, bytes[2])
  };
}

module.exports = {
  buildDeviceProfile,
  chromeMajorFromUa,
  defaultUserAgent
};
