const mongoose = require('mongoose');

const PARTY_TYPES = ['broker', 'carrier', 'shipper', 'driver', 'dispatcher', 'internal', 'unknown'];

const freightContactSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true
    },
    domain: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      index: true
    },
    companyName: { type: String, trim: true, default: '' },
    contactName: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    partyType: {
      type: String,
      enum: PARTY_TYPES,
      default: 'unknown',
      index: true
    },
    /** Manual override wins over auto classification when set */
    partyTypeOverride: {
      type: String,
      enum: PARTY_TYPES,
      default: undefined
    },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    emailCount: { type: Number, default: 0 },
    brokerSignals: { type: Number, default: 0 },
    carrierSignals: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: null },
    notes: { type: String, trim: true, default: '', maxlength: 2000 },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

freightContactSchema.virtual('effectiveType').get(function effectiveType() {
  return this.partyTypeOverride || this.partyType || 'unknown';
});

freightContactSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    email: this.email,
    domain: this.domain || '',
    companyName: this.companyName || '',
    contactName: this.contactName || '',
    phone: this.phone || '',
    partyType: this.partyTypeOverride || this.partyType || 'unknown',
    partyTypeAuto: this.partyType || 'unknown',
    partyTypeOverride: this.partyTypeOverride || null,
    confidence: this.confidence || 0,
    emailCount: this.emailCount || 0,
    brokerSignals: this.brokerSignals || 0,
    carrierSignals: this.carrierSignals || 0,
    lastSeenAt: this.lastSeenAt,
    notes: this.notes || '',
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('FreightContact', freightContactSchema);
module.exports.PARTY_TYPES = PARTY_TYPES;
