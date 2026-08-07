const mongoose = require('mongoose');

const emailAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
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
      enum: ['app_password', 'oauth'],
      required: true
    },
    /** Encrypted Gmail app password (app_password method) */
    appPasswordEnc: { type: String, default: '', select: false },
    /** Encrypted OAuth refresh token */
    refreshTokenEnc: { type: String, default: '', select: false },
    accessTokenEnc: { type: String, default: '', select: false },
    accessTokenExpiresAt: { type: Date, default: null },
    displayName: { type: String, trim: true, default: '' },
    connectedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

emailAccountSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    email: this.email,
    method: this.method,
    displayName: this.displayName || '',
    connectedAt: this.connectedAt,
    connected: true
  };
};

module.exports = mongoose.model('EmailAccount', emailAccountSchema);
