'use strict';

/**
 * FreightDesk import-all jobs (Mongo-backed so status works across PM2 workers).
 */

const crypto = require('crypto');
const FreightdeskImportJob = require('../models/FreightdeskImportJob');
const freightdeskImportService = require('./freightdeskImportService');

const JOB_TTL_MS = 6 * 60 * 60 * 1000;

function publicJob(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: obj._id,
    status: obj.status,
    startedAt: obj.startedAt,
    finishedAt: obj.finishedAt,
    progress: obj.progress || { imported: 0, failed: 0, total: null },
    result: obj.result,
    error: obj.error,
    message: obj.message
  };
}

async function getJob(jobId) {
  if (!jobId) return null;
  return FreightdeskImportJob.findById(String(jobId)).lean();
}

async function getActiveJob() {
  return FreightdeskImportJob.findOne({ status: 'running' }).sort({ startedAt: -1 }).lean();
}

async function patchJob(jobId, update) {
  return FreightdeskImportJob.findByIdAndUpdate(
    String(jobId),
    { $set: update },
    { new: true }
  ).lean();
}

async function startImportAllJob(options = {}) {
  const existing = await getActiveJob();
  if (existing) {
    const err = new Error('An import-all job is already running.');
    err.status = 409;
    err.jobId = existing._id;
    throw err;
  }

  const id = crypto.randomUUID();
  const job = await FreightdeskImportJob.create({
    _id: id,
    status: 'running',
    startedAt: new Date(),
    options: {
      activate: Boolean(options.activate),
      channel: options.channel || 'single',
      forceReimport: options.forceReimport !== false
    },
    progress: { imported: 0, failed: 0, total: null, current: null, phase: 'starting' },
    message: 'Import started…'
  });

  // Best-effort cleanup of old finished jobs
  setTimeout(() => {
    FreightdeskImportJob.deleteMany({
      status: { $ne: 'running' },
      finishedAt: { $lt: new Date(Date.now() - JOB_TTL_MS) }
    }).catch(() => {});
  }, 1000);

  setImmediate(() => {
    runJob(id).catch((err) => {
      console.error('[FreightDesk] import job failed:', err);
    });
  });

  return publicJob(job);
}

async function runJob(jobId) {
  try {
    const result = await freightdeskImportService.importAllContainers({
      ...(
        (await FreightdeskImportJob.findById(jobId).lean())?.options || {}
      ),
      onProgress: async (progress) => {
        const imported = progress.imported || 0;
        const failed = progress.failed || 0;
        const total = progress.total;
        const current = progress.current || null;
        const phase = progress.phase || 'importing';
        const done = imported + failed;
        const message =
          total != null
            ? `Importing ${done}/${total}${current ? ` · ${current}` : ''}…`
            : `Importing${current ? ` · ${current}` : ''}…`;

        await patchJob(jobId, {
          progress: { imported, failed, total, current, phase },
          message
        });
      }
    });

    if (result.skipped) {
      await patchJob(jobId, {
        status: 'error',
        error: result.reason || 'Import skipped',
        message: result.reason || 'Import skipped',
        finishedAt: new Date()
      });
      return;
    }

    const message =
      `Imported ${result.imported} container(s)` +
      (result.failed ? `, ${result.failed} failed` : '');

    await patchJob(jobId, {
      status: 'done',
      result,
      progress: {
        imported: result.imported || 0,
        failed: result.failed || 0,
        total: result.total || null,
        current: null,
        phase: 'done'
      },
      message,
      finishedAt: new Date()
    });
  } catch (err) {
    await patchJob(jobId, {
      status: 'error',
      error: err.message || 'Import failed',
      message: err.message || 'Import failed',
      finishedAt: new Date()
    });
  }
}

module.exports = {
  startImportAllJob,
  getJob,
  getActiveJob,
  publicJob
};
