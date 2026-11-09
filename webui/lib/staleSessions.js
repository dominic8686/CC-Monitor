"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");

const RECENT_MS = 15 * 60 * 1000; // a transcript written within 15 minutes counts as "recently active"

function claudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

// Scan ~/.claude/projects/*/*.jsonl (not the subagents/ subdirectories, which are subagents' own
// records and do not represent an independent Claude Code session) for recently written
// transcript files.
function findRecentTranscripts(withinMs) {
  const dir = claudeProjectsDir();
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const results = [];
  for (const projDir of fs.readdirSync(dir)) {
    const full = path.join(dir, projDir);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(full, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch (e) {
        continue;
      }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs <= withinMs) {
        results.push({ sessionId: f.replace(/\.jsonl$/, ""), transcriptPath: fp, mtimeMs: st.mtimeMs });
      }
    }
  }
  return results;
}

// Find sessions whose "transcript was written recently (so this Claude Code session is in use)
// but the audit database has not a single event for it". This is not a counting error: Claude
// Code loads its hooks configuration only once, when the session starts, and never hot-reloads
// it. Such a session was most likely started before the CC-Monitor code / hooks configuration was
// updated and still uses the old configuration from its start. We cannot force it to reload from
// outside; the only way is to quit and reopen that session (run claude / claude --resume again).
function findUnmonitoredActiveSessions() {
  const recent = findRecentTranscripts(RECENT_MS);
  if (recent.length === 0) return [];
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    const known = new Set(
      db
        .prepare(`SELECT DISTINCT session_id FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
        .all()
        .map((r) => r.session_id)
    );
    return recent
      .filter((r) => !known.has(r.sessionId))
      .map((r) => ({
        sessionId: r.sessionId,
        transcriptPath: r.transcriptPath,
        lastActivity: new Date(r.mtimeMs).toISOString(),
      }))
      .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  } catch (e) {
    return [];
  } finally {
    if (db) db.close();
  }
}

module.exports = { findUnmonitoredActiveSessions };
