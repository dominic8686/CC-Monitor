"use strict";
const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const { SessionManager } = require("./lib/sessions");
const audit = require("./lib/audit");
const fmt = require("./lib/format");
const sessionFlow = require("./lib/sessionFlow");
const status = require("./lib/status");
const transcript = require("./lib/transcript");
const usage = require("./lib/usage");
const account = require("./lib/account");
const archives = require("./lib/archives");
const auditState = require("./lib/auditState");
const rulesMeta = require("./lib/rules");
const browse = require("./lib/browse");
const remoteAccess = require("./lib/remoteAccess");
const approvals = require("./lib/approvals");
const processScan = require("./lib/processScan");
const network = require("./lib/network");
const geoip = require("./lib/geoip");

// Several terminal PTY sessions live in this process. By default Node kills the whole process
// on an uncaught exception from any request or WS message, so every terminal session (related
// to that exception or not) vanishes at once with no warning. Same idea as hook.py in
// cc_monitor: "fail open". Log it, but never let one accident take down every live session.
process.on("uncaughtException", (err) => {
  console.error("[CC-Monitor WebUI] Uncaught exception (ignored, still running):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[CC-Monitor WebUI] Unhandled Promise rejection (ignored, still running):", err);
});

// Bind to localhost only by default: this tool can open terminals and spawn processes, so it
// must never be exposed to the internet or LAN without authentication. The "Allow remote access"
// switch in the UI does not change this default. To listen on all interfaces the admin must set
// CC_MONITOR_WEBUI_HOST=0.0.0.0 explicitly and restart the process: the security boundary is the
// listen address fixed at process start, not a flag a web page can flip at runtime.
// The UI switch (remoteAccess) controls something else: even when bound to 0.0.0.0, the
// middleware and WebSocket upgrade below check it first. It defaults to off (non-local sources
// are refused) and only lets them through when on, an extra application-layer gate, off by
// default, for the "I really do want to listen on all interfaces" case.
const HOST = process.env.CC_MONITOR_WEBUI_HOST || "127.0.0.1";
const PORT = parseInt(process.env.CC_MONITOR_WEBUI_PORT || "9999", 10);

const app = express();
app.use(express.json());

// Access gate: any request that is not from this machine, while "Allow remote access" is off,
// gets 403 and never reaches a route or static file below. It sits first and applies to every
// request. With the default 127.0.0.1 bind this check never blocks anything (only this machine
// can reach the socket); it only becomes the real gate once the admin sets HOST to 0.0.0.0.
app.use((req, res, next) => {
  const addr = req.socket.remoteAddress;
  if (remoteAccess.isLocalAddress(addr) || remoteAccess.getState().allowRemote) return next();
  res.status(403).type("text/plain").send("Forbidden: remote access to CC-Monitor is disabled. Enable it from the Home tab (from the local machine), or connect from 127.0.0.1.");
});

// This UI is still changing fast and files under public/ change at any time. Without no-store
// the browser may use a cached app.js/index.html without asking the server, so a change
// "seems to have no effect", which is hard to track down.
const noCacheStatic = (dir) => express.static(dir, { etag: false, lastModified: false, setHeaders: (res) => res.setHeader("Cache-Control", "no-store") });

// `Cache-Control: no-store` only works for caches that honour that header. The browser disk
// cache and transparent proxies in between (this machine runs mihomo/Clash; if the client also
// routes 127.0.0.1 through the proxy, the proxy's own cache policy may ignore the origin's
// Cache-Control) can disagree, and the symptom is "the server file changed / restarted, but the
// page is still the old one". So the core scripts and styles referenced from index.html get a
// version tied to process start time (`?v=<timestamp>`). A resource with a new URL is a "new
// object" to any cache, without relying on it obeying no-store.
const ASSET_VERSION = String(Date.now());
app.get("/", (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  html = html.replace(
    /(src|href)="(\/(?:app|i18n)\.js|\/style\.css)"/g,
    (m, attr, p) => `${attr}="${p}?v=${ASSET_VERSION}"`
  );
  res.set("Cache-Control", "no-store");
  res.type("html").send(html);
});

app.use(noCacheStatic(path.join(__dirname, "public")));
app.use("/vendor/xterm", noCacheStatic(path.join(__dirname, "node_modules/xterm")));
app.use("/vendor/xterm-addon-fit", noCacheStatic(path.join(__dirname, "node_modules/xterm-addon-fit/lib")));
app.use("/vendor/xterm-addon-webgl", noCacheStatic(path.join(__dirname, "node_modules/xterm-addon-webgl/lib")));

const sessions = new SessionManager();

// ---- REST API: terminal session management ----

// PTY sessions opened by the Web UI (ids from sessions.list()) and the Claude Code session_id
// recorded by hooks are two unrelated id spaces: the PTY id comes from our own
// crypto.randomUUID(), Claude Code generates its own session_id, and there is no natural mapping.
// The only link is the weak one of matching cwd: in the same working directory, the audit
// session with the latest activity is most likely the claude process running in this PTY. Not
// 100% accurate (it can guess wrong when one directory was opened several times), but good
// enough to show model / event count in the Home "in progress" drill-down, without a separate
// lookup feature.
// Status marker (working/blocked/idle), the same idea as herdr's "mark each pane with a status
// so you don't hunt for the stuck one". No new detection mechanism; it reuses two existing
// data sources: whether there is a pending approval request (pending_approvals; if present it is
// blocked, the one to look at first); and whether the terminal produced real output recently or
// the audit log has a recent event (either one counts as working). Neither means idle: most
// likely sitting at the prompt waiting for you to type, not stuck.
const RECENT_ACTIVITY_MS = 30 * 1000;
function computeSessionStatus(s, matchedAuditSessionId, matchedLastTs, pendingSessionIds) {
  if (matchedAuditSessionId && pendingSessionIds.has(matchedAuditSessionId)) return "blocked";
  const now = Date.now();
  const recentOutput = s.lastOutputAt && now - s.lastOutputAt < RECENT_ACTIVITY_MS;
  const recentEvent = matchedLastTs && now - new Date(matchedLastTs).getTime() < RECENT_ACTIVITY_MS;
  return recentOutput || recentEvent ? "working" : "idle";
}

// Same "working/idle" idea as RECENT_ACTIVITY_MS (30 seconds) above, but for a different data
// source: a Web UI terminal PTY produces output for every keystroke, so 30 seconds is sensitive
// enough. Externally monitored terminal sessions (the "session list" / "claude process details"
// here) only produce events at the moment a tool is called; gaps of tens of seconds to minutes
// while the model is thinking or the user reads output are perfectly normal. Too tight a
// threshold would mark most sessions that are actually working as "idle", so it is widened to
// 5 minutes.
const WORKING_THRESHOLD_MS = 5 * 60 * 1000;
// Returns not only the three states but also agoMs (milliseconds since last activity). In the
// working state the frontend uses it to compute "heartbeat depth": the fresher within 5 minutes,
// the deeper the colour and the larger the ECG swing, fading to the palest red near the
// 5-minute boundary instead of jumping straight from "deepest red" to "grey" at 5 minutes.
function vitalStatus(hasLiveProcess, lastTs) {
  if (!hasLiveProcess) return { status: "dead", agoMs: null };
  const agoMs = lastTs ? Date.now() - new Date(lastTs).getTime() : null;
  if (agoMs !== null && agoMs < WORKING_THRESHOLD_MS) return { status: "working", agoMs };
  return { status: "idle", agoMs };
}

// The PTY side records cwd as the raw string we passed to pty.spawn() when creating the
// terminal; the hook.py side records Python's os.getcwd(). If the path contains a symlink, the
// two strings can differ even for the same directory (the former does not resolve symlinks, the
// latter does), so an exact string compare wrongly reports "no match" and fields like model /
// event count that should have data come out empty. realpath is the fallback: compare resolved
// paths when they resolve, and fall back to the raw strings when they do not (the directory no
// longer exists).
function normCwd(p, cache) {
  if (!p) return p;
  if (cache.has(p)) return cache.get(p);
  let resolved;
  try {
    resolved = fs.realpathSync(p);
  } catch (e) {
    resolved = path.normalize(p).replace(/\/+$/, "") || p;
  }
  cache.set(p, resolved);
  return resolved;
}

app.get("/api/sessions", (req, res) => {
  const live = sessions.list();
  const auditRows = audit.listSessions();
  const pendingSessionIds = new Set(approvals.listPending().map((r) => r.session_id));
  const cwdCache = new Map(); // realpath each path string only once per request
  const enriched = live.map((s) => {
    const sCwd = normCwd(s.cwd, cwdCache);
    const candidates = auditRows.filter((r) => normCwd(r.cwd, cwdCache) === sCwd);
    candidates.sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1));
    const match = candidates[0];
    return {
      ...s,
      auditSessionId: match ? match.session_id : null,
      eventCount: match ? match.event_count : null,
      blockedCount: match ? match.blocked_count : null,
      bypassCount: match ? match.bypass_count : null,
      firstTs: match ? match.first_ts : null,
      lastTs: match ? match.last_ts : null,
      model: match && match.transcript_path ? transcript.getModel(match.transcript_path) : null,
      status: s.alive ? computeSessionStatus(s, match ? match.session_id : null, match ? match.last_ts : null, pendingSessionIds) : "dead",
      // Time since last activity: the frontend "vital signs" indicator uses it for heartbeat
      // colour depth and waveform swing. Without this field vitalHeat() gets undefined and
      // always returns 0, drawing a grey flat line however active the session is (exactly the
      // "health status never shows red" bug). Take the more recent of two activity signals:
      // the PTY really printed something (lastOutputAt), or there is a new audit event under
      // this cwd (last_ts).
      statusAgoMs: (() => {
        if (!s.alive) return null;
        const outputAt = s.lastOutputAt || 0;
        const eventAt = match && match.last_ts ? new Date(match.last_ts).getTime() : 0;
        const latest = Math.max(outputAt, eventAt);
        return latest ? Date.now() - latest : null;
      })(),
    };
  });
  res.json(enriched);
});

app.post("/api/sessions", (req, res) => {
  const { cwd, launchClaude } = req.body || {};
  // launchClaude defaults to true when omitted (the "new session" default, unchanged); "new
  // window" passes false explicitly to get a bare shell that does not type claude automatically.
  const session = sessions.create({ cwd, launchClaude: launchClaude !== false });
  res.json({ id: session.id, cwd: session.cwd, createdAt: session.createdAt });
});

app.delete("/api/sessions/:id", (req, res) => {
  const ok = sessions.kill(req.params.id);
  res.json({ ok });
});

// ---- REST API: folder browser for picking the working directory in the "new session" dialog ----
app.get("/api/browse-dir", (req, res) => {
  const result = browse.listDir(req.query.path);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ---- REST API: whether other devices may access this Web UI ----
// listeningHost tells the frontend which address this process is actually bound to. If it is
// still 127.0.0.1, changing the allowRemote flag below has no real effect; the admin must set
// CC_MONITOR_WEBUI_HOST=0.0.0.0 explicitly and restart the process. The frontend uses this field
// to decide whether to say "this switch does not take effect yet".
app.get("/api/remote-access-state", (req, res) => {
  res.json({ ...remoteAccess.getState(), listeningHost: HOST });
});

app.post("/api/remote-access-state", (req, res) => {
  const { allowRemote } = req.body || {};
  res.json({ ...remoteAccess.setState(allowRemote), listeningHost: HOST });
});

// ---- REST API: confirm-type operations pending approval (another path to the same thing as
// pressing y/N in the terminal that triggered it; whichever answers first wins, see confirm() in
// cc_monitor/notify.py) ----

app.get("/api/pending-approvals", (req, res) => {
  res.json(approvals.listPending());
});

app.post("/api/pending-approvals/:id/resolve", (req, res) => {
  const { decision } = req.body || {};
  const result = approvals.resolve(parseInt(req.params.id, 10), decision);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get("/api/approvals/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);
  res.json(approvals.listHistory(limit));
});

// ---- REST API: detect which user the claude process runs as (whether the Web UI and the
// claude in your terminal are the same OS user; if not, each side writes its own ~/.cc-monitor/
// database, and this endpoint exists to expose that) ----

app.get("/api/claude-processes", async (req, res) => {
  const procs = await processScan.scanClaudeProcesses();
  // A "running" claude process carries no timestamp of its own (ps only has the process start
  // time, not "the last time it actually did something"). Use the time of the latest audit log
  // event for the same cwd as an approximation of "recently active": a process that is running
  // but has no new events is most likely idle waiting for user input, not a bug.
  const cwdCache = new Map();
  const auditRows = audit.listSessions();
  const lastEventByCwd = new Map();
  for (const r of auditRows) {
    if (!r.cwd) continue;
    const key = normCwd(r.cwd, cwdCache);
    const prev = lastEventByCwd.get(key);
    if (!prev || r.last_ts > prev) lastEventByCwd.set(key, r.last_ts);
  }
  // The process itself does not know which model it uses; the model is only written in the
  // transcript. Find the latest session for this cwd and parse the model ID and session id from
  // its transcript. When a directory had several sessions, take the latest (auditRows is already
  // sorted by last_ts, newest first).
  const sessionByCwd = new Map();
  for (const r of auditRows) {
    if (!r.cwd) continue;
    const key = normCwd(r.cwd, cwdCache);
    if (!sessionByCwd.has(key)) sessionByCwd.set(key, r);
  }
  const enriched = procs.map((p) => {
    const lastEventTs = p.cwd ? lastEventByCwd.get(normCwd(p.cwd, cwdCache)) || null : null;
    const sess = p.cwd ? sessionByCwd.get(normCwd(p.cwd, cwdCache)) : null;
    // Never "dead" here: being in this list means the process really is running right now, so
    // vitalStatus()'s first argument is hard-coded true and only separates working (recent audit
    // events) from idle (alive but quiet).
    const v = vitalStatus(true, lastEventTs);
    return {
      ...p,
      lastEventTs,
      status: v.status,
      statusAgoMs: v.agoMs,
      model: sess && sess.transcript_path ? transcript.getModel(sess.transcript_path) : null,
      sessionId: sess ? sess.session_id : null,
      eventCount: sess ? sess.event_count : null,
    };
  });
  res.json(processScan.summarize(enriched, os.userInfo().username));
});

// ---- REST API: Claude Code network traffic (data comes from the system-layer probe, Linux +
// eBPF only; without the probe installed or running these endpoints honestly return empty data,
// not a bug) ----

// Location city/country names follow the page language (the names field in MaxMind GeoLite2 is
// itself a multilingual object). The frontend passes the current UI language ("zh"/"en") via
// ?lang=; any other value is treated as en.
function geoLang(req) {
  return req.query.lang === "zh" ? "zh" : "en";
}

app.get("/api/network-traffic", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);
  const [rows, sum, geoStatus] = await Promise.all([
    network.listTraffic(limit, geoLang(req)),
    network.summary(),
    geoip.getStatus(),
  ]);
  res.json({ rows, summary: sum, geo: geoStatus });
});

app.get("/api/network-traffic/geopairs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
  const pairs = await network.geoPairs(limit, geoLang(req));
  res.json({ pairs });
});

app.get("/api/geoip-status", async (req, res) => {
  res.json(await geoip.getStatus());
});

// ---- REST API: audit log ----

app.get("/api/log-sessions", (req, res) => {
  const rows = audit.listSessions().map((r) => ({
    ...r,
    model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
    has_transcript: !!r.transcript_path,
  }));
  res.json(rows);
});

// Timeline view: one request = the latest `lanes` sessions x operations in the last
// range_minutes minutes, one lane per session, aggregated into time buckets ("how many in this
// bucket, risk mix, anything blocked"), which the frontend draws on the session-timeline.js
// canvas. Bucket size comes from a few fixed tiers by window length (1h/6h/24h/7d), not free user
// input, to avoid too many or too few buckets producing an unreadable chart.
function bucketSizeFor(rangeMinutes) {
  if (rangeMinutes <= 60) return 60 * 1000; // 1 minute
  if (rangeMinutes <= 6 * 60) return 5 * 60 * 1000; // 5 minutes
  if (rangeMinutes <= 24 * 60) return 15 * 60 * 1000; // 15 minutes
  return 2 * 60 * 60 * 1000; // 2 hours
}

app.get("/api/timeline", (req, res) => {
  const rangeMinutes = Math.min(parseInt(req.query.range_minutes || "1440", 10), 7 * 24 * 60);
  const laneLimit = Math.min(parseInt(req.query.lanes || "50", 10), 100);
  const sessions = audit.listSessions(laneLimit);
  const sinceMs = Date.now() - rangeMinutes * 60 * 1000;
  const bucketMs = bucketSizeFor(rangeMinutes);

  const sessionIds = sessions.map((s) => s.session_id);
  const rows = audit.timelineEvents({ sessionIds });

  // Group by session, and record whether perSessionLimit was hit (meaning older events of this
  // session were truncated and not all pulled into buckets). perSessionLimit currently uses
  // timelineEvents()'s default of 800; here we only need "how many rows this query returned for
  // the session" to tell.
  const perSession = new Map(sessionIds.map((id) => [id, []]));
  for (const r of rows) {
    const ms = new Date(r.ts).getTime();
    if (Number.isNaN(ms) || ms < sinceMs) continue;
    const list = perSession.get(r.session_id);
    if (list) list.push({ ...r, ms });
  }

  const lanes = sessions.map((s) => {
    const evs = perSession.get(s.session_id) || [];
    const buckets = new Map(); // bucketStartMs -> {n, nHigh, nMedium, nLow, nInfo, nBlocked}
    for (const e of evs) {
      const b = Math.floor(e.ms / bucketMs) * bucketMs;
      if (!buckets.has(b)) buckets.set(b, { n: 0, nHigh: 0, nMedium: 0, nLow: 0, nInfo: 0, nBlocked: 0 });
      const bucket = buckets.get(b);
      bucket.n++;
      if (e.risk === "high") bucket.nHigh++;
      else if (e.risk === "medium") bucket.nMedium++;
      else if (e.risk === "low") bucket.nLow++;
      else bucket.nInfo++;
      if (e.decision === "blocked") bucket.nBlocked++;
    }
    return {
      sessionId: s.session_id,
      cwd: s.cwd,
      model: s.transcript_path ? transcript.getModel(s.transcript_path) : null,
      eventCount: s.event_count,
      blockedCount: s.blocked_count,
      bypassCount: s.bypass_count,
      firstTs: s.first_ts,
      lastTs: s.last_ts,
      buckets: [...buckets.entries()]
        .map(([startMs, v]) => ({ startMs, ...v }))
        .sort((a, b) => a.startMs - b.startMs),
    };
  });

  res.json({ rangeMinutes, bucketMs, now: Date.now(), lanes });
});

// Operation flow chart for one session: split into turns by user prompt; each turn holds operation nodes with paired before/after events and a success/failure verdict.
const SESSION_FLOW_LIMIT = 3000;
app.get("/api/session-flow", (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: "session_id required" });
  const rows = audit.sessionEventsTail(sessionId, SESSION_FLOW_LIMIT);
  const meta = audit.listSessions(500).find((s) => s.session_id === sessionId) || null;
  const flow = sessionFlow.buildSessionFlow(rows);
  res.json({
    sessionId,
    cwd: meta ? meta.cwd : rows.length ? rows[rows.length - 1].cwd : null,
    model: meta && meta.transcript_path ? transcript.getModel(meta.transcript_path) : null,
    eventCount: meta ? meta.event_count : rows.length,
    truncated: rows.length >= SESSION_FLOW_LIMIT,
    ...flow,
  });
});

// ---- REST API: Claude Tap (the full conversation sent to / received from the model) ----

app.get("/api/transcript", (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

  const transcriptPath = audit.getTranscriptPath(sessionId);
  if (!transcriptPath) {
    return res.json({ entries: [], nextLine: 0, transcriptPath: null, totalLines: 0 });
  }
  // transcript_path in the hook payload is what Claude Code reports as "the file it intends to /
  // is writing to"; that does not mean the file exists. Some execution contexts (some one-off
  // tool calls, background tasks) never write a normal project transcript to disk. In that case
  // tell the frontend clearly that "the file does not exist"; otherwise it keeps showing
  // "0 · that path" stuck on "Loading", which looks frozen when there is simply no data source.
  if (!fs.existsSync(transcriptPath)) {
    return res.json({ entries: [], nextLine: 0, transcriptPath, totalLines: 0, missing: true });
  }

  const sinceLineRaw = req.query.since_line;
  const limit = Math.min(parseInt(req.query.limit || "300", 10), 2000);
  // since_line missing or 0 means this is the first fetch after selecting the session: return
  // "what it has been doing recently" (searching back from the end of the file), not page through
  // from line 1, or a long session of tens of thousands of lines would show only messages from
  // days ago, nothing like "live". Later polls pass the previous nextLine as since_line (always
  // > 0) and take the normal incremental forward read.
  const { entries, nextLine } =
    !sinceLineRaw || sinceLineRaw === "0"
      ? transcript.readTailEntries(transcriptPath, limit)
      : transcript.readEntries(transcriptPath, parseInt(sinceLineRaw, 10), limit);
  res.json({
    entries: entries.map(transcript.renderEntryHtml),
    nextLine,
    transcriptPath,
    totalLines: transcript.countLines(transcriptPath),
  });
});

// Claude Tap "all sessions" merged view: take the latest few entries from each session that has a
// transcript, merge-sort by timestamp and tag each with its session. No incremental polling
// cursor (each call re-reads the tail of every session): for a personal monitoring tool the
// session count is usually single digits to a dozen or so, so keeping it simple beats
// maintaining a multi-file incremental cursor.
app.get("/api/transcript/all", (req, res) => {
  const perSessionLimit = Math.min(parseInt(req.query.per_session_limit || "30", 10), 200);
  const overallLimit = Math.min(parseInt(req.query.limit || "200", 10), 1000);

  const sessions = audit.listSessions().filter((r) => r.transcript_path);
  let merged = [];
  for (const s of sessions) {
    if (!fs.existsSync(s.transcript_path)) continue;
    const { entries } = transcript.readTailEntries(s.transcript_path, perSessionLimit);
    const model = transcript.getModel(s.transcript_path);
    for (const e of entries) {
      merged.push({
        ...transcript.renderEntryHtml(e),
        sessionId: s.session_id,
        cwd: s.cwd,
        model,
      });
    }
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest first, same order as the single-session view
  merged = merged.slice(0, overallLimit);
  res.json({ entries: merged, sessionCount: sessions.length });
});

// ---- REST API: account-level usage/quota (reads the same Claude Code OAuth credentials as ccstatusline) ----

// Rule metadata: id -> {title, desc, title_en, desc_en, risk, action}. AI Approvals uses it to turn
// a rule id into a plain explanation of "what operation this asks you to confirm".
app.get("/api/rules/meta", (req, res) => {
  res.json(rulesMeta.ruleMeta());
});

app.get("/api/usage", async (req, res) => {
  const result = await usage.getUsage();
  res.json(result);
});

app.get("/api/account", (req, res) => {
  res.json(account.getAccountInfo());
});

app.get("/api/logs", (req, res) => {
  const sinceId = parseInt(req.query.since_id || "0", 10);
  const limit = Math.min(parseInt(req.query.limit || "300", 10), 2000);
  const rows = audit.queryEvents({ sessionId: req.query.session_id || null, sinceId, limit });
  const events = rows.map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml, extra } = fmt.describe(row.tool_name, row.source, detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      source: row.source,
      stageLabel: fmt.stageLabel(row.source),
      toolName: row.tool_name,
      cwd: row.cwd,
      risk: row.risk || "-",
      matchedRule: row.matched_rule,
      decision: row.decision,
      label,
      summaryHtml,
      extra,
    };
  });
  res.json({ events, dbPath: audit.dbPath() });
});

app.get("/api/stats", (req, res) => {
  res.json(audit.stats());
});

// ---- REST API: Home overview + Status panel ----

// The seven Home card groups GitHub/SSH/download/Docker/archive/network diagnostics/process
// management now show only a total (the category breakdown appears when opened); the total is
// the sum of the n field in the category subtotal table.
function sumN(rows) {
  return rows.reduce((a, r) => a + r.n, 0);
}

app.get("/api/overview", async (req, res) => {
  const s = audit.stats();
  const netSummary = await network.summary();
  res.json({
    ...s,
    liveSessionCount: sessions.list().filter((x) => x.alive).length,
    fileOps: audit.fileOpsStats(),
    installOps: audit.installStats(),
    githubOpsTotal: sumN(audit.githubOpsBreakdown()),
    sshOpsTotal: sumN(audit.sshOpsBreakdown()),
    downloadOpsTotal: sumN(audit.downloadOpsBreakdown()),
    fileSendOpsTotal: sumN(audit.fileSendOpsBreakdown()),
    dockerOpsTotal: sumN(audit.dockerOpsBreakdown()),
    archiveOpsTotal: sumN(audit.archiveOpsBreakdown()),
    netdiagOpsTotal: sumN(audit.netdiagOpsBreakdown()),
    reverseEngOpsTotal: sumN(audit.reverseEngOpsBreakdown()),
    procbgOpsTotal: sumN(audit.procbgOpsBreakdown()),
    sensitiveOpsTotal: sumN(audit.sensitiveOpsBreakdown()),
    sensitiveDataTotal: sumN(audit.sensitiveDataBreakdown()),
    advancedThreatTotal: sumN(audit.advancedThreatBreakdown()),
    workdirEscapeTotal: sumN(audit.workdirEscapeBreakdown()),
    workdirEscapeBreakdown: audit.workdirEscapeBreakdown(),
    screenshotOps: audit.screenshotStats(),
    toolCalls: audit.toolCallStats().total,
    mcpCalls: audit.mcpCallStats().total,
    skillCalls: audit.skillCallStats().total,
    subagentCalls: audit.subagentCallStats().total,
    searchCalls: audit.searchCallStats().total,
    todoCalls: audit.todoCallStats().total,
    aiTrajectory: netSummary.distinctIps,
  });
});

// ---- REST API: drill-down details for the Home stat cards ----

app.get("/api/drilldown/sessions", async (req, res) => {
  // "active/stopped" here is not the same as "working/idle" for Web UI terminal sessions. Most
  // sessions here run in external terminals and are monitored passively through hooks; gaps of a
  // few minutes between tool calls are normal, so "any activity in the last few tens of seconds"
  // cannot decide it. The reliable signal is "is there still a claude process really running
  // under this cwd", matched by cwd against the same live ps scan as the "detected claude
  // processes" card (reusing normCwd's realpath normalisation so a symlink does not cause a false
  // "no match").
  const cwdCache = new Map();
  const liveProcs = await processScan.scanClaudeProcesses();
  const liveCwds = new Set(liveProcs.map((p) => normCwd(p.cwd, cwdCache)).filter(Boolean));
  const rows = audit.listSessions().map((r) => ({
    sessionId: r.session_id,
    cwd: r.cwd,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    eventCount: r.event_count,
    blockedCount: r.blocked_count,
    bypassCount: r.bypass_count,
    model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
    // Model input/output/cache token usage, computed from this session's transcript (the same
    // getTokenStats as the model usage table on the Status page), so the session list shows how
    // much each session has burned.
    tokenStats: r.transcript_path ? transcript.getTokenStats(r.transcript_path) : null,
    active: r.cwd ? liveCwds.has(normCwd(r.cwd, cwdCache)) : false,
    ...(() => {
      const v = vitalStatus(r.cwd ? liveCwds.has(normCwd(r.cwd, cwdCache)) : false, r.last_ts);
      return { status: v.status, statusAgoMs: v.agoMs };
    })(),
  }));
  res.json(rows);
});

app.get("/api/drilldown/event-types", (req, res) => {
  res.json(audit.eventTypeBreakdown());
});

app.get("/api/drilldown/blocked", (req, res) => {
  const rows = audit.blockedDetails().map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      label,
      summaryHtml,
    };
  });
  res.json(rows);
});

app.get("/api/drilldown/file-op/:type", (req, res) => {
  const type = req.params.type;
  if (!["read", "write", "edit", "delete"].includes(type)) {
    return res.status(400).json({ error: "type must be one of read/write/edit/delete" });
  }
  const rows = audit.fileOpDetails(type).map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      label,
      summaryHtml,
    };
  });
  res.json(rows);
});

// GitHub/SSH/download/Docker/archive/network diagnostics/process management: these seven groups
// are all "one summary card on Home; open it for category subtotals + event details", and the
// endpoint shape is identical too (the same pattern as the existing mcp-calls/skill-calls
// endpoints), so they share one generic handler.
function opsDrilldownHandler(breakdownFn, eventsFn, describeOpts = {}) {
  return (req, res) => {
    const breakdown = breakdownFn();
    const events = eventsFn().map((row) => {
      let detail = {};
      try {
        detail = row.detail ? JSON.parse(row.detail) : {};
      } catch (e) {
        detail = {};
      }
      const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail, describeOpts);
      return {
        id: row.id,
        ts: row.ts,
        sessionId: row.session_id,
        cwd: row.cwd,
        toolName: row.tool_name,
        matchedRule: row.matched_rule,
        kind: row.kind,
        label,
        summaryHtml,
      };
    });
    res.json({ breakdown, events });
  };
}

app.get("/api/drilldown/github-ops", opsDrilldownHandler(audit.githubOpsBreakdown, audit.githubOpsEvents));
app.get("/api/drilldown/ssh-ops", opsDrilldownHandler(audit.sshOpsBreakdown, audit.sshOpsEvents));
app.get("/api/drilldown/download-ops", opsDrilldownHandler(audit.downloadOpsBreakdown, audit.downloadOpsEvents));
// File-send operations pass { boldFiles: true }: in the drill-down list you want to see at a
// glance which file was sent, so arguments that look like file names in the command text and
// the file_path of Artifact events are bolded. The other group cards (SSH/download/Docker etc.)
// do not need this emphasis and leave it unset.
app.get("/api/drilldown/file-send-ops", opsDrilldownHandler(audit.fileSendOpsBreakdown, audit.fileSendOpsEvents, { boldFiles: true }));
app.get("/api/drilldown/docker-ops", opsDrilldownHandler(audit.dockerOpsBreakdown, audit.dockerOpsEvents));
app.get("/api/drilldown/archive-ops", opsDrilldownHandler(audit.archiveOpsBreakdown, audit.archiveOpsEvents));
app.get("/api/drilldown/netdiag-ops", opsDrilldownHandler(audit.netdiagOpsBreakdown, audit.netdiagOpsEvents));
app.get("/api/drilldown/reverseeng-ops", opsDrilldownHandler(audit.reverseEngOpsBreakdown, audit.reverseEngOpsEvents));
app.get("/api/drilldown/procbg-ops", opsDrilldownHandler(audit.procbgOpsBreakdown, audit.procbgOpsEvents));
app.get("/api/drilldown/sensitive-ops", opsDrilldownHandler(audit.sensitiveOpsBreakdown, audit.sensitiveOpsEvents));
app.get("/api/drilldown/sensitive-data", opsDrilldownHandler(audit.sensitiveDataBreakdown, audit.sensitiveDataEvents));
app.get("/api/drilldown/advanced-threat", opsDrilldownHandler(audit.advancedThreatBreakdown, audit.advancedThreatEvents));
app.get("/api/drilldown/workdir-escape", opsDrilldownHandler(audit.workdirEscapeBreakdown, audit.workdirEscapeEvents));

app.get("/api/drilldown/install-op/:type", (req, res) => {
  const type = req.params.type;
  // Ask audit's group table for the valid values, so the group definition is not kept in two places and a new group is not missed here.
  const validTypes = audit.installGroupNames();
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${validTypes.join("/")}` });
  }
  const rows = audit.installDetails(type).map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      label,
      summaryHtml,
    };
  });
  res.json(rows);
});

app.get("/api/drilldown/screenshot", (req, res) => {
  const rows = audit.screenshotDetails().map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    // "Basic info" only: summary text that fmt.describe() already computes, such as the command
    // text or file path. The screenshot file's image content is not read or served: screenshots
    // may well contain sensitive desktop information, and the user explicitly asked for the
    // details page to show only the path and basic info, not the image.
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      kind: row.kind,
      label,
      summaryHtml,
    };
  });
  // Include subtotals by method: real screen captures (screenshot tool / headless browser / MCP
  // action) must be kept apart from "just opened an image file", otherwise the card total is
  // almost all the latter and you cannot tell whether the former was detected at all.
  res.json({ breakdown: audit.screenshotBreakdown(), events: rows });
});

app.get("/api/drilldown/tool-calls", (req, res) => {
  res.json({ breakdown: audit.toolCallBreakdown(), events: audit.toolCallEvents() });
});

app.get("/api/drilldown/mcp-calls", (req, res) => {
  res.json({ breakdown: audit.mcpCallBreakdown(), events: audit.mcpCallEvents() });
});

app.get("/api/drilldown/skill-calls", (req, res) => {
  res.json({ breakdown: audit.skillCallBreakdown(), events: audit.skillCallEvents() });
});

app.get("/api/drilldown/subagent-calls", (req, res) => {
  res.json({ breakdown: audit.subagentCallBreakdown(), events: audit.subagentCallEvents() });
});

app.get("/api/drilldown/search-calls", (req, res) => {
  res.json({ breakdown: audit.searchCallBreakdown(), events: audit.searchCallEvents() });
});

app.get("/api/drilldown/todo-calls", (req, res) => {
  res.json(audit.todoCallEvents());
});

app.get("/api/drilldown/ai-trajectory-events", (req, res) => {
  res.json(audit.networkConnectEvents());
});

// ---- REST API: archive data (archive the current event data) / clear current event data / archive history list ----

app.get("/api/archives", (req, res) => {
  res.json(archives.listArchives());
});

app.post("/api/archives", async (req, res) => {
  const { label } = req.body || {};
  const result = await archives.createArchive(label);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.delete("/api/archives/:id", (req, res) => {
  const result = archives.deleteArchive(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// Open one history archive and view its events. Same event shape as /api/logs, so the frontend
// can reuse the same renderLogItem() rendering logic instead of writing another one.
app.get("/api/archives/:id/events", (req, res) => {
  const sinceId = parseInt(req.query.since_id || "0", 10);
  const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
  const rows = archives.getArchiveEvents(req.params.id, { sinceId, limit });
  if (rows === null) return res.status(404).json({ error: "Archive not found or its file is missing" });
  const events = rows.map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml, extra } = fmt.describe(row.tool_name, row.source, detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      source: row.source,
      stageLabel: fmt.stageLabel(row.source),
      toolName: row.tool_name,
      cwd: row.cwd,
      risk: row.risk || "-",
      matchedRule: row.matched_rule,
      decision: row.decision,
      label,
      summaryHtml,
      extra,
    };
  });
  res.json({ events });
});

app.post("/api/events/clear", (req, res) => {
  const result = archives.clearCurrentEvents();
  res.json(result);
});

// ---- REST API: the Home "Sync update" button runs git pull in the project source directory to
// bring down new code and rules from GitHub. It always runs plain `git pull` and never splices
// request parameters into the command line (execFile skips the shell and the arguments are a
// fixed array, so there is no room for injection). git's own output is returned to the frontend
// as is, with no "auto-resolve conflicts" or similar: if there is a local conflict git pull fails
// by itself and says why, and this button never silently changes or discards anything in the
// working tree. What comes down is source files; the Node process does not restart and Python
// modules already imported by the hook are not re-run, so the frontend should say "you may need
// to restart the Web UI to use the new code".
const REPO_ROOT = path.join(__dirname, "..");
app.post("/api/sync-update", (req, res) => {
  execFile("git", ["pull"], { cwd: REPO_ROOT, timeout: 60_000 }, (err, stdout, stderr) => {
    res.json({
      ok: !err,
      code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
      stdout: stdout || "",
      stderr: stderr || (err && !stdout ? String(err.message || err) : ""),
    });
  });
});

// ---- REST API: audit switch (start / pause / stop) ----

app.get("/api/audit-state", (req, res) => {
  res.json(auditState.getState());
});

app.post("/api/audit-state", (req, res) => {
  const { state } = req.body || {};
  try {
    res.json(auditState.setState(state));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/status", async (req, res) => {
  const cwdCache = new Map();
  const liveProcs = await processScan.scanClaudeProcesses();
  const liveCwds = new Set(liveProcs.map((p) => normCwd(p.cwd, cwdCache)).filter(Boolean));
  const liveSessions = sessions.list().map((s) => {
    const g = status.gitInfo(s.cwd);
    return {
      kind: "webui",
      id: s.id,
      cwd: s.cwd,
      alive: s.alive,
      exitCode: s.exitCode,
      uptimeMs: Date.now() - s.createdAt,
      gitBranch: g.branch,
      gitDirty: g.dirty,
      ...(() => {
        const v = vitalStatus(s.alive, s.lastOutputAt);
        return { status: v.status, statusAgoMs: v.agoMs };
      })(),
    };
  });
  const auditSessions = audit.listSessions(50).map((r) => {
    const g = status.gitInfo(r.cwd);
    const tokenStats = r.transcript_path ? transcript.getTokenStats(r.transcript_path) : null;
    const hasLiveProcess = r.cwd ? liveCwds.has(normCwd(r.cwd, cwdCache)) : false;
    return {
      kind: "audit",
      sessionId: r.session_id,
      cwd: r.cwd,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      eventCount: r.event_count,
      blockedCount: r.blocked_count,
      bypassCount: r.bypass_count,
      gitBranch: g.branch,
      gitDirty: g.dirty,
      model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
      tokenStats,
      compactionStats: r.transcript_path ? transcript.getCompactionStats(r.transcript_path) : null,
      ...(() => {
        const v = vitalStatus(hasLiveProcess, r.last_ts);
        return { status: v.status, statusAgoMs: v.agoMs };
      })(),
    };
  });
  res.json({ liveSessions, auditSessions });
});

// Usage statistics per model: sums the token usage that each session's transcript already
// groups by model (see getTokenStats().byModel in transcript.js). It does not rescan files; it
// reuses the same data /api/status already computes.
app.get("/api/model-usage", (req, res) => {
  const rows = audit.listSessions(200);
  const totals = {};
  for (const r of rows) {
    if (!r.transcript_path) continue;
    const stats = transcript.getTokenStats(r.transcript_path);
    if (!stats || !stats.byModel) continue;
    for (const [model, b] of Object.entries(stats.byModel)) {
      if (!totals[model]) totals[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0, sessionCount: 0 };
      totals[model].inputTokens += b.inputTokens;
      totals[model].outputTokens += b.outputTokens;
      totals[model].cacheReadTokens += b.cacheReadTokens;
      totals[model].cacheCreationTokens += b.cacheCreationTokens;
      totals[model].turns += b.turns;
      totals[model].sessionCount += 1;
    }
  }
  const models = Object.entries(totals)
    .map(([model, b]) => ({
      model,
      ...b,
      totalTokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  res.json({ models, sessionsScanned: rows.length });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // The WebSocket upgrade is a native http.Server event that bypasses the Express middleware
  // chain, so the app.use gate above does not cover it. This terminal PTY channel is precisely the
  // riskiest one (it is a shell), so it must be checked separately here too, not only the HTTP
  // routes.
  const addr = socket.remoteAddress;
  if (!remoteAccess.isLocalAddress(addr) && !remoteAccess.getState().allowRemote) {
    socket.destroy();
    return;
  }
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== "/ws/terminal") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sessionId = query.id;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const session = sessions.get(ws.sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "Session not found or already ended" }));
    ws.close();
    return;
  }

  session.clients.add(ws);
  // Replay the existing scrollback to the newly connected client in one go.
  if (session.scrollback.length) {
    ws.send(JSON.stringify({ type: "data", data: session.scrollback.join("") }));
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.type === "input") {
      sessions.write(session.id, msg.data);
    } else if (msg.type === "resize") {
      sessions.resize(session.id, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  const accessNote = HOST === "127.0.0.1" ? "(local access only)" : `(bound to ${HOST}; see Home for the actual state of the "Allow remote access" switch)`;
  console.log(`[CC-Monitor WebUI] Listening on http://${HOST}:${PORT} ${accessNote}`);
  console.log(`[CC-Monitor WebUI] Reading the audit log from: ${audit.dbPath()}`);
  // The cc_monitor hook (Python) and this Web UI process each work out their own ~/.cc-monitor/
  // directory independently: both use the home of the OS user running the current process, not a
  // shared setting. If the Web UI is started as root/sudo but you normally run claude in the
  // terminal as your own account, the two sides write two unrelated SQLite files: confirmation
  // prompts and audit events from the terminal never show up on the pending approval page.
  // Printing the current user name here makes a mismatch obvious at a glance, instead of after
  // a long investigation.
  try {
    const user = os.userInfo().username;
    console.log(
      `[CC-Monitor WebUI] Running as user: ${user} (reminder: this must be the same OS user as the terminal where you normally run claude, ` +
        `otherwise each side writes its own ~/.cc-monitor/ database and neither sees the other. Do not start this service with sudo/root unless your claude also runs as root)`
    );
  } catch (e) {
    // os.userInfo() can fail in rare environments (e.g. missing uid/gid mapping); if so, skip it, nothing else depends on it
  }
});
