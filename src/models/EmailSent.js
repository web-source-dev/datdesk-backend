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
    cc: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500
    },
    bcc: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500
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
    bodyHtml: {
      type: String,
      default: '',
      maxlength: 100000
    },
    attachments: {
      type: [
        {
          filename: { type: String, trim: true, maxlength: 200 },
          contentType: { type: String, trim: true, maxlength: 120 },
          size: { type: Number, default: 0 },
          content: { type: String }
        }
      ],
      default: []
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
    status: {
      type: String,
      enum: ['queued', 'sending', 'sent', 'failed'],
      default: 'sent',
      index: true
    },
    error: {
      type: String,
      default: '',
      maxlength: 1000
    },
    queuedAt: {
      type: Date,
      default: null
    },
    sentAt: {
      type: Date,
      default: null
    },
    vars: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  { timestamps: true }
);

emailSentSchema.index({ userId: 1, createdAt: -1 });
emailSentSchema.index({ accountId: 1, createdAt: -1 });
emailSentSchema.index({ from: 1, createdAt: -1 });
emailSentSchema.index({ status: 1, createdAt: 1 });

emailSentSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    userId: this.userId ? String(this.userId) : null,
    from: this.from,
    to: this.to,
    cc: this.cc || '',
    bcc: this.bcc || '',
    subject: this.subject,
    body: this.body,
    bodyHtml: this.bodyHtml || '',
    attachments: (this.attachments || []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size || 0
    })),
    method: this.method,
    messageId: this.messageId || '',
    status: this.status || 'sent',
    error: this.error || '',
    queuedAt: this.queuedAt || null,
    sentAt: this.sentAt || this.createdAt || null,
    templateId: this.templateId ? String(this.templateId) : null,
    accountId: this.accountId ? String(this.accountId) : null,
    vars: this.vars || null,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('EmailSent', emailSentSchema);
