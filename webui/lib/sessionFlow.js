"use strict";
// Assembles a session's raw audit events into a "session flow" diagram: split into turns at each user prompt,
// each turn holding operation nodes in time order. Each node merges the two records of one tool call, "about to
// run" (hook_pre) and "completed" (hook_post), and decides whether the operation finally succeeded or failed.
//
// How success is decided: Claude Code's PostToolUse hook fires only when the tool ran successfully (not on an
// error, a user rejection or an interruption), so:
//   - hook_post present: it ran. Then check the returned content for markers that "the tool finished but the
//     result is a failure" (interrupted / timeout / HTTP error code / success=false), and whether Bash wrote
//     to stderr.
//   - Only hook_pre, no hook_post: either blocked by our rules (decision=blocked), or still running (the
//     session was active recently and this turn has not ended); otherwise it failed / was rejected / was
//     interrupted.
// Hook records carry no tool_use_id, so pairing is "same tool, identical input, first in first out": hook_post
// carries a copy of the input, the same object as hook_pre's detail.
const fmt = require("./format");

const RUNNING_WINDOW_MS = 10 * 60 * 1000;
const GROUP_MIN = 3;
const RISK_RANK = { high: 4, medium: 3, low: 2, info: 1, "-": 0 };
const QUIET_RISKS = new Set(["info", "low", "-", null, undefined, ""]);
const TOOL_EVENT_SOURCES = new Set(["hook_pre", "hook_post"]);
const OS_SOURCES = new Set(["os_exec", "os_net", "os_file", "os_listen"]);

function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

function parseDetail(row) {
  try {
    return row.detail ? JSON.parse(row.detail) : {};
  } catch (e) {
    return {};
  }
}

function tsMs(ts) {
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function worseRisk(a, b) {
  return (RISK_RANK[a] || 0) >= (RISK_RANK[b] || 0) ? a : b;
}

// With hook_post: the tool finished; judge the result from the returned content.
function postStatus(tool, resp) {
  if (!resp || typeof resp !== "object") return { status: "ok" };
  if (resp.success === false) return { status: "fail", reason: "reported", detail: String(resp.message || "").slice(0, 200) };
  if (tool === "Bash") {
    if (resp.interrupted) return { status: "fail", reason: "interrupted" };
    if (resp.timedOutAfterMs) return { status: "fail", reason: "timeout", detail: String(resp.timedOutAfterMs) };
    if (resp.backgroundTaskId) return { status: "background" };
    const stderr = String(resp.stderr || "").trim();
    if (stderr) return { status: "warn", reason: "stderr", detail: stderr.slice(-200) };
    return { status: "ok" };
  }
  if (tool === "WebFetch" && typeof resp.code === "number" && resp.code >= 400) {
    return { status: "fail", reason: "http", detail: `${resp.code} ${resp.codeText || ""}`.trim() };
  }
  if ((tool === "Agent" || tool === "Task") && resp.isAsync) return { status: "background" };
  return { status: "ok" };
}

function makeOpNode({ pre, post, preDetail, postDetail }) {
  const base = pre || post;
  const tool = base.tool_name;
  const describeFrom = post ? { source: "hook_post", detail: postDetail } : { source: base.source, detail: preDetail };
  const d = fmt.describe(tool, describeFrom.source, describeFrom.detail);
  const node = {
    id: base.id,
    type: "op",
    tool,
    source: base.source,
    label: d.label,
    summaryHtml: d.summaryHtml,
    extra: d.extra,
    startTs: base.ts,
    endTs: post ? post.ts : null,
    durationMs: null,
    risk: pre && post ? worseRisk(pre.risk, post.risk) : base.risk,
    matchedRule: (pre && pre.matched_rule) || (post && post.matched_rule) || null,
    decision: pre ? pre.decision : post.decision,
    branch: tool === "Agent" || tool === "Task",
    eventIds: [pre && pre.id, post && post.id].filter(Boolean),
  };
  if (pre && post) {
    const a = tsMs(pre.ts);
    const b = tsMs(post.ts);
    if (a !== null && b !== null) node.durationMs = Math.max(0, b - a);
  }
  if (post) {
    Object.assign(node, postStatus(tool, postDetail && postDetail.response));
  } else if (pre && pre.decision === "blocked") {
    node.status = "blocked";
  } else {
    node.status = "pending"; // provisional; once the whole turn is seen, decide between "in progress" and "incomplete"
  }
  return node;
}

function makeOsNode(row, detail) {
  const d = fmt.describe(row.tool_name, row.source, detail);
  const warn = (d.extra || []).some((e) => e.cls === "warn");
  return {
    id: row.id,
    type: "observe",
    tool: row.tool_name,
    source: row.source,
    label: d.label,
    summaryHtml: d.summaryHtml,
    extra: d.extra,
    startTs: row.ts,
    endTs: null,
    durationMs: null,
    risk: row.risk,
    matchedRule: row.matched_rule || null,
    decision: row.decision,
    status: warn ? "warn" : "observed",
    reason: warn ? "bypass" : undefined,
    branch: false,
    eventIds: [row.id],
  };
}

function makeLifecycleNode(row, detail) {
  const d = fmt.describe(row.tool_name, row.source, detail);
  return {
    id: row.id,
    type: "lifecycle",
    tool: row.tool_name,
    source: row.source,
    label: d.label,
    summaryHtml: d.summaryHtml,
    extra: d.extra,
    startTs: row.ts,
    endTs: null,
    durationMs: null,
    risk: row.risk,
    matchedRule: row.matched_rule || null,
    decision: row.decision,
    status: "info",
    branch: false,
    eventIds: [row.id],
  };
}

function newTurn(idx, promptRow, promptDetail) {
  return {
    idx,
    prompt: promptRow
      ? { id: promptRow.id, ts: promptRow.ts, text: String((promptDetail && promptDetail.prompt) || ""), risk: promptRow.risk, matchedRule: promptRow.matched_rule || null }
      : null,
    startTs: promptRow ? promptRow.ts : null,
    endTs: null,
    stopped: false,
    subagentStops: 0,
    sessionStart: null,
    nodes: [],
  };
}

// Merges runs of GROUP_MIN or more operations that are "same tool, low risk, all succeeded" into one node, so 20
// consecutive Reads do not stretch the diagram; the details stay in items and the front end can expand them.
function groupRuns(nodes) {
  const out = [];
  let i = 0;
  const groupable = (n) => n.type === "op" && !n.branch && n.status === "ok" && QUIET_RISKS.has(n.risk);
  while (i < nodes.length) {
    const n = nodes[i];
    if (!groupable(n)) {
      out.push(n);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < nodes.length && groupable(nodes[j]) && nodes[j].tool === n.tool) j++;
    if (j - i >= GROUP_MIN) {
      const items = nodes.slice(i, j);
      const last = items[items.length - 1];
      out.push({
        id: "g" + n.id,
        type: "group",
        tool: n.tool,
        label: n.label,
        summaryHtml: n.summaryHtml,
        count: items.length,
        startTs: n.startTs,
        endTs: last.endTs || last.startTs,
        durationMs: null,
        risk: items.reduce((r, x) => worseRisk(r, x.risk), "-"),
        status: "ok",
        branch: false,
        items,
      });
    } else {
      for (let k = i; k < j; k++) out.push(nodes[k]);
    }
    i = j;
  }
  return out;
}

function buildSessionFlow(rows, { now = Date.now(), group = true } = {}) {
  const turns = [];
  let turn = newTurn(0, null, null);
  const openPre = new Map(); // tool_name -> [{node, key}]
  let sessionStart = null;

  const pushTurn = () => {
    if (turn.prompt || turn.nodes.length || turn.sessionStart) turns.push(turn);
  };

  for (const row of rows) {
    const detail = parseDetail(row);
    if (row.source === "hook_prompt") {
      pushTurn();
      turn = newTurn(turns.length, row, detail);
      continue;
    }
    if (row.source === "hook_lifecycle") {
      if (row.tool_name === "Stop") {
        turn.stopped = true;
        turn.endTs = row.ts;
      } else if (row.tool_name === "SubagentStop") {
        turn.subagentStops++;
      } else if (row.tool_name === "SessionStart" && !turn.prompt && !turn.sessionStart) {
        // A SessionStart before the first prompt is the "session started" title card itself; do not draw another card
        turn.sessionStart = { ts: row.ts, source: detail.source || null };
        if (!turn.startTs) turn.startTs = row.ts;
        if (!sessionStart) sessionStart = turn.sessionStart;
      } else {
        turn.nodes.push(makeLifecycleNode(row, detail));
      }
      continue;
    }
    if (OS_SOURCES.has(row.source)) {
      turn.nodes.push(makeOsNode(row, detail));
      continue;
    }
    if (!TOOL_EVENT_SOURCES.has(row.source)) continue;

    if (row.source === "hook_pre") {
      const node = makeOpNode({ pre: row, post: null, preDetail: detail, postDetail: null });
      node._pre = row;
      node._preDetail = detail;
      node._turn = turn;
      turn.nodes.push(node);
      // Blocked calls never get a hook_post, so they stay out of the pairing queue; otherwise the post of a later
      // identical retry would be paired with this blocked record
      if (row.decision !== "blocked") {
        if (!openPre.has(row.tool_name)) openPre.set(row.tool_name, []);
        openPre.get(row.tool_name).push({ node, key: canonical(detail) });
      }
      continue;
    }

    // hook_post: pick the most recent pre with identical input (when a failed call is retried as is, the post
    // belongs to the retry, not the earlier failure); if none, fall back to the most recent pre of the same tool
    const queue = openPre.get(row.tool_name) || [];
    const key = canonical(detail.input || {});
    let idx = queue.findLastIndex((q) => q.key === key);
    if (idx === -1 && queue.length) idx = queue.length - 1;
    if (idx !== -1) {
      const { node } = queue.splice(idx, 1)[0];
      const merged = makeOpNode({ pre: node._pre, post: row, preDetail: node._preDetail, postDetail: detail });
      merged._turn = node._turn;
      const list = node._turn.nodes;
      list[list.indexOf(node)] = merged;
    } else {
      const orphan = makeOpNode({ pre: null, post: row, preDetail: null, postDetail: detail });
      turn.nodes.push(orphan);
    }
  }
  pushTurn();

  // Operations that never got a hook_post: turn not over and session active recently → in progress; otherwise it did not succeed.
  const lastRow = rows[rows.length - 1];
  const lastMs = lastRow ? tsMs(lastRow.ts) : null;
  const sessionRecent = lastMs !== null && now - lastMs < RUNNING_WINDOW_MS;
  const lastTurn = turns[turns.length - 1];
  for (const t of turns) {
    for (const n of t.nodes) {
      if (n.status === "pending") {
        const live = t === lastTurn && !t.stopped && sessionRecent;
        n.status = live ? "running" : "fail";
        if (!live) n.reason = "noresult";
      }
      delete n._pre;
      delete n._preDetail;
      delete n._turn;
    }
    const stats = { ok: 0, warn: 0, fail: 0, blocked: 0, running: 0, background: 0, total: 0 };
    for (const n of t.nodes) {
      if (n.type !== "op") continue;
      stats.total++;
      if (stats[n.status] !== undefined) stats[n.status]++;
    }
    t.stats = stats;
    if (!t.endTs && t.nodes.length) {
      const lastNode = t.nodes[t.nodes.length - 1];
      t.endTs = lastNode.endTs || lastNode.startTs;
    }
    if (!t.startTs && t.nodes.length) t.startTs = t.nodes[0].startTs;
    if (group) t.nodes = groupRuns(t.nodes);
  }

  return {
    sessionStart,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: lastRow ? lastRow.ts : null,
    live: sessionRecent,
    turns,
  };
}

module.exports = { buildSessionFlow, postStatus, canonical };
