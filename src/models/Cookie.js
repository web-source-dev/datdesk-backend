const mongoose = require('mongoose');

/**
 * Cookie session payload lives in `data` (MongoDB), so any backend
 * sharing this database can serve cookies without a local uploads folder.
 */
const cookieSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true, unique: true, trim: true, index: true },
    /** Normalized cookie payload: { "dat.com": { cookies, localStorage, sessionStorage } } */
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    /** @deprecated Legacy disk path — migrated into `data` on first read */
    filePath: { type: String, default: '' },
    cookieCount: { type: Number, default: 0 },
    hasCookies: { type: Boolean, default: false },
    fileSize: { type: Number, default: 0 },
    /** FreightDesk / admin label (new, single, double, …) */
    label: { type: String, trim: true, default: 'new', index: true },
    /** Optional display name for partner dashboard / filters */
    sessionName: { type: String, trim: true, default: '' },
    /** freightdesk | manual */
    source: { type: String, trim: true, default: 'manual', index: true },
    lastUpdated: { type: Date, default: null },
    /** Admin flag: known-good / working session */
    isWorking: { type: Boolean, default: false, index: true },
    /** @deprecated Prefer plan channel flags */
    isActive: { type: Boolean, default: false, index: true },
    isActiveSingle: { type: Boolean, default: false, index: true },
    isActiveDouble: { type: Boolean, default: false, index: true },
    isActiveMulti: { type: Boolean, default: false, index: true },
    /** Active cookie for users with label=horizon */
    isActiveHorizon: { type: Boolean, default: false, index: true },
    /** Active cookie for users with label=swiftSolutions */
    isActiveSwiftSolutions: { type: Boolean, default: false, index: true },
    isActiveTest: { type: Boolean, default: false, index: true },
    /** When each channel flag was last turned on (key = flag name). Newest wins if two are set. */
    activatedAt: { type: Map, of: Date, default: undefined },
    note: { type: String, trim: true, default: '' },
    /** User agent the session was captured with (replayed so the login looks like the same browser). */
    userAgent: { type: String, default: '' },
    /** Proxy bound to this account, `host:port[:user:pass]`. Every user on this account exits this IP. */
    proxy: { type: String, default: '' },
    /** Stable synthetic device fingerprint for this account (see utils/deviceProfile). */
    fingerprint: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Hash of the login cookies in `data` (see utils/sessionFingerprint). */
    sessionFingerprint: { type: String, default: '' },
    /** Latest Auth0 login cookie expiry in `data` — newer means a fresher DAT login. */
    authExpiresAt: { type: Date, default: null },
    /** Hash of the payload last imported from FreightDesk (tells FD changes from Dat Desk syncs). */
    fdFingerprint: { type: String, default: '' },
    fdImportedAt: { type: Date, default: null },
    /** Last time a running Dat Desk wrote a renewed session into `data`, and whose. */
    syncedAt: { type: Date, default: null },
    syncedBy: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cookie', cookieSchema);
