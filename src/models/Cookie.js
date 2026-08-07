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
    /** Active cookie for users with label=swiftSolutions */
    isActiveSwiftSolutions: { type: Boolean, default: false, index: true },
    isActiveTest: { type: Boolean, default: false, index: true },
    note: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cookie', cookieSchema);
