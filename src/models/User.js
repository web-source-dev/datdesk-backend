const mongoose = require('mongoose');
const { hashPassword } = require('../utils/password');
const { DEFAULT_PERMISSIONS } = require('../utils/permissions');

const customTabSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    openMode: {
      type: String,
      enum: ['app', 'external'],
      default: 'app'
    }
  },
  { _id: false }
);

const permissionsSchema = new mongoose.Schema(
  {
    openDat: { type: Boolean, default: true },
    /** Allow extra tabs inside DAT One UI (CSS gated) */
    datMultitab: { type: Boolean, default: false },
    datMultitabNumbers: { type: Number, default: 1, min: 1, max: 10 },
    /** Allow multiple Electron browser tabs in the DAT window */
    webMultitab: { type: Boolean, default: false },
    webMultitabNumbers: { type: Number, default: 1, min: 1, max: 10 },
    /** In-app custom tab buttons on the desktop dashboard */
    customTabs: { type: [customTabSchema], default: [] }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    password: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ['admin', 'user'],
      default: 'user',
      index: true
    },
    isBanned: { type: Boolean, default: false },
    domain: {
      type: String,
      default: 'https://one.dat.com/search-loads',
      trim: true
    },
    /**
     * Cookie channel routing (like DATHUB).
     * label=test → Test cookie; label=swiftSolutions → Swift Solutions cookie;
     * otherwise plan (single|double|multi) selects the channel.
     */
    plan: {
      type: String,
      enum: ['single', 'double', 'multi'],
      default: 'single',
      index: true
    },
    label: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    /** Optional per-user cookie override (wins over channel active cookie) */
    assignedCookieId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cookie',
      default: null,
      index: true
    },
    permissions: {
      type: permissionsSchema,
      default: () => ({ ...DEFAULT_PERMISSIONS })
    },
    proxyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Proxy',
      default: null,
      index: true
    },
    proxy: {
      type: String,
      trim: true,
      default: ''
    },
    /** Staff Ctrl+Shift+P custom proxy override (Horizon-style) */
    customProxy: {
      enabled: { type: Boolean, default: false },
      host: { type: String, default: '' },
      port: { type: Number, default: 0 },
      username: { type: String, default: '' },
      password: { type: String, default: '' }
    },
    note: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    anydeskid: { type: String, trim: true, default: '' },
    /** Single active desktop/admin login — new login replaces this and signs out other devices */
    activeSessionId: {
      type: String,
      default: null,
      index: true
    }
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashOnSave(next) {
  if (!this.isModified('password')) return next();
  this.password = await hashPassword(this.password);
  next();
});

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.activeSessionId;
  if (!obj.permissions) {
    obj.permissions = { ...DEFAULT_PERMISSIONS };
  }
  return obj;
};

module.exports = mongoose.model('User', userSchema);
