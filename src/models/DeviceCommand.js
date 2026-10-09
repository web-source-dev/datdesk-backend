const mongoose = require('mongoose');

/**
 * A command the admin queues for a specific user's Dat Desk device.
 * The desktop app claims pending commands on its heartbeat, executes them,
 * and posts the result back. Currently used for remote cookie pulls.
 */
const deviceCommandSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ['pull-cookies'],
      default: 'pull-cookies',
      index: true
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'error'],
      default: 'pending',
      index: true
    },
    /** Admin who requested the command */
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    requestedByEmail: { type: String, trim: true, lowercase: true, default: '' },
    /** Normalized cookie payload collected from the device (pull-cookies) */
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    cookieCount: { type: Number, default: 0 },
    /** Cookie document created from the pulled payload, if any */
    cookieId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cookie',
      default: null
    },
    error: { type: String, trim: true, default: '' },
    deliveredAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

deviceCommandSchema.index({ userId: 1, status: 1, createdAt: -1 });

deviceCommandSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    userId: this.userId ? String(this.userId) : null,
    type: this.type,
    status: this.status,
    cookieCount: this.cookieCount || 0,
    cookieId: this.cookieId ? String(this.cookieId) : null,
    hasResult: Boolean(this.result && this.result['dat.com']),
    error: this.error || '',
    requestedByEmail: this.requestedByEmail || '',
    deliveredAt: this.deliveredAt,
    completedAt: this.completedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('DeviceCommand', deviceCommandSchema);
