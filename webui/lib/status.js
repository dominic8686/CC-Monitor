"use strict";
// Lightweight data source for the Status page. It does not try to match ccstatusline exactly
// (that computes tokens/cost from transcript metadata fed by Claude Code itself, which hooks
// cannot see); it only summarises what we can actually get: cwd, git branch / uncommitted
// changes, active duration, audit event counts.
const { execFileSync } = require("child_process");

function git(cwd, args) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      timeout: 800,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim();
  } catch (e) {
    return null;
  }
}

function gitInfo(cwd) {
  if (!cwd) return { branch: null, dirty: null };
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return { branch: null, dirty: null };
  const status = git(cwd, ["status", "--porcelain"]);
  return { branch, dirty: status === null ? null : status.length > 0 };
}

module.exports = { gitInfo };
