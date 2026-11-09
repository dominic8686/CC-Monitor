"use strict";
// JS port of cc_monitor/format.py + cc_monitor/colors.py: turns audit events into plain-language HTML fragments
// (coloured with CSS classes rather than terminal ANSI codes, because the target is a browser).

const TOOL_LABELS = {
  Bash: "Run shell command",
  Write: "Write file",
  Edit: "Edit file",
  MultiEdit: "Edit multiple files",
  NotebookEdit: "Edit notebook",
  Read: "Read file",
  Glob: "Find files",
  Grep: "Search file contents",
  WebFetch: "Fetch web page",
  WebSearch: "Web search",
  Task: "Start subagent",
  Agent: "Start subagent",
  TodoWrite: "Update task list",
  UserPromptSubmit: "User prompt submitted",
  SessionStart: "Session started",
  SessionEnd: "Session ended",
  PreCompact: "Before context compaction",
  Stop: "Main task finished",
  SubagentStop: "Subagent finished",
};

const STAGE_LABELS = {
  hook_pre: "About to run",
  hook_post: "Completed",
  hook_prompt: "User input",
  hook_lifecycle: "Lifecycle",
  os_exec: "Kernel observation",
  os_net: "Kernel observation",
};

const MAX_SUMMARY_LEN = 240;
const MAX_OUTPUT_LEN = 300;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collapse(text, limit = MAX_SUMMARY_LEN) {
  if (text === null || text === undefined) return "";
  let s = String(text).replace(/\r\n/g, " ⏎ ").replace(/\n/g, " ⏎ ");
  if (s.length > limit) return s.slice(0, limit) + `...(${s.length} chars total, truncated)`;
  return s;
}

// Simple Bash syntax highlighting: tags command names, arguments, strings, variables and pipes/redirects with CSS classes.
const SHELL_TOKEN_RE =
  /(?<comment>#[^⏎]*)|(?<dstring>"(?:[^"\\]|\\.)*")|(?<sstring>'[^']*')|(?<var>\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?*!$-])|(?<op>\|\||&&|;;|>>|<<|[|;&<>])|(?<flag>(?<!\S)--?[A-Za-z][\w-]*)|(?<glyph>⏎)|(?<word>[^\s|;&<>$'"#]+)|(?<space>\s+)|(?<other>.)/g;

// Rough check of whether a bare argument "looks like a file name". Only used by boldFiles mode (currently only
// the "file send operations" drill-down list turns it on). It does not try to pinpoint which argument of the
// command was actually sent (for example `scp -i key.pem file.txt user@host:/path` marks key.pem, file.txt and
// user@host:/path alike, without guessing which is the identity file and which is the file really sent; good
// enough). Two cases count as "file-like": it contains a path separator `/`; or it ends in an extension that
// starts with or contains a letter. Requiring at least one letter in the extension keeps the last numeric part
// of an IP (127.0.0.1), a port number or a version (v1.2.3) from being taken for an extension.
const FILE_EXT_RE = /\.([A-Za-z0-9]{1,8})$/;
function looksLikeFileArg(word) {
  if (!word || word.startsWith("-")) return false;
  if (word.includes("/")) return true;
  const m = FILE_EXT_RE.exec(word);
  return Boolean(m && /[A-Za-z]/.test(m[1]));
}

function highlightBashHtml(text, opts = {}) {
  if (!text) return "";
  const boldFiles = Boolean(opts.boldFiles);
  const out = [];
  let expectCommand = true;
  // The argument to cd is the new working directory, not a "sent file". But Claude Code prefixes almost every
  // Bash command with `cd <cwd>`, and that directory path contains `/`, so it always trips the looksLikeFileArg()
  // heuristic. Without skipping it, every record would bold the whole working directory and bury the files we
  // actually want to highlight. Skip only the first argument right after cd, then reset at once.
  let skipNextArgBold = false;
  const re = new RegExp(SHELL_TOKEN_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    const g = m.groups;
    const esc = escapeHtml(m[0]);
    if (g.comment) out.push(`<span class="tok-comment">${esc}</span>`);
    else if (g.dstring || g.sstring) out.push(`<span class="tok-string">${esc}</span>`);
    else if (g.var) out.push(`<span class="tok-var">${esc}</span>`);
    else if (g.op) {
      out.push(`<span class="tok-op">${esc}</span>`);
      expectCommand = true;
      skipNextArgBold = false;
    } else if (g.flag) out.push(`<span class="tok-flag">${esc}</span>`);
    else if (g.glyph) out.push(`<span class="tok-glyph">${esc}</span>`);
    else if (g.word) {
      if (expectCommand) {
        out.push(`<span class="tok-cmd">${esc}</span>`);
        expectCommand = false;
        skipNextArgBold = m[0] === "cd";
      } else if (boldFiles && !skipNextArgBold && looksLikeFileArg(m[0])) {
        out.push(`<strong class="tok-file">${esc}</strong>`);
        skipNextArgBold = false;
      } else {
        out.push(esc);
        skipNextArgBold = false;
      }
    } else out.push(esc);
    if (m.index === re.lastIndex) re.lastIndex += 1; // avoid an infinite loop on zero-width matches
  }
  return out.join("");
}

// Simple highlighting for command output/logs: error/warning/success keywords and file paths.
const LOG_TOKEN_RE =
  /(?<error>\b(?:error|exception|traceback|fatal|failed?|panic|denied|refused)\b|错误|异常|失败|拒绝)|(?<warn>\b(?:warn(?:ing)?|deprecated)\b|警告)|(?<ok>\b(?:success(?:ful)?|passed|done|ok)\b|成功|完成)|(?<path>(?:(?<=\s)|^)\/[\w./-]+|\b[\w.-]+\.(?:py|js|ts|json|sh|log|txt|md|yaml|yml|c|cpp|h|go|rs)\b)|(?<glyph>⏎)/gi;

function highlightLogHtml(text) {
  if (!text) return "";
  const out = [];
  let last = 0;
  const re = new RegExp(LOG_TOKEN_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(escapeHtml(text.slice(last, m.index)));
    const g = m.groups;
    const tok = escapeHtml(m[0]);
    if (g.error) out.push(`<span class="tok-error">${tok}</span>`);
    else if (g.warn) out.push(`<span class="tok-warn">${tok}</span>`);
    else if (g.ok) out.push(`<span class="tok-ok">${tok}</span>`);
    else if (g.path) out.push(`<span class="tok-path">${tok}</span>`);
    else if (g.glyph) out.push(`<span class="tok-glyph">${tok}</span>`);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  out.push(escapeHtml(text.slice(last)));
  return out.join("");
}

function splitDetail(source, detail) {
  detail = detail || {};
  if (source === "hook_post") return [detail.input || {}, detail.response || null];
  return [detail, null];
}

function stageLabel(source) {
  return STAGE_LABELS[source] || source || "-";
}

function describeOsExec(comm, detail) {
  detail = detail || {};
  const label = `System-layer observation: process exec (${escapeHtml(comm)})`;
  const summaryHtml = highlightBashHtml(collapse(detail.argv || ""));
  const extra = [];
  if (detail.shell_command) {
    if (detail.hook_matched === false) {
      extra.push({ cls: "warn", label: null, html: "⚠ No matching hook record; monitoring may have been bypassed" });
    } else if (detail.hook_matched === true) {
      extra.push({ cls: "ok", label: null, html: "✓ Matches the hook record" });
    }
  }
  return { label, summaryHtml, extra };
}

function describeOsNet(comm, detail) {
  detail = detail || {};
  const { ip = "", port = "", host } = detail;
  const summary = `${ip}:${port}` + (host ? ` (${host})` : "");
  return { label: `System-layer observation: network connection (${escapeHtml(comm)})`, summaryHtml: escapeHtml(summary), extra: [] };
}

function genericFieldSummary(toolInput) {
  for (const [k, v] of Object.entries(toolInput)) {
    if (v) return escapeHtml(`${k}=${collapse(v)}`);
  }
  return "";
}

function describe(toolName, source, detail, opts = {}) {
  if (source === "os_exec") return describeOsExec(toolName, detail);
  if (source === "os_net") return describeOsNet(toolName, detail);

  const [toolInput, response] = splitDetail(source, detail);
  const label = TOOL_LABELS[toolName] || toolName || "Unknown operation";
  let summaryHtml = "";
  const extra = [];

  if (toolName === "Bash") {
    summaryHtml = highlightBashHtml(collapse(toolInput.command || ""), opts);
    if (response) {
      const stderr = (response.stderr || "").trim();
      const interrupted = !!response.interrupted;
      const ok = !interrupted && !stderr;
      extra.push({ cls: ok ? "ok" : "error", label: "Result", html: ok ? "Success" : "Failed or had error output" });
      const tailSrc = (response.stdout || "").trim() || stderr;
      if (tailSrc) {
        extra.push({ cls: null, label: "Output", html: highlightLogHtml(collapse(tailSrc.slice(-MAX_OUTPUT_LEN))) });
      }
    }
  } else if (toolName === "Write" || toolName === "NotebookEdit") {
    const p = toolInput.file_path || toolInput.notebook_path || "";
    const content = toolInput.content || toolInput.new_source || "";
    summaryHtml = escapeHtml(`${p} (${String(content).length} bytes)`);
  } else if (toolName === "Edit" || toolName === "MultiEdit") {
    const p = toolInput.file_path || "";
    const oldS = toolInput.old_string || "";
    const newS = toolInput.new_string || "";
    summaryHtml = escapeHtml(`${p} (-${oldS.length} / +${newS.length} chars)`);
  } else if (toolName === "Read") {
    summaryHtml = escapeHtml(toolInput.file_path || "");
  } else if (toolName === "Glob" || toolName === "Grep") {
    const pattern = toolInput.pattern || "";
    const p = toolInput.path;
    summaryHtml = escapeHtml(pattern + (p ? `  (path: ${p})` : ""));
  } else if (toolName === "WebFetch") {
    summaryHtml = escapeHtml(toolInput.url || "");
  } else if (toolName === "WebSearch") {
    summaryHtml = escapeHtml(toolInput.query || "");
  } else if (toolName === "Task" || toolName === "Agent") {
    summaryHtml = escapeHtml(collapse(toolInput.description || toolInput.prompt || ""));
  } else if (toolName === "UserPromptSubmit") {
    summaryHtml = escapeHtml(collapse(toolInput.prompt || ""));
  } else if (toolName === "SessionStart" || toolName === "SessionEnd" || toolName === "PreCompact") {
    summaryHtml = escapeHtml(toolInput.source || toolInput.reason || toolInput.trigger || "-");
    if (toolName === "PreCompact" && toolInput.custom_instructions) {
      extra.push({ cls: null, label: "Custom compaction instructions", html: escapeHtml(collapse(toolInput.custom_instructions)) });
    }
  } else if (toolName === "Stop" || toolName === "SubagentStop") {
    summaryHtml = escapeHtml(`stop_hook_active: ${!!toolInput.stop_hook_active}`);
  } else if (toolName === "Artifact" && opts.boldFiles) {
    // The Artifact tool would otherwise fall through to the generic fallback below (show the first non-empty field
    // as is). The "file send operations" drill-down wants to mark exactly which file was sent, so pick out
    // file_path/file_paths and bold them for that view only. Elsewhere (for example the MCP call list) Artifact
    // events keep the default display.
    const f = toolInput.file_path || (Array.isArray(toolInput.file_paths) && toolInput.file_paths[0]) || "";
    if (f) {
      const wrapped = `<strong class="tok-file">${escapeHtml(f)}</strong>`;
      summaryHtml = toolInput.asset === true ? `asset upload: ${wrapped}` : `file_path=${wrapped}`;
    } else {
      summaryHtml = genericFieldSummary(toolInput);
    }
  } else {
    summaryHtml = genericFieldSummary(toolInput);
  }
  return { label, summaryHtml, extra };
}

module.exports = { describe, stageLabel, escapeHtml, TOOL_LABELS, highlightBashHtml, highlightLogHtml, collapse };
