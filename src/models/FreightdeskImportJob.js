'use strict';

const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema(
  {
    imported: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    total: { type: Number, default: null },
    current: { type: String, default: null },
    phase: { type: String, default: 'starting' }
  },
  { _id: false }
);

const freightdeskImportJobSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    status: {
      type: String,
      enum: ['running', 'done', 'error'],
      default: 'running',
      index: true
    },
    options: {
      activate: { type: Boolean, default: false },
      channel: { type: String, default: 'single' },
      forceReimport: { type: Boolean, default: true }
    },
    progress: { type: progressSchema, default: () => ({}) },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    message: { type: String, default: 'Import started' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports =
  mongoose.models.FreightdeskImportJob ||
  mongoose.model('FreightdeskImportJob', freightdeskImportJobSchema);
