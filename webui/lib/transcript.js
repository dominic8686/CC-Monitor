"use strict";
// Claude Tap: JS port of cc_monitor/transcript.py. Parses Claude Code's local transcript
// (~/.claude/projects/.../<session>.jsonl) and turns the full conversation sent to and received from the model
// into HTML (coloured with CSS classes) for the Web UI to render. This is not packet capture: it reads files
// Claude Code has already written to local disk.
const fs = require("fs");
const fmt = require("./format");
const { escapeHtml, highlightBashHtml, highlightLogHtml } = fmt;

const KIND_LABEL = { user: "User", assistant: "Claude", system: "System" };

function normalizeContent(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object");
  return [];
}

function describeEntry(obj) {
  const etype = obj.type;
  const ts = obj.timestamp;
  const uuid = obj.uuid;

  if (etype === "user") {
    const msg = obj.message || {};
    return { kind: "user", ts, uuid, blocks: normalizeContent(msg.content), usage: null, model: null };
  }
  if (etype === "assistant") {
    const msg = obj.message || {};
    return {
      kind: "assistant",
      ts,
      uuid,
      blocks: normalizeContent(msg.content),
      usage: msg.usage || null,
      model: msg.model || null,
    };
  }
  if (etype === "attachment") {
    const att = obj.attachment || {};
    const text = att.text !== undefined ? att.text : JSON.stringify(att).slice(0, 500);
    return { kind: "system", ts, uuid, blocks: [{ type: "text", text }], usage: null, model: null };
  }
  return null;
}

function countLines(path) {
  try {
    const data = fs.readFileSync(path, "utf8");
    if (!data) return 0;
    return data.split("\n").filter((l) => l.length > 0).length;
  } catch (e) {
    return 0;
  }
}

// Reads from start_line (0-based: how many lines were already read) onward, returning at most limit parsed
// entries. Returns {entries, nextLine}. Uses a synchronous read and splits lines by hand, to avoid readline's
// async overhead for a small file (a transcript is usually a few hundred KB to a few MB; a sync read is fine).
function readEntries(path, startLine = 0, limit = 500) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return { entries: [], nextLine: startLine };
  }
  const lines = raw.split("\n");
  const entries = [];
  let nextLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    nextLine = i + 1;
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const entry = describeEntry(obj);
    if (entry) entries.push(entry);
    if (entries.length >= limit) break;
  }
  return { entries, nextLine };
}

// Used right after a session is selected, to show "what it has been doing lately" rather than paging from the
// first line. pollTap() used to read from since_line=0 the first time, however long the session had run; for a
// session running for days with tens of thousands of lines (such as a long-running Tesla analysis session) it
// showed messages from days ago, nothing "live". That was the root cause of the bug "it reads old content from
// the file, not the live conversation".
// Scans backward from the end of the file, stops once it has limit entries that parse, then returns them in
// chronological order. nextLine is set to the file's line count, so later polls continue from there: true live
// increments. This only runs once, when a session is first selected (not on every poll), so it reads the whole
// file to get exact line numbers instead of estimating from the tail bytes as getTokenStats does.
function readTailEntries(path, limit = 300) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return { entries: [], nextLine: 0 };
  }
  const lines = raw.split("\n");
  const nextLine = lines.length;
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const entry = describeEntry(obj);
    if (entry) entries.push(entry);
  }
  entries.reverse();
  return { entries, nextLine };
}

// Reads only the last few bytes of the file, so computing "recent throughput" does not read a multi-MB
// transcript in full. Cutting at an arbitrary byte offset usually leaves a truncated half line of JSON at the
// start; it fails to parse and is skipped. We only want an approximation of "the recent stretch", not an exact
// first message.
function readTail(path, maxBytes = 500000) {
  let fd;
  try {
    fd = fs.openSync(path, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch (e) {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        // ignore
      }
    }
  }
}

// Estimates token throughput (tokens per second) from the assistant turns in the recent window. This is not the
// exact per-token streaming rate (the transcript has no timestamps at that granularity); it is "roughly how fast
// these few turns averaged".
function getTokenStats(path) {
  if (!path) return null;
  const raw = readTail(path, 500000);
  const turns = [];
  // Bucket by model: switching models mid-session (for example from Sonnet to Opus) is common, so the same scan
  // groups by message.model and per-model usage stats need no second pass over the file.
  const byModel = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      continue;
    }
    if (obj.type === "assistant" && obj.message && obj.message.usage && obj.timestamp) {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t)) turns.push({ ts: t, usage: obj.message.usage });
      const model = obj.message.model || "unknown";
      const u = obj.message.usage;
      if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0 };
      const b = byModel[model];
      b.inputTokens += u.input_tokens || 0;
      b.outputTokens += u.output_tokens || 0;
      b.cacheReadTokens += u.cache_read_input_tokens || 0;
      b.cacheCreationTokens += u.cache_creation_input_tokens || 0;
      b.turns += 1;
    }
  }
  if (turns.length === 0) return null;

  const last = turns[turns.length - 1];
  const sum = (key) => turns.reduce((s, t) => s + (t.usage[key] || 0), 0);
  const totalIn = sum("input_tokens");
  const totalOut = sum("output_tokens");
  const totalCacheRead = sum("cache_read_input_tokens");
  // ccstatusline's "Cached" counts cache_read + cache_creation together, and "Total" adds input/output/cached.
  // This matches Claude Code's own token accounting; it is not an algorithm we invented.
  const totalCacheCreation = sum("cache_creation_input_tokens");
  const totalCached = totalCacheRead + totalCacheCreation;
  const totalTokens = totalIn + totalOut + totalCached;

  let outputTokensPerSec = null;
  let inputTokensPerSec = null;
  if (turns.length >= 2) {
    const spanSec = (last.ts - turns[0].ts) / 1000;
    if (spanSec > 0.5) {
      outputTokensPerSec = totalOut / spanSec;
      inputTokensPerSec = totalIn / spanSec;
    }
  }

  // "How much of the context window is used" is not the sum of all tokens in the session (that is "how much
  // money/tokens were spent in total", same as totalTokens); it is the context size the last turn actually
  // carried. Same algorithm as ccstatusline's getContextWindowMetrics(): input + cache_read + cache_creation,
  // last message only.
  const lu = last.usage;
  const contextTokens = (lu.input_tokens || 0) + (lu.cache_read_input_tokens || 0) + (lu.cache_creation_input_tokens || 0);

  return {
    lastUsage: last.usage,
    windowTurns: turns.length,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreationTokens: totalCacheCreation,
    totalCachedTokens: totalCached,
    totalTokens,
    contextTokens,
    outputTokensPerSec,
    inputTokensPerSec,
    byModel,
  };
}

// Context compaction: after Claude Code summarises and compacts the context (automatically or manually), the
// transcript gets a record with type="system" subtype="compact_boundary", whose compactMetadata holds the
// trigger (auto/manual) and the token counts before and after. Compaction events are sparse (usually zero to a
// few per session), so rather than reading only the tail we scan the whole file with a string pre-filter; the
// cost is small.
function getCompactionStats(path) {
  if (!path) return null;
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return null;
  }
  let count = 0;
  let autoCount = 0;
  let manualCount = 0;
  let cumulativeDroppedTokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes('"compact_boundary"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (obj.type !== "system" || obj.subtype !== "compact_boundary" || obj.isSidechain === true) continue;
    count += 1;
    const trigger = obj.compactMetadata?.trigger;
    if (trigger === "auto") autoCount += 1;
    else if (trigger === "manual") manualCount += 1;
    const dropped = obj.compactMetadata?.cumulativeDroppedTokens;
    if (typeof dropped === "number" && dropped > cumulativeDroppedTokens) cumulativeDroppedTokens = dropped;
  }
  if (count === 0) return { count: 0, autoCount: 0, manualCount: 0, cumulativeDroppedTokens: 0 };
  return { count, autoCount, manualCount, cumulativeDroppedTokens };
}

// The model the session is using now, for the UI: the **most recent** assistant turn in the transcript that has
// a model. It used to take the first one, so after a mid-session /model switch (say Sonnet to Opus) the session
// list kept showing the starting model and never updated. Searching backward from the end of the file gives
// "the current one"; in the edge case where the tail (500KB) has no assistant turn at all, fall back to scanning
// from the start. Cached by (path, mtime) and recomputed when the file changes, so polling does not reread the
// whole file.
const modelCache = new Map(); // path -> {mtime, model}
function modelFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
  if (obj.type === "assistant" && obj.message && obj.message.model) return obj.message.model;
  return null;
}

function getModel(path) {
  if (!path) return null;
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(path).mtimeMs;
  } catch (e) {
    return null;
  }
  const cached = modelCache.get(path);
  if (cached && cached.mtime === mtimeMs) return cached.model;

  let model = null;
  try {
    const tailLines = readTail(path, 500000).split("\n");
    for (let i = tailLines.length - 1; i >= 0 && model === null; i--) model = modelFromLine(tailLines[i]);
    if (model === null) {
      const lines = fs.readFileSync(path, "utf8").split("\n");
      for (let i = 0; i < lines.length && i < 400 && model === null; i++) model = modelFromLine(lines[i]);
    }
  } catch (e) {
    model = null;
  }
  modelCache.set(path, { mtime: mtimeMs, model });
  return model;
}

function collapse(text, limit = 500) {
  if (text === null || text === undefined) return "";
  let s = String(text).replace(/\r\n/g, " ⏎ ").replace(/\n/g, " ⏎ ");
  if (s.length > limit) return s.slice(0, limit) + `...(${s.length} chars total, truncated)`;
  return s;
}

// For JSON pretty output only: truncates by length only. Unlike collapse() it must not replace newlines with the
// " ⏎ " placeholder, or the indentation is destroyed, and then it is hardly "JSON formatting" any more.
function truncateKeepNewlines(text, limit = 4000) {
  if (text.length > limit) return text.slice(0, limit) + `\n...(${text.length} chars total, truncated)`;
  return text;
}

function renderBlockHtml(block) {
  const btype = block.type;
  if (btype === "text") {
    const text = (block.text || "").trim();
    if (!text) return "";
    return `<div class="tap-block tap-text">${escapeHtml(collapse(text, 2000))}</div>`;
  }
  if (btype === "thinking") {
    // The limit used to be 800 chars, so longer thinking was almost always cut to "...truncated"; it is now 20,000
    // chars (effectively "everything" for thinking, with a cap only for extreme cases). The front end's "show
    // details" toggle collapses/expands it: collapsed shows a few lines, expanded shows the full content given here.
    // Note: if this shows "(content omitted)", the thinking block in the transcript itself holds no text (Claude
    // Code did not write this thinking to disk). We did not cut it, and the toggle cannot help: with no data there
    // is nothing to show.
    const text = (block.thinking || "").trim();
    // This used to say "(content omitted)", which looked as if we had cut or hidden something, and users kept asking
    // "why is it still like this, fix the bug". In fact Claude Code never saved this thinking text to the local
    // transcript (it keeps only a signature for verification). No toggle or code fix can solve that, so the text
    // states the reason plainly rather than suggesting a bug on our side we could fix.
    const shown = text
      ? escapeHtml(collapse(text, 20000))
      : `<span class="tap-thinking-empty">(Claude Code did not save this thinking text locally, only its verification signature, so it cannot be shown)</span>`;
    return `<div class="tap-block tap-thinking">💭 Thinking: ${shown}</div>`;
  }
  if (btype === "tool_use") {
    const name = block.name || "?";
    const input = block.input || {};
    let bodyHtml;
    if (name === "Bash" && typeof input.command === "string") {
      bodyHtml = highlightBashHtml(collapse(input.command, 600));
    } else {
      bodyHtml = escapeHtml(collapse(JSON.stringify(input), 600));
    }
    return `<div class="tap-block tap-tool-use"><span class="tap-tool-name">🔧 ${escapeHtml(name)}</span>: ${bodyHtml}</div>`;
  }
  if (btype === "tool_result") {
    // A tool result in a "User" turn often has content that is not plain text but a structured object or array (for
    // example multi-part content with images). It used to be JSON.stringify'd onto one line: hundreds of characters
    // jammed together, unreadable. Structured content is now shown as indented JSON in its own monospace block;
    // plain strings still get the usual log highlighting, so readable text is not broken up just for consistency.
    const content = block.content;
    const isError = !!block.is_error;
    const cls = isError ? "tap-tool-result-error" : "tap-tool-result";
    const prefix = isError ? "✗ Tool result (error)" : "✓ Tool result";
    if (typeof content === "string") {
      const rendered = highlightLogHtml(collapse(content, 800));
      return `<div class="tap-block ${cls}"><span class="tap-tool-label">${prefix}</span>: ${rendered}</div>`;
    }
    const json = truncateKeepNewlines(JSON.stringify(content, null, 2), 4000);
    return `<div class="tap-block ${cls}"><span class="tap-tool-label">${prefix}</span>: <pre class="tap-json">${escapeHtml(json)}</pre></div>`;
  }
  if (btype === "image") {
    return `<div class="tap-block tap-image">🖼 [image content, not shown]</div>`;
  }
  return `<div class="tap-block tap-unknown">[${escapeHtml(btype)}]</div>`;
}

function renderEntryHtml(entry) {
  const blocksHtml = entry.blocks.map(renderBlockHtml).filter(Boolean).join("");
  let usageHtml = "";
  if (entry.kind === "assistant" && entry.usage) {
    const u = entry.usage;
    usageHtml = ` <span class="tap-usage">in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache_read=${u.cache_read_input_tokens || 0}</span>`;
  }
  return {
    kind: entry.kind,
    kindLabel: KIND_LABEL[entry.kind] || entry.kind,
    ts: entry.ts,
    usageHtml,
    blocksHtml,
  };
}

module.exports = { countLines, readEntries, readTailEntries, getModel, getTokenStats, getCompactionStats, renderEntryHtml };
