const mongoose = require('mongoose');

const CONFIG_KEY = 'extension-accounts';

const partnerSwiftConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: CONFIG_KEY
    },
    /** When true, only selectedCookieIds appear on the partner dashboard. */
    manualSelectionEnabled: {
      type: Boolean,
      default: false
    },
    /** Ordered cookie IDs shown as Account 1..N on the Swift partner dashboard. */
    selectedCookieIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cookie'
      }
    ],
    /** Parallel anchors (usually file:fd-container-X.json) — survives cookie _id recreate. */
    selectedSessionAnchors: [String]
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

const PartnerSwiftConfig = mongoose.model('PartnerSwiftConfig', partnerSwiftConfigSchema);

module.exports = {
  PartnerSwiftConfig,
  CONFIG_KEY
};
