const mongoose = require('mongoose');

/**
 * Synced mailbox history (Gmail lifetime fetch / provider inbox+sent).
 * Distinct from EmailSent, which only tracks mail sent through Dat Desk.
 */
const mailboxMessageSchema = new mongoose.Schema(
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
      required: true,
      index: true
    },
    provider: {
      type: String,
      enum: ['gmail', 'imap', 'unknown'],
      default: 'gmail'
    },
    providerMessageId: {
      type: String,
      required: true,
      trim: true
    },
    threadId: {
      type: String,
      trim: true,
      default: ''
    },
    labelIds: {
      type: [String],
      default: []
    },
    direction: {
      type: String,
      enum: ['inbound', 'outbound', 'unknown'],
      default: 'unknown',
      index: true
    },
    from: { type: String, trim: true, default: '', lowercase: true },
    to: { type: String, trim: true, default: '', lowercase: true },
    cc: { type: String, trim: true, default: '' },
    subject: { type: String, trim: true, default: '', maxlength: 1000 },
    snippet: { type: String, trim: true, default: '', maxlength: 2000 },
    body: { type: String, default: '', maxlength: 200000 },
    bodyHtml: { type: String, default: '', maxlength: 200000 },
    internalDate: { type: Date, default: null, index: true },
    syncedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

mailboxMessageSchema.index({ accountId: 1, providerMessageId: 1 }, { unique: true });
mailboxMessageSchema.index({ accountId: 1, internalDate: -1 });
mailboxMessageSchema.index({ userId: 1, internalDate: -1 });

mailboxMessageSchema.methods.toSafeJSON = function toSafeJSON(includeBody = false) {
  const base = {
    id: String(this._id),
    userId: String(this.userId),
    accountId: String(this.accountId),
    provider: this.provider,
    providerMessageId: this.providerMessageId,
    threadId: this.threadId || '',
    labelIds: this.labelIds || [],
    direction: this.direction,
    from: this.from || '',
    to: this.to || '',
    cc: this.cc || '',
    subject: this.subject || '',
    snippet: this.snippet || '',
    internalDate: this.internalDate,
    syncedAt: this.syncedAt,
    createdAt: this.createdAt
  };
  if (includeBody) {
    base.body = this.body || '';
    base.bodyHtml = this.bodyHtml || '';
  }
  return base;
};

module.exports = mongoose.model('MailboxMessage', mailboxMessageSchema);
