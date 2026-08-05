const mongoose = require('mongoose');

/**
 * Per-app auto-update switch. One document per app slug (e.g. datdesk).
 * When updatesEnabled is false, the update feed reports version 0.0.0 so
 * clients stay on their current build.
 */
const appUpdateSettingSchema = new mongoose.Schema(
  {
    app: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    updatesEnabled: {
      type: Boolean,
      default: true
    }
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

module.exports = mongoose.model('AppUpdateSetting', appUpdateSettingSchema);
