const mongoose = require('mongoose');

/**
 * Tracks continuous sync progress per connected email account.
 */
const emailSyncStateSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailAccount',
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    enabled: { type: Boolean, default: true },
    lastSyncAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 2000 },
    lastFetched: { type: Number, default: 0 },
    lastUpserted: { type: Number, default: 0 },
    lastProcessed: { type: Number, default: 0 },
    gmailPageToken: { type: String, default: '' },
    imapPageToken: { type: String, default: '' },
    totalFetched: { type: Number, default: 0 },
    totalProcessed: { type: Number, default: 0 },
    consecutiveFailures: { type: Number, default: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

emailSyncStateSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    accountId: String(this.accountId),
    userId: String(this.userId),
    enabled: this.enabled !== false,
    lastSyncAt: this.lastSyncAt,
    lastSuccessAt: this.lastSuccessAt,
    lastErrorAt: this.lastErrorAt,
    lastError: this.lastError || '',
    lastFetched: this.lastFetched || 0,
    lastUpserted: this.lastUpserted || 0,
    lastProcessed: this.lastProcessed || 0,
    totalFetched: this.totalFetched || 0,
    totalProcessed: this.totalProcessed || 0,
    consecutiveFailures: this.consecutiveFailures || 0,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('EmailSyncState', emailSyncStateSchema);
