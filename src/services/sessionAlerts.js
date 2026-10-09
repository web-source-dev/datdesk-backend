'use strict';

/**
 * In-memory tracker for DAT session-death reports from desktop clients.
 *
 * Each desktop app POSTs to /presence/report-dead when its DAT session was kicked to the
 * login page (a logout). We keep the recent reports per cookie/account and raise an alert
 * when enough DISTINCT users report the same cookie dead inside a short window — the signal
 * that an account has actually died (not one flaky PC), so an admin can switch it.
 *
 * Deliberately in-memory: these are transient operational signals, not records to persist.
 */

const WINDOW_MS = 10 * 60 * 1000; // consider reports from the last 10 minutes
const ALERT_THRESHOLD = 3; // > 3 distinct users → alert (i.e. 4+). Tune via config if needed.

/** cookieId -> Map<userId, { at, fileName }> */
const reports = new Map();

function prune(now = Date.now()) {
  for (const [cookieId, users] of reports) {
    for (const [userId, rec] of users) {
      if (now - rec.at > WINDOW_MS) users.delete(userId);
    }
    if (users.size === 0) reports.delete(cookieId);
  }
}

/**
 * Record one session-death report.
 * @returns {{count:number, alert:boolean}} distinct users in-window and whether it alerts.
 */
function reportDead({ cookieId, userId, fileName }) {
  const key = String(cookieId || '').trim();
  const uid = String(userId || '').trim();
  if (!key || !uid) return { count: 0, alert: false };
  const now = Date.now();
  prune(now);
  if (!reports.has(key)) reports.set(key, new Map());
  reports.get(key).set(uid, { at: now, fileName: fileName || '' });
  const count = reports.get(key).size;
  return { count, alert: count > ALERT_THRESHOLD };
}

/**
 * Current alerts: cookies with more than ALERT_THRESHOLD distinct users reporting death
 * in the window. Returns [{ cookieId, fileName, deadUsers, since }].
 */
function currentAlerts() {
  prune();
  const out = [];
  for (const [cookieId, users] of reports) {
    if (users.size > ALERT_THRESHOLD) {
      let fileName = '';
      let since = Date.now();
      for (const rec of users.values()) {
        if (rec.fileName) fileName = rec.fileName;
        if (rec.at < since) since = rec.at;
      }
      out.push({ cookieId, fileName, deadUsers: users.size, since: new Date(since).toISOString() });
    }
  }
  return out.sort((a, b) => b.deadUsers - a.deadUsers);
}

/** Distinct dead-report users in-window for one cookie (0 if none). */
function deadCountFor(cookieId) {
  prune();
  const users = reports.get(String(cookieId || ''));
  return users ? users.size : 0;
}

/** Clear reports for a cookie (e.g. after an admin switches/reactivates it). */
function clear(cookieId) {
  reports.delete(String(cookieId || ''));
}

module.exports = {
  reportDead,
  currentAlerts,
  deadCountFor,
  clear,
  WINDOW_MS,
  ALERT_THRESHOLD
};
