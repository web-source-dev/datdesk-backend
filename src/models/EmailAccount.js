const mongoose = require('mongoose');

const emailAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    method: {
      type: String,
      enum: ['app_password', 'oauth', 'smtp'],
      required: true
    },
    /** Encrypted password / app password */
    appPasswordEnc: { type: String, default: '', select: false },
    /** Encrypted OAuth refresh token */
    refreshTokenEnc: { type: String, default: '', select: false },
    accessTokenEnc: { type: String, default: '', select: false },
    accessTokenExpiresAt: { type: Date, default: null },
    displayName: { type: String, trim: true, default: '' },
    /** Custom SMTP (method === 'smtp') */
    smtpHost: { type: String, trim: true, default: '' },
    smtpPort: { type: Number, default: 587 },
    smtpSecure: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
    connectedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

emailAccountSchema.index({ userId: 1, email: 1 }, { unique: true });

emailAccountSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    email: this.email,
    method: this.method,
    displayName: this.displayName || '',
    smtpHost: this.method === 'smtp' ? this.smtpHost || '' : undefined,
    smtpPort: this.method === 'smtp' ? this.smtpPort : undefined,
    smtpSecure: this.method === 'smtp' ? Boolean(this.smtpSecure) : undefined,
    isDefault: Boolean(this.isDefault),
    connectedAt: this.connectedAt,
    connected: true
  };
};

module.exports = mongoose.model('EmailAccount', emailAccountSchema);

// Drop legacy single-account unique index (userId unique) if present
try {
  const Model = module.exports;
  Model.collection
    .dropIndex('userId_1')
    .catch(() => {})
    .finally(() => {
      Model.syncIndexes().catch(() => {});
    });
} catch {
  // ignore before mongoose connected
}
