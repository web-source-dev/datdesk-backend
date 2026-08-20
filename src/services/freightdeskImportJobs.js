'use strict';

/**
 * In-memory FreightDesk import-all jobs.
 * Long sync imports often hit reverse-proxy timeouts; the browser then
 * reports a false CORS error because the gateway 502/504 has no ACAO header.
 */

const crypto = require('crypto');
const freightdeskImportService = require('./freightdeskImportService');

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
let activeJobId = null;

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
    message: job.message
  };
}

function getJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

function getActiveJob() {
  if (!activeJobId) return null;
  const job = jobs.get(activeJobId);
  if (!job || job.status !== 'running') {
    activeJobId = null;
    return null;
  }
  return job;
}

function startImportAllJob(options = {}) {
  const existing = getActiveJob();
  if (existing) {
    const err = new Error('An import-all job is already running.');
    err.status = 409;
    err.jobId = existing.id;
    throw err;
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    options: {
      activate: Boolean(options.activate),
      channel: options.channel || 'single',
      forceReimport: options.forceReimport !== false
    },
    progress: { imported: 0, failed: 0, total: null },
    result: null,
    error: null,
    message: 'Import started'
  };

  jobs.set(id, job);
  activeJobId = id;

  setTimeout(() => {
    const current = jobs.get(id);
    if (current && current.status !== 'running') jobs.delete(id);
  }, JOB_TTL_MS);

  setImmediate(() => {
    runJob(job).catch((err) => {
      console.error('[FreightDesk] import job failed:', err);
    });
  });

  return publicJob(job);
}

async function runJob(job) {
  try {
    const result = await freightdeskImportService.importAllContainers(job.options);

    if (result.skipped) {
      job.status = 'error';
      job.error = result.reason || 'Import skipped';
      job.message = result.reason;
      job.finishedAt = new Date().toISOString();
      if (activeJobId === job.id) activeJobId = null;
      return;
    }

    job.status = 'done';
    job.result = result;
    job.progress = {
      imported: result.imported || 0,
      failed: result.failed || 0,
      total: result.total || null
    };
    job.message =
      result.message ||
      `Imported ${result.imported} container(s)${result.failed ? `, ${result.failed} failed` : ''}`;
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    job.status = 'error';
    job.error = err.message || 'Import failed';
    job.message = job.error;
    job.finishedAt = new Date().toISOString();
  } finally {
    if (activeJobId === job.id) activeJobId = null;
  }
}

module.exports = {
  startImportAllJob,
  getJob,
  getActiveJob,
  publicJob
};
