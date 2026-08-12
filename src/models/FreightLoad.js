const mongoose = require('mongoose');

const LOAD_STATUSES = [
  'open',
  'inquiry',
  'negotiating',
  'booked',
  'confirmed',
  'picked_up',
  'in_transit',
  'delivered',
  'lost',
  'cancelled',
  'unknown'
];

const placeSchema = new mongoose.Schema(
  {
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, uppercase: true, default: '' },
    zip: { type: String, trim: true, default: '' },
    raw: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const freightLoadSchema = new mongoose.Schema(
  {
    /** Primary load / reference / PO / PRO number when known */
    loadNumber: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    /** Deterministic match key used when load number missing (route+date+broker) */
    matchKey: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    status: {
      type: String,
      enum: LOAD_STATUSES,
      default: 'open',
      index: true
    },
    statusConfidence: { type: Number, default: 0, min: 0, max: 1 },
    pickup: { type: placeSchema, default: () => ({}) },
    delivery: { type: placeSchema, default: () => ({}) },
    pickupDate: { type: Date, default: null },
    deliveryDate: { type: Date, default: null },
    equipment: { type: String, trim: true, default: '' },
    weight: { type: String, trim: true, default: '' },
    miles: { type: Number, default: null },
    rate: { type: Number, default: null },
    rateCurrency: { type: String, default: 'USD' },
    brokerContactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FreightContact',
      default: null,
      index: true
    },
    carrierContactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FreightContact',
      default: null,
      index: true
    },
    brokerEmail: { type: String, trim: true, lowercase: true, default: '' },
    carrierEmail: { type: String, trim: true, lowercase: true, default: '' },
    brokerName: { type: String, trim: true, default: '' },
    carrierName: { type: String, trim: true, default: '' },
    /** Desk users / employee Gmail owners who touched this load */
    employeeUserIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ],
    employeeEmails: [{ type: String, trim: true, lowercase: true }],
    mailboxMessageIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MailboxMessage'
      }
    ],
    threadIds: [{ type: String, trim: true }],
    accountIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmailAccount'
      }
    ],
    subjectSample: { type: String, trim: true, default: '', maxlength: 500 },
    lastEmailAt: { type: Date, default: null, index: true },
    firstEmailAt: { type: Date, default: null },
    emailCount: { type: Number, default: 0 },
    extractionConfidence: { type: Number, default: 0, min: 0, max: 1 },
    lastEventAt: { type: Date, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

freightLoadSchema.index({ status: 1, lastEmailAt: -1 });
freightLoadSchema.index({ brokerEmail: 1, lastEmailAt: -1 });
freightLoadSchema.index({ carrierEmail: 1, lastEmailAt: -1 });
freightLoadSchema.index({ 'pickup.city': 1, 'delivery.city': 1 });

freightLoadSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    loadNumber: this.loadNumber || '',
    matchKey: this.matchKey,
    status: this.status,
    statusConfidence: this.statusConfidence || 0,
    pickup: this.pickup || {},
    delivery: this.delivery || {},
    pickupDate: this.pickupDate,
    deliveryDate: this.deliveryDate,
    equipment: this.equipment || '',
    weight: this.weight || '',
    miles: this.miles,
    rate: this.rate,
    rateCurrency: this.rateCurrency || 'USD',
    brokerContactId: this.brokerContactId ? String(this.brokerContactId) : null,
    carrierContactId: this.carrierContactId ? String(this.carrierContactId) : null,
    brokerEmail: this.brokerEmail || '',
    carrierEmail: this.carrierEmail || '',
    brokerName: this.brokerName || '',
    carrierName: this.carrierName || '',
    employeeUserIds: (this.employeeUserIds || []).map((id) => String(id)),
    employeeEmails: this.employeeEmails || [],
    mailboxMessageIds: (this.mailboxMessageIds || []).map((id) => String(id)),
    threadIds: this.threadIds || [],
    accountIds: (this.accountIds || []).map((id) => String(id)),
    subjectSample: this.subjectSample || '',
    lastEmailAt: this.lastEmailAt,
    firstEmailAt: this.firstEmailAt,
    emailCount: this.emailCount || 0,
    extractionConfidence: this.extractionConfidence || 0,
    lastEventAt: this.lastEventAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
    routeLabel: formatRoute(this.pickup, this.delivery)
  };
};

function formatRoute(pickup, delivery) {
  const p = [pickup?.city, pickup?.state].filter(Boolean).join(', ');
  const d = [delivery?.city, delivery?.state].filter(Boolean).join(', ');
  if (p && d) return `${p} → ${d}`;
  return p || d || '';
}

module.exports = mongoose.model('FreightLoad', freightLoadSchema);
module.exports.LOAD_STATUSES = LOAD_STATUSES;
module.exports.formatRoute = formatRoute;
