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
    threadId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    conversationKey: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    rootSubject: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500
    },
    replyToEmailSentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailSent',
      default: null
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
emailSentSchema.index({ userId: 1, accountId: 1, conversationKey: 1 });
emailSentSchema.index({ accountId: 1, conversationKey: 1, sentAt: -1 });
emailSentSchema.index({ from: 1, createdAt: -1 });
emailSentSchema.index({ status: 1, createdAt: 1 });

emailSentSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    userId: this.userId ? String(this.userId) : null,
    from: this.from,
    to: this.to,
    subject: this.subject,
    body: this.body,
    method: this.method,
    messageId: this.messageId || '',
    threadId: this.threadId || '',
    conversationKey: this.conversationKey || '',
    rootSubject: this.rootSubject || '',
    replyToEmailSentId: this.replyToEmailSentId ? String(this.replyToEmailSentId) : null,
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
