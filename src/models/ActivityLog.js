const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    actorEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      index: true
    },
    action: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    category: {
      type: String,
      enum: ['auth', 'email', 'admin', 'system', 'other'],
      default: 'other',
      index: true
    },
    status: {
      type: String,
      enum: ['success', 'failure', 'info'],
      default: 'success'
    },
    message: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    ip: {
      type: String,
      trim: true,
      default: ''
    },
    userAgent: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500
    }
  },
  { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });

activityLogSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    userId: this.userId ? String(this.userId) : null,
    actorEmail: this.actorEmail || '',
    action: this.action,
    category: this.category,
    status: this.status,
    message: this.message || '',
    meta: this.meta || null,
    ip: this.ip || '',
    userAgent: this.userAgent || '',
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('ActivityLog', activityLogSchema);
