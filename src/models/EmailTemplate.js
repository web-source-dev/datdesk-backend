const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300
    },
    body: {
      type: String,
      required: true,
      maxlength: 20000
    },
    isDefault: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

emailTemplateSchema.index({ userId: 1, name: 1 }, { unique: true });

emailTemplateSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    name: this.name,
    subject: this.subject,
    body: this.body,
    isDefault: Boolean(this.isDefault),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
