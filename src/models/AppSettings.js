const mongoose = require('mongoose');

const appSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: 'app' },
    /** When true, users without a personal proxyId use globalProxyId */
    globalProxyEnabled: { type: Boolean, default: false },
    globalProxyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Proxy',
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppSettings', appSettingsSchema);
