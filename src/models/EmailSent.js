const mongoose = require('mongoose');

const emailSentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailAccount',
      default: null
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailTemplate',
      default: null
    },
    from: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    to: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500
    },
    body: {
      type: String,
      required: true,
      maxlength: 50000
    },
    method: {
      type: String,
      enum: ['app_password', 'oauth', 'smtp', 'unknown'],
      default: 'unknown'
    },
    messageId: {
      type: String,
      default: ''
    },
    vars: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  { timestamps: true }
);

emailSentSchema.index({ userId: 1, createdAt: -1 });

emailSentSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    from: this.from,
    to: this.to,
    subject: this.subject,
    body: this.body,
    method: this.method,
    messageId: this.messageId || '',
    templateId: this.templateId ? String(this.templateId) : null,
    accountId: this.accountId ? String(this.accountId) : null,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('EmailSent', emailSentSchema);
