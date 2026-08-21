const mongoose = require('mongoose');

/**
 * Chromium extension packages delivered to the desktop client.
 * Admin uploads a ZIP of an unpacked extension; Electron downloads,
 * extracts, and loads via session.loadExtension().
 */
const managedExtensionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    version: { type: String, required: true, trim: true, default: '1.0.0' },
    description: { type: String, trim: true, default: '' },
    fileName: { type: String, required: true },
    originalFileName: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },
    /** GridFS id in bucket `extensionPackages` — shared across all API hosts */
    gridFsId: { type: mongoose.Schema.Types.ObjectId, default: null },
    contentHash: { type: String, default: '', index: true },
    enabled: { type: Boolean, default: true, index: true },
    extensionId: { type: String, default: null }
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
        return ret;
      }
    }
  }
);

module.exports = mongoose.model('ManagedExtension', managedExtensionSchema);
