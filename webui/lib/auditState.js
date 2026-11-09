"use strict";
const fs = require("fs");
const path = require("path");
const { dbPath } = require("./audit");

// Reads and writes the same file and JSON structure as cc_monitor/audit_state.py on the Python
// side. The hook reads it on every call to decide whether to actually evaluate/block this time;
// the REST endpoints here only give the Web UI a way to read and write the file, and the hook's
// interpretation of the state is authoritative.
function stateFile() {
  return path.join(path.dirname(dbPath()), "audit_state.json");
}

// Canonical values written to disk; must match audit_state.VALID_STATES on the Python side.
const VALID_STATES = ["running", "paused", "stopped"];

// Alias -> canonical value; keep in sync with audit_state.STATE_ALIASES on the Python side.
// permissive is the public name for the paused level (evaluates and records as usual, but does
// not block or show confirmation prompts), named after SELinux permissive / AppArmor complain.
// Disk still stores paused, so older versions and any script reading this file directly keep
// working after the rename.
const STATE_ALIASES = {
  permissive: "paused",
  observe: "paused",
  "log-only": "paused",
  log_only: "paused",
  enforcing: "running",
  enforce: "running",
  disabled: "stopped",
  off: "stopped",
};

function normalizeState(state) {
  if (typeof state !== "string") return null;
  const s = state.trim().toLowerCase();
  if (VALID_STATES.includes(s)) return s;
  return STATE_ALIASES[s] || null;
}

function getState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (VALID_STATES.includes(data.state)) return data;
  } catch (e) {
    // A missing or corrupt file counts as the default, running
  }
  return { state: "running", changedAt: null };
}

function setState(state) {
  const canonical = normalizeState(state);
  if (!canonical) {
    throw new Error(
      `state must be one of ${VALID_STATES.join("/")} (aliases ${Object.keys(STATE_ALIASES).join("/")} are also accepted)`
    );
  }
  const dir = path.dirname(stateFile());
  fs.mkdirSync(dir, { recursive: true });
  const data = { state: canonical, changedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(data));
  return data;
}

module.exports = { getState, setState, normalizeState, VALID_STATES, STATE_ALIASES };
