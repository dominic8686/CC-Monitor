"use strict";
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");

// An action=confirm operation keeps waiting on the hook side (cc_monitor/notify.py), with two
// paths open at once: press y/N in the terminal that triggered it, or click on the pending
// approval page here. This module only reads/writes that same pending_approvals table, and is
// not readonly (unlike the connection the audit.js queries use, this one writes).
function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { fileMustExist: true, timeout: 5000 });
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

function listPending() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, tool_name, cwd, matched_rule, matched_value, risk, status, kind
         FROM pending_approvals WHERE status = 'pending' ORDER BY id ASC`
      )
      .all();
  }, []);
}

// History: once status changes from 'pending' to something else the row is not deleted (nothing
// ever runs DELETE on pending_approvals, including the Home "Clear current data" button, which
// only clears the events table), so querying every non-pending row here gives the complete
// history, kept long term by design.
function listHistory(limit = 200) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, tool_name, cwd, matched_rule, matched_value, risk, status, kind, resolved_at, resolved_via, resolved_value
         FROM pending_approvals WHERE status != 'pending' ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

const DECISION_TO_STATUS = {
  allow: "allowed",
  deny: "denied",
  always_allow: "always_allowed",
  allow_10m: "allowed_10m",
  allow_30m: "allowed_30m",
};

// Same table and same "first writer wins" rule as resolve_approval() in cc_monitor/storage.py:
// WHERE status='pending' ensures it never fights a y/N answered in the terminal at the same moment.
function resolve(id, decision) {
  const status = DECISION_TO_STATUS[decision];
  if (!status) return { ok: false, error: "decision must be one of allow / deny / always_allow / allow_10m / allow_30m" };
  return withDb((db) => {
    const info = db
      .prepare(`UPDATE pending_approvals SET status = ?, resolved_at = ?, resolved_via = 'web' WHERE id = ? AND status = 'pending'`)
      .run(status, new Date().toISOString(), id);
    if (info.changes === 0) return { ok: false, error: "This request has already been handled (perhaps answered in the terminal that triggered it)" };
    return { ok: true, status };
  }, { ok: false, error: "Database is not writable" });
}

module.exports = { listPending, resolve, listHistory };
