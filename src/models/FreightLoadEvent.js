const mongoose = require('mongoose');

const freightLoadEventSchema = new mongoose.Schema(
  {
    loadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FreightLoad',
      required: true,
      index: true
    },
    status: {
      type: String,
      required: true,
      index: true
    },
    previousStatus: {
      type: String,
      default: null
    },
    source: {
      type: String,
      enum: ['email', 'rule', 'ai', 'manual', 'system'],
      default: 'rule'
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MailboxMessage',
      default: null
    },
    employeeUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    title: { type: String, trim: true, default: '', maxlength: 300 },
    note: { type: String, trim: true, default: '', maxlength: 2000 },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    signals: { type: [String], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    occurredAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

freightLoadEventSchema.index({ loadId: 1, occurredAt: -1 });

freightLoadEventSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    loadId: String(this.loadId),
    status: this.status,
    previousStatus: this.previousStatus,
    source: this.source,
    messageId: this.messageId ? String(this.messageId) : null,
    employeeUserId: this.employeeUserId ? String(this.employeeUserId) : null,
    title: this.title || '',
    note: this.note || '',
    confidence: this.confidence || 0,
    signals: this.signals || [],
    meta: this.meta || null,
    occurredAt: this.occurredAt,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('FreightLoadEvent', freightLoadEventSchema);
