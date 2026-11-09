"use strict";
// Detects which OS user each running claude process on the machine runs as. This is the lesson from debugging
// "the terminal app's prompts cannot be detected": if the Web UI and the terminal where you usually run claude
// are different OS users, each writes its own ~/.cc-monitor/ database, neither sees the other, and nothing says
// so; you only find out by reading /proc/<pid>/environ by hand. This module only detects and shows it; it does
// not merge data across users. Merging would mean reading other users' home directories, which is harder for
// permissions and privacy, so first make the invisible problem visible.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");

// `-A` (select all processes) and `args` (full command line) are both defined in POSIX ps(1), so GNU ps (Linux)
// and BSD ps (macOS) both accept them. We avoid GNU-only `-e` and BSD-only forms so one command works on both.
// The `=` after each field stops ps printing a header, so parsing need not skip the first line.
// etime (elapsed time) and rss (resident memory, KB) are also POSIX ps(1) fields supported by both GNU and BSD.
// We avoid the GNU-only etimes (seconds) so it runs on macOS too; the cost is parsing the etime format ourselves
// (see parseEtime). args must stay last, because it contains spaces and can only be split off as "everything
// that remains".
function psSnapshot() {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,uid=,user=,etime=,rss=,args="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split("\n"));
    });
  });
}

// etime has the format [[DD-]HH:]MM:SS; convert it to seconds. Anything unrecognised returns null and the front
// end shows "-" as is, rather than guessing a number.
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((s || "").trim());
  if (!m) return null;
  const [, d, h, mi, sec] = m;
  return (parseInt(d || "0", 10) * 86400) + (parseInt(h || "0", 10) * 3600) + (parseInt(mi, 10) * 60) + parseInt(sec, 10);
}

// Only accepts processes whose executable basename is exactly "claude". A plain substring match would also count
// other processes whose names happen to contain the keyword "claude", such as "cc-monitor-webui".
function isClaudeProcess(args) {
  const exe = (args || "").trim().split(/\s+/)[0] || "";
  const base = exe.split("/").pop();
  return base === "claude";
}

// macOS has no /proc, so a process's cwd can only come from lsof. A missing cwd does more than leave the
// directory column blank: /api/status decides whether the process behind an audited session is still alive from
// "the set of cwds of live claude processes" (liveCwds/hasLiveProcess in server.js). If they are all null, every
// session is judged dead and the vital-signs indicator draws a flat grey line for all of them, even sessions
// that were working a moment ago.
//
// Passes all claude pids to lsof at once (-p takes a comma-separated list) rather than spawning once per
// process; -Fpn makes it print machine-readable groups of three lines "p<pid>\nfcwd\nn<path>", so we need not
// parse the aligned table meant for humans. Like reading /proc on Linux it is limited by permissions: claude
// processes run by other users cannot be looked up, and null is returned as is. lsof missing, a timeout or a
// process that just exited only mean no value; they are not treated as errors.
function lsofCwds(pids) {
  return new Promise((resolve) => {
    const out = new Map();
    if (os.platform() !== "darwin" || pids.length === 0) return resolve(out);
    const args = ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"];
    execFile("lsof", args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // When some pid cannot be found lsof exits non-zero, but what it did find is still printed on stdout, so keep
      // parsing even when err is set.
      resolve(parseLsofCwds(stdout));
    });
  });
}

// Parses `lsof -Fpn` output: each group is three lines "p<pid>" / "fcwd" / "n<path>". A pid whose cwd cannot be
// found has a p line but no n line; skip it (do not invent a path).
function parseLsofCwds(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of String(stdout || "").split("\n")) {
    if (line[0] === "p") pid = parseInt(line.slice(1), 10) || null;
    else if (line[0] === "n" && pid !== null) {
      out.set(pid, line.slice(1));
      pid = null;
    }
  }
  return out;
}

// Gets this pid's current working directory. On Linux read /proc (only processes of the same user as the Web UI
// are readable; other users' give EACCES); on macOS take it from the lsof result above. If neither works, return
// null and the front end shows "unknown" as is; never invent a fake one.
function tryReadCwd(pid, darwinCwds) {
  if (os.platform() === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch (e) {
      return null;
    }
  }
  // On non-darwin platforms lsofCwds() returns an empty Map (lsof is never called), so the result is also null
  return darwinCwds.get(pid) || null;
}

async function scanClaudeProcesses() {
  const lines = await psSnapshot();
  // Pick out the claude processes first, then look up cwds together, so macOS runs lsof only once
  const matched = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, uidStr, user, etime, rssStr, args] = m;
    if (!isClaudeProcess(args)) continue;
    matched.push({ pid: parseInt(pidStr, 10), uidStr, user, etime, rssStr, args });
  }
  const darwinCwds = await lsofCwds(matched.map((p) => p.pid));
  const procs = [];
  for (const { pid, uidStr, user, etime, rssStr, args } of matched) {
    const uptimeSec = parseEtime(etime);
    procs.push({
      pid,
      uid: parseInt(uidStr, 10),
      user,
      cwd: tryReadCwd(pid, darwinCwds),
      args,
      uptimeSec,
      // Absolute start time of the process (derived as "now - elapsed seconds"), shown on hover in the front end
      startedAt: uptimeSec === null ? null : new Date(Date.now() - uptimeSec * 1000).toISOString(),
      rssKb: parseInt(rssStr, 10),
    });
  }
  return procs;
}

function summarize(procs, currentUser) {
  const byUser = {};
  for (const p of procs) {
    if (!byUser[p.user]) byUser[p.user] = 0;
    byUser[p.user] += 1;
  }
  const otherUsers = Object.keys(byUser).filter((u) => u !== currentUser);
  return {
    currentUser,
    total: procs.length,
    byUser,
    mismatchedUsers: otherUsers,
    processes: procs,
  };
}

module.exports = { scanClaudeProcesses, summarize, parseLsofCwds };
