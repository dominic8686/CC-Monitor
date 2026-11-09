"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");

// What archiving does: make a full copy of the "current" events.db into archives/ with SQLite's
// official backup API (backup() handles the WAL checkpoint internally, so data not yet on disk
// is not lost and the hooks that are writing need not stop), then count the events / sessions /
// time range in the snapshot and write a .json metadata file of the same name, so the archive
// history list can read it directly without opening the db file every time.
function archivesDir() {
  return path.join(path.dirname(dbPath()), "archives");
}

function statsFromDb(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const sessionCount = db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
      .get().n;
    const range = db.prepare(`SELECT MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM events`).get();
    return { total, sessionCount, firstTs: range.firstTs || null, lastTs: range.lastTs || null };
  } finally {
    db.close();
  }
}

async function createArchive(label) {
  const src = dbPath();
  if (!fs.existsSync(src)) {
    return { ok: false, error: "No event data yet, nothing to archive" };
  }
  const dir = archivesDir();
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}.db`;
  const destFile = path.join(dir, fileName);

  const srcDb = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await srcDb.backup(destFile);
  } finally {
    srcDb.close();
  }

  // The backup inherits the source database's WAL journal mode and carries -wal/-shm side files.
  // An archive is a snapshot that is never written again, so WAL is pointless; switching to the
  // normal journal mode makes it a single self-contained .db file, and deleting the archive later
  // need not worry about leftover side files.
  const convertDb = new Database(destFile);
  try {
    convertDb.pragma("journal_mode = DELETE");
  } finally {
    convertDb.close();
  }

  const stats = statsFromDb(destFile);
  if (stats.total === 0) {
    // No data: do not keep an empty archive; remove the empty file just backed up as well.
    fs.unlinkSync(destFile);
    return { ok: false, error: "No event data, nothing to archive" };
  }

  const meta = {
    id: stamp,
    label: label || "",
    file: fileName,
    createdAt: ts.toISOString(),
    ...stats,
  };
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(meta, null, 2));
  return { ok: true, archive: meta };
}

function listArchives() {
  const dir = archivesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function deleteArchive(id) {
  const dir = archivesDir();
  const meta = listArchives().find((a) => a.id === id);
  if (!meta) return { ok: false, error: "Archive not found" };
  for (const f of [meta.file, `${meta.file}-wal`, `${meta.file}-shm`, `${id}.json`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { ok: true };
}

// Open one history archive and page through its events. Read-only, never touches the current
// events.db. Supports incremental paging with sinceId, so for large archives the frontend can do
// "Load more" instead of reading everything at once.
function getArchiveEvents(id, { sinceId = 0, limit = 500 } = {}) {
  const dir = archivesDir();
  const meta = listArchives().find((a) => a.id === id);
  if (!meta) return null;
  const file = path.join(dir, meta.file);
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id, ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail
         FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(sinceId, limit);
  } finally {
    db.close();
  }
}

// Clear the "current" event data: not an archive, it really discards it. Uses a writable
// connection to the same events.db; after DELETE the AUTOINCREMENT counter is reset too, so new
// event ids start from 1 again and Home / the log page look cleaner instead of suddenly jumping
// from a large id.
function clearCurrentEvents() {
  const src = dbPath();
  if (!fs.existsSync(src)) return { ok: true, deletedCount: 0 };
  const db = new Database(src, { fileMustExist: true, timeout: 5000 });
  try {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    db.exec(`DELETE FROM events;`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name = 'events';`);
    return { ok: true, deletedCount: before };
  } finally {
    db.close();
  }
}

module.exports = { archivesDir, createArchive, listArchives, deleteArchive, clearCurrentEvents, getArchiveEvents };
