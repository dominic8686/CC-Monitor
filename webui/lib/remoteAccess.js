"use strict";
const fs = require("fs");
const path = require("path");
const { dbPath } = require("./audit");

// Whether devices "other than this machine" may access this Web UI; off by default (only
// 127.0.0.1/::1 get in). Stored the same way as audit_state.json: a small JSON file whose current
// value the server reads on every request, so flipping the switch in the UI takes effect at once
// without restarting the process.
function stateFile() {
  return path.join(path.dirname(dbPath()), "remote_access_state.json");
}

function getState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (typeof data.allowRemote === "boolean") return data;
  } catch (e) {
    // A missing or corrupt file counts as the default: remote access not allowed
  }
  return { allowRemote: false, changedAt: null };
}

function setState(allowRemote) {
  const dir = path.dirname(stateFile());
  fs.mkdirSync(dir, { recursive: true });
  const data = { allowRemote: !!allowRemote, changedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(data));
  return data;
}

// Decide whether a request comes from "this machine": IPv4 127.0.0.1, IPv6 ::1, and the
// IPv4-mapped IPv6 form ::ffff:127.0.0.1 that Node commonly uses on dual-stack sockets all count.
function isLocalAddress(addr) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

module.exports = { getState, setState, isLocalAddress };
