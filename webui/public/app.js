"use strict";

// Called without arguments, toLocaleTimeString() picks 12-hour ("7:48:25 PM") or 24-hour time
// from the browser locale, not from this app's own language toggle. Always use 24-hour time,
// whichever UI language is selected, so the format does not drift with the browser/OS locale.
function fmtTime24(date) {
  return date.toLocaleTimeString(undefined, { hour12: false });
}
function fmtDateTime24(date) {
  return date.toLocaleString(undefined, { hour12: false });
}

const RISK_COLOR = { high: "var(--red)", medium: "var(--yellow)", low: "var(--green)", info: "var(--cyan)", "-": "var(--text-dim)" };
const DECISION_COLOR = { blocked: "var(--red)", allowed: "var(--green)", completed: "var(--accent)", observed: "var(--cyan)" };
const KNOWN_TOOLS = new Set([
  "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
  "UserPromptSubmit", "SessionStart", "SessionEnd", "PreCompact", "Stop", "SubagentStop",
]);

function decisionLabel(decision) {
  return t("decision." + decision) || decision;
}
function sourceLabel2(source) {
  return t("source." + source) || source;
}
function riskLabel(risk) {
  return t("risk." + risk) || risk;
}
function stageLabel2(source) {
  return t("stage." + source) || source;
}
// Translate tool names (Bash/Write/...) when we can; compound labels the server builds, such as
// system-layer observation events and unknown/custom tools, stay as sent for now (fallback); not every one is bilingual.
function toolLabel(toolName, serverLabel) {
  return KNOWN_TOOLS.has(toolName) ? t("tool." + toolName) : serverLabel;
}
// Keys are the labels the server emits; the Chinese ones stay so older server builds still match.
const EXTRA_LABEL_MAP = {
  Result: "extra.result",
  Output: "extra.output",
  "Custom compaction instructions": "extra.compactInstructions",
  结果: "extra.result",
  输出: "extra.output",
  自定义压缩指令: "extra.compactInstructions",
};
function translateExtraLabel(label) {
  return EXTRA_LABEL_MAP[label] ? t(EXTRA_LABEL_MAP[label]) : label;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatUptime(ms) {
  const mins = Math.floor(ms / 60000);
  return mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins });
}

// "Last active" wording is not the same as formatUptime() ("running for N minutes"): here we
// want "last activity N minutes/hours/days ago", ending in "ago", so it cannot share an i18n key.
// Sessions often sit untouched for hundreds of minutes or days, and a minute count alone gets
// meaninglessly large ("3887 minutes ago"), so past 60 minutes switch to hours and past 24 hours to days.
function formatAgo(ms) {
  if (ms === null || ms === undefined) return "-";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return t("terminal.justNow");
  if (mins < 60) return t("drilldown.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("drilldown.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("drilldown.daysAgo", { n: days });
}

// Duration (seconds) -> "7 d 12 h" / "3 h 42 min". Unlike formatAgo this describes a span of
// time, not "how long ago", so there is no "ago".
function formatDuration(sec) {
  if (sec === null || sec === undefined) return "-";
  if (sec < 60) return t("drilldown.duration.seconds", { s: Math.floor(sec) });
  const mins = Math.floor(sec / 60);
  if (mins < 60) return t("drilldown.duration.minutes", { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("drilldown.duration.hours", { h: hours, m: mins % 60 });
  return t("drilldown.duration.days", { d: Math.floor(hours / 24), h: hours % 24 });
}

// "Vital signs" indicator: working/idle/dead share one heart-monitor visual; see the comment
// at the top of style.css. The heart and the sawtooth wave are generic symbols, not copied from any icon library.
const VITAL_HEART_PATH =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
const VITAL_ECG_PATH = "M0,7 L11,7 L14,1 L18,13 L21,7 L26,7 L29,3 L32,11 L35,7 L40,7";
const VITAL_ECG_FLAT_PATH = "M0,7 L40,7";
const VITAL_FADE_MS = 60 * 60 * 1000; // colour/waveform fade continuously over 1 hour
const VITAL_WORKING_MS = 5 * 60 * 1000; // beat/scroll animation only within this window; matches the backend WORKING_THRESHOLD_MS
// idle (process still alive, just quiet lately) keeps a faint tint even past the 1-hour fade
// window. Otherwise a session left open without activity looks exactly like a dead one (process
// exited), which defeats the point of telling "alive but idle" apart from "gone" (real sessions
// often sit for hundreds of minutes or days, so most rows land in this range). dead has no tint; it is plain grey.
const VITAL_IDLE_FLOOR = 0.14;

// heat: 0..1, closer to 1 the smaller agoMs is (deepest red / largest swing). For working/idle it
// fades linearly over 1 hour; idle stops at VITAL_IDLE_FLOOR after fading instead of dropping to 0
// like dead. dead, or no timestamp at all (unknown time since last activity), counts as 0.
function vitalHeat(status, agoMs) {
  if (status === "dead" || agoMs === null || agoMs === undefined) return 0;
  const raw = Math.max(0, 1 - agoMs / VITAL_FADE_MS);
  return status === "idle" ? Math.max(raw, VITAL_IDLE_FLOOR) : raw;
}

function hexToRgb(hex) {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// Interpolating between red and grey by heat used to be left to CSS color-mix(). In browsers
// without color-mix() the whole property fails to compute and working/idle/dead all fall back to
// the same inherited colour (everything looks grey, even a freshly active working session, which is
// exactly the reported bug). So we no longer depend on color-mix(): JS reads the theme colours and
// computes the interpolated rgb() itself; compatibility then only depends on getComputedStyle.
function vitalColor(heat) {
  const cs = getComputedStyle(document.documentElement);
  const red = hexToRgb(cs.getPropertyValue("--red")) || [239, 68, 68];
  const dim = hexToRgb(cs.getPropertyValue("--text-dim")) || [122, 128, 148];
  const r = Math.round(dim[0] + (red[0] - dim[0]) * heat);
  const g = Math.round(dim[1] + (red[1] - dim[1]) * heat);
  const b = Math.round(dim[2] + (red[2] - dim[2]) * heat);
  return `rgb(${r}, ${g}, ${b})`;
}

function renderVital(status, agoMs) {
  const s = status || "idle";
  const label = t("terminal.status." + s);
  const heat = vitalHeat(s, agoMs);
  // Whether the ECG goes flat depends on the real elapsed time (flat after a full hour), which is
  // not the same as the tinted heat above. heat<=0.02 no longer works: with the idle tint, heat never
  // actually reaches 0, so check agoMs directly.
  const flat = s === "dead" || agoMs === null || agoMs === undefined || agoMs >= VITAL_FADE_MS;
  const animated = s === "working" && agoMs !== null && agoMs !== undefined && agoMs < VITAL_WORKING_MS;
  const cls = ["vital", `vital-${s}`, animated ? "vital-animated" : "", flat ? "vital-flat" : ""].filter(Boolean).join(" ");
  const style = `--vital-heat:${heat.toFixed(2)};--vital-color:${vitalColor(heat)}`;
  return `
    <span class="${cls}" style="${style}" title="${escapeHtml(label)}">
      <svg class="vital-heart" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${VITAL_HEART_PATH}"/></svg>
      <svg class="vital-ecg" viewBox="0 0 40 14" aria-hidden="true"><path d="${flat ? VITAL_ECG_FLAT_PATH : VITAL_ECG_PATH}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>
    </span>`;
}

// ---------- Error banner: visible feedback when the network/API fails, instead of silently doing nothing ----------
const errorBanner = document.getElementById("error-banner");
let errorHideTimer = null;
function showError(message) {
  errorBanner.textContent = "";
  const span = document.createElement("span");
  span.textContent = "⚠ " + message;
  const btn = document.createElement("button");
  btn.textContent = t("error.ack");
  btn.addEventListener("click", hideError);
  errorBanner.appendChild(span);
  errorBanner.appendChild(btn);
  errorBanner.hidden = false;
  clearTimeout(errorHideTimer);
  errorHideTimer = setTimeout(hideError, 8000);
}
function hideError() {
  errorBanner.hidden = true;
  clearTimeout(errorHideTimer);
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    showError(t("error.fetchFailed", { msg: e.message }));
    return null;
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (e) {
      // ignore
    }
    showError(t("error.requestFailed", { status: res.status, path, detail: detail ? "：" + detail : "" }));
    return null;
  }
  return res.json();
}

// ---------- Generic confirmation dialog (replaces window.confirm, styled like the page) ----------
const confirmModal = document.getElementById("confirm-modal");
function confirmDialog(title, body) {
  return new Promise((resolve) => {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-body").textContent = body;
    confirmModal.hidden = false;
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    const cleanup = (result) => {
      confirmModal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ---------- Top navigation / page switching ----------
document.querySelectorAll(".tab-btn:not(.nav-external-link)").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn:not(.nav-external-link)").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "terminal") {
      setTimeout(() => {
        fitAddon.fit();
        for (const pane of gridPanes.values()) pane.fitAddon.fit();
      }, 30);
    }
    if (btn.dataset.tab === "archives") refreshArchivesList();
    if (btn.dataset.tab === "approvals") {
      syncApprovalsNotifyBtn();
      refreshApprovalHistory();
    }
    if (btn.dataset.tab === "network") {
      // The WebGL canvas can only measure its size with getBoundingClientRect() once the container is
      // really visible (.view.active, not display:none), so the map instance is created the first time
      // this tab is actually opened, then immediately refreshed with the current data.
      ensureNetworkMap();
      refreshNetworkTraffic();
    }
    // Same for the canvas: it has no width while hidden, so create it on first entry
    if (btn.dataset.tab === "timeline") refreshTimeline();
  });
});

// ---------- Terminal rendering: prefer WebGL (GPU), fall back to the default Canvas renderer on failure ----------
const term = new Terminal({
  fontFamily: "Menlo, Consolas, 'Courier New', monospace",
  fontSize: 13,
  cursorBlink: true,
  theme: { background: "#000000", foreground: "#d8dce6" },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));

const gpuPill = document.getElementById("gpu-status");
let gpuState = "detecting"; // on a language switch, re-apply the text for the current state
function setGpuState(state) {
  gpuState = state;
  const map = { detecting: "gpu.detecting", webgl: "gpu.webgl", canvasNoWebgl: "gpu.canvasNoWebgl", canvasLost: "gpu.canvasLost" };
  gpuPill.textContent = t(map[state]);
  gpuPill.className = "pill" + (state === "webgl" ? " gpu" : state === "detecting" ? "" : " cpu");
}
function tryEnableWebgl() {
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      setGpuState("canvasLost");
    });
    term.loadAddon(webgl);
    setGpuState("webgl");
  } catch (e) {
    setGpuState("canvasNoWebgl");
  }
}
tryEnableWebgl();
fitAddon.fit();
window.addEventListener("resize", () => {
  fitAddon.fit();
  for (const pane of gridPanes.values()) pane.fitAddon.fit();
});

// ---------- Session management (Terminals page) ----------
let currentSessionId = null;
let currentSocket = null;

// Reloading the page only reloads this JS runtime; the PTY session is still alive on the server.
// But currentSessionId is a plain variable that resets on reload, so the UI looks as if the session
// were gone and you had to click it in the sidebar again. Keep a copy in localStorage and reconnect to it after reload.
const LAST_SESSION_KEY = "cc-monitor-last-session-id";
function rememberLastSession(id) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch (e) {
    // localStorage unavailable (private mode etc.) does not break anything; we just do not reconnect after reload
  }
}
function getLastSession() {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch (e) {
    return null;
  }
}

async function refreshSessionList() {
  const sessions = await api("/api/sessions");
  if (!sessions) return [];
  syncGridPanes(sessions);
  const list = document.getElementById("session-list");
  list.innerHTML = "";
  if (sessions.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("terminal.sessionListEmpty")}</div>`;
    return sessions;
  }
  for (const s of sessions) {
    const el = document.createElement("div");
    el.className = "session-item" + (s.id === currentSessionId ? " active" : "") + (s.alive ? "" : " dead");
    const status = s.status || (s.alive ? "idle" : "dead");
    el.innerHTML = `
      <div class="cwd">${s.alive ? `<span class="status-dot status-${status}" title="${escapeHtml(t("terminal.status." + status))}"></span>` : ""}${escapeHtml(s.cwd)}</div>
      <div class="meta">
        <span>${fmtTime24(new Date(s.createdAt))} ${s.alive ? "" : t("terminal.exited")}</span>
        <span class="kill-btn" data-id="${s.id}">${t("terminal.close")}</span>
      </div>`;
    el.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("kill-btn")) return;
      selectSession(s.id);
    });
    el.querySelector(".kill-btn").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const ok = await confirmDialog(t("modal.killSession.title"), t("modal.killSession.body", { cwd: s.cwd }));
      if (!ok) return;
      await api("/api/sessions/" + s.id, { method: "DELETE" });
      if (currentSessionId === s.id) {
        currentSessionId = null;
        rememberLastSession(null);
        term.reset();
        document.getElementById("terminal-empty").style.display = "flex";
        document.getElementById("terminal-statusline").innerHTML = "";
      }
      refreshSessionList();
    });
    list.appendChild(el);
  }
  return sessions;
}

function selectSession(id) {
  currentSessionId = id;
  rememberLastSession(id);
  document.getElementById("terminal-empty").style.display = "none";
  term.reset();
  if (currentSocket) currentSocket.close();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?id=${id}`);
  currentSocket = ws;

  ws.addEventListener("open", () => {
    fitAddon.fit();
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") term.write(msg.data);
    else if (msg.type === "exit") term.write(`\r\n${t("terminal.sessionEnded", { code: msg.exitCode })}\r\n`);
    else if (msg.type === "error") term.write(`\r\n[${msg.message}]\r\n`);
  });
  ws.addEventListener("close", () => {
    if (currentSocket === ws) showError(t("terminal.connectionLost"));
  });

  refreshSessionList();
  refreshTerminalStatusline();
}

term.onData((data) => {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({ type: "input", data }));
  }
});
term.onResize(({ cols, rows }) => {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({ type: "resize", cols, rows }));
  }
});

// ---------- Terminal grid view (herdr style: watch/drive several agents on one screen) ----------
// Separate Terminal instances + WebSocket connections from the single-session view above; they do not
// affect each other, and switching views does not interrupt sessions running in the other one.
const gridPanes = new Map(); // sessionId -> { term, fitAddon, ws, el }
let gridModeEnabled = false;
let activeGridPaneId = null;

function computeGridCols(n) {
  if (n <= 2) return n || 1;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  return 4;
}

function createGridPane(s) {
  const el = document.createElement("div");
  el.className = "grid-pane";
  el.innerHTML = `
    <div class="grid-pane-header" title="${escapeHtml(s.cwd)}">
      <span class="status-dot status-${s.status || "idle"}" data-role="status-dot" title="${escapeHtml(t("terminal.status." + (s.status || "idle")))}"></span>
      <span class="name">${escapeHtml(folderName(s.cwd))} · ${s.id.slice(0, 8)}…</span>
      <span class="kill-btn">${t("terminal.close")}</span>
    </div>
    <div class="grid-pane-body"></div>
  `;
  const bodyEl = el.querySelector(".grid-pane-body");
  const header = el.querySelector(".grid-pane-header");

  const paneTerm = new Terminal({
    fontFamily: "Menlo, Consolas, 'Courier New', monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: "#000000", foreground: "#d8dce6" },
  });
  const paneFit = new FitAddon.FitAddon();
  paneTerm.loadAddon(paneFit);
  paneTerm.open(bodyEl);
  try {
    // Browsers cap the number of live WebGL contexts (usually a dozen or so). With many grid panes,
    // when we cannot get one we fall back to xterm.js's default canvas renderer: it still works, just slower.
    paneTerm.loadAddon(new WebglAddon.WebglAddon());
  } catch (e) {
    // ignore; canvas is the fallback
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?id=${s.id}`);
  ws.addEventListener("open", () => {
    paneFit.fit();
    ws.send(JSON.stringify({ type: "resize", cols: paneTerm.cols, rows: paneTerm.rows }));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") paneTerm.write(msg.data);
    else if (msg.type === "exit") paneTerm.write(`\r\n${t("terminal.sessionEnded", { code: msg.exitCode })}\r\n`);
    else if (msg.type === "error") paneTerm.write(`\r\n[${msg.message}]\r\n`);
  });
  paneTerm.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  });
  paneTerm.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  const focusPane = () => {
    for (const p of gridPanes.values()) p.el.classList.remove("active");
    el.classList.add("active");
    activeGridPaneId = s.id;
    paneTerm.focus();
  };
  header.addEventListener("click", focusPane);
  bodyEl.addEventListener("mousedown", focusPane);

  header.querySelector(".kill-btn").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const ok = await confirmDialog(t("modal.killSession.title"), t("modal.killSession.body", { cwd: s.cwd }));
    if (!ok) return;
    await api("/api/sessions/" + s.id, { method: "DELETE" });
    refreshSessionList();
  });

  return { term: paneTerm, fitAddon: paneFit, ws, el, focusPane };
}

function destroyGridPane(pane) {
  try {
    pane.ws.close();
  } catch (e) {
    // ignore
  }
  try {
    pane.term.dispose();
  } catch (e) {
    // ignore
  }
  pane.el.remove();
}

function syncGridPanes(sessions) {
  if (!gridModeEnabled) return;
  const grid = document.getElementById("terminal-grid");
  const aliveIds = new Set(sessions.filter((s) => s.alive).map((s) => s.id));

  for (const [id, pane] of gridPanes) {
    if (!aliveIds.has(id)) {
      destroyGridPane(pane);
      gridPanes.delete(id);
      if (activeGridPaneId === id) activeGridPaneId = null;
    }
  }

  if (grid.querySelector(".grid-empty")) grid.innerHTML = "";

  let firstNew = null;
  for (const s of sessions) {
    if (s.alive && !gridPanes.has(s.id)) {
      const pane = createGridPane(s);
      gridPanes.set(s.id, pane);
      grid.appendChild(pane.el);
      if (!firstNew) firstNew = pane;
    } else if (s.alive && gridPanes.has(s.id)) {
      // Existing panes are not rebuilt, only their status dot is updated: createGridPane() runs only the
      // first time a pane appears; on each later poll this keeps working/blocked/idle up to date.
      const dot = gridPanes.get(s.id).el.querySelector('[data-role="status-dot"]');
      if (dot) {
        const status = s.status || "idle";
        dot.className = "status-dot status-" + status;
        dot.title = t("terminal.status." + status);
      }
    }
  }

  grid.style.setProperty("--grid-cols", computeGridCols(gridPanes.size));
  if (gridPanes.size === 0) {
    grid.innerHTML = `<div class="grid-empty">${t("terminal.gridEmpty")}</div>`;
  } else if (!activeGridPaneId && firstNew) {
    firstNew.focusPane();
  }

  requestAnimationFrame(() => {
    for (const pane of gridPanes.values()) pane.fitAddon.fit();
  });
}

// This button's text follows the gridModeEnabled state, so it cannot use a static data-i18n
// (otherwise a language switch makes applyStaticI18n reset it to "Switch to grid view" whichever view is active).
function syncGridToggleBtnText() {
  document.getElementById("grid-toggle-btn").textContent = t(gridModeEnabled ? "terminal.toSingle" : "terminal.toGrid");
}

document.getElementById("grid-toggle-btn").addEventListener("click", async () => {
  gridModeEnabled = !gridModeEnabled;
  const single = document.getElementById("terminal-wrap");
  const statusline = document.getElementById("terminal-statusline");
  const grid = document.getElementById("terminal-grid-pane");
  syncGridToggleBtnText();
  if (gridModeEnabled) {
    single.hidden = true;
    statusline.hidden = true;
    grid.hidden = false;
    syncGridPanes(await refreshSessionList());
  } else {
    single.hidden = false;
    statusline.hidden = false;
    grid.hidden = true;
  }
});

const newSessionModal = document.getElementById("new-session-modal");
const newSessionCwdInput = document.getElementById("new-session-cwd");
const newSessionTitleEl = document.getElementById("new-session-title");
const newSessionHintEl = document.getElementById("new-session-hint");
// "New session" (types claude automatically) and "new window" (plain shell, no Claude Code) share one
// dialog: picking a directory is identical for both, so two dialogs would be pointless. This variable
// remembers which button opened it; the title/description follow it, and on confirm it decides whether
// launchClaude:false is sent to the backend.
let newSessionLaunchClaude = true;

// The dialog title/description are picked from the newSessionLaunchClaude state, not translated purely
// through static data-i18n attributes: on a language switch applyStaticI18n() would reset them to the
// default text hard-coded in data-i18n (the new-session version). Same reasoning as
// syncGridToggleBtnText() and the other state-dependent text functions: after a language switch the
// text for the current state has to be re-applied separately.
function syncNewSessionModalText() {
  if (newSessionModal.hidden) return;
  newSessionTitleEl.textContent = newSessionLaunchClaude ? t("modal.newSession.title") : t("modal.newWindow.title");
  newSessionHintEl.innerHTML = newSessionLaunchClaude ? t("modal.newSession.hint") : t("modal.newWindow.hint");
}
function openNewSessionModal(launchClaude) {
  newSessionLaunchClaude = launchClaude;
  newSessionCwdInput.value = "";
  newSessionModal.hidden = false;
  syncNewSessionModalText();
  newSessionCwdInput.focus();
}
document.getElementById("new-session-btn").addEventListener("click", () => openNewSessionModal(true));
document.getElementById("new-window-btn").addEventListener("click", () => openNewSessionModal(false));
document.getElementById("new-session-cancel").addEventListener("click", () => {
  newSessionModal.hidden = true;
});
newSessionModal.addEventListener("click", (ev) => {
  if (ev.target === newSessionModal) newSessionModal.hidden = true; // clicking the backdrop closes it
});
async function createSessionFromModal() {
  const cwd = newSessionCwdInput.value.trim();
  const launchClaude = newSessionLaunchClaude;
  newSessionModal.hidden = true;
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: cwd || undefined, launchClaude }),
  });
  if (!session) return;
  await refreshSessionList();
  selectSession(session.id);
}
document.getElementById("new-session-confirm").addEventListener("click", createSessionFromModal);
newSessionCwdInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") createSessionFromModal();
});

// ---------- Folder browser in the "new session" dialog: picks a directory on the server, not on the browser's machine ----------
// This terminal opens a shell on the machine running the webui, so the directory must be a path on
// that machine. A native <input type=file webkitdirectory> picks files on the machine running the
// browser; when the Web UI is accessed remotely those are not the same machine and the path is
// meaningless. So this is our own server-side directory listing API + a simple list UI, not a native browser control.
const dirBrowserModal = document.getElementById("dir-browser-modal");
const dirBrowserPathEl = document.getElementById("dir-browser-path");
const dirBrowserListEl = document.getElementById("dir-browser-list");
let dirBrowserCurrentPath = "";

async function loadDirBrowser(targetPath) {
  const result = await api("/api/browse-dir?path=" + encodeURIComponent(targetPath || ""));
  if (!result) return;
  dirBrowserCurrentPath = result.path;
  dirBrowserPathEl.textContent = result.path;
  const rows = [];
  if (result.parent) {
    rows.push(`<div class="dir-browser-item dir-browser-up" data-path="${escapeHtml(result.parent)}">⬆ ..</div>`);
  }
  for (const name of result.dirs) {
    const full = result.path.replace(/\/$/, "") + "/" + name;
    rows.push(`<div class="dir-browser-item" data-path="${escapeHtml(full)}">📁 ${escapeHtml(name)}</div>`);
  }
  dirBrowserListEl.innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty-state">${t("modal.dirBrowser.empty")}</div>`;
  dirBrowserListEl.querySelectorAll(".dir-browser-item").forEach((el) => {
    el.addEventListener("click", () => loadDirBrowser(el.dataset.path));
  });
}
document.getElementById("new-session-browse-btn").addEventListener("click", () => {
  dirBrowserModal.hidden = false;
  loadDirBrowser(newSessionCwdInput.value.trim());
});
document.getElementById("dir-browser-close").addEventListener("click", () => (dirBrowserModal.hidden = true));
document.getElementById("dir-browser-cancel").addEventListener("click", () => (dirBrowserModal.hidden = true));
document.getElementById("dir-browser-select").addEventListener("click", () => {
  newSessionCwdInput.value = dirBrowserCurrentPath;
  dirBrowserModal.hidden = true;
});
dirBrowserModal.addEventListener("click", (ev) => {
  if (ev.target === dirBrowserModal) dirBrowserModal.hidden = true;
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!newSessionModal.hidden) newSessionModal.hidden = true;
  if (!dirBrowserModal.hidden) dirBrowserModal.hidden = true;
  if (!confirmModal.hidden) document.getElementById("confirm-cancel").click();
  if (!drilldownModal.hidden) drilldownModal.hidden = true;
});

// Status bar above the selected session (cwd / git branch / uptime), from /api/status.
async function refreshTerminalStatusline() {
  if (!currentSessionId) return;
  const status = await api("/api/status");
  if (!status) return;
  const s = status.liveSessions.find((x) => x.id === currentSessionId);
  const el = document.getElementById("terminal-statusline");
  if (!s) {
    el.innerHTML = "";
    return;
  }
  const mins = Math.floor(s.uptimeMs / 60000);
  el.innerHTML = `
    <span class="seg ${s.alive ? "alive" : "dead"}">${s.alive ? t("terminal.running") : t("terminal.stopped")}</span>
    <span class="seg cwd">📁 ${escapeHtml(s.cwd)}</span>
    ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
    <span class="seg">⏱ ${mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins })}</span>
  `;
}

// ---------- Audit Log page ----------
let lastLogId = 0;
const logFilter = document.getElementById("log-session-filter");

// A session id alone does not identify the session: several 8-digit hex strings on one screen look
// alike. Prefixing the folder name (last cwd segment) and the short model name gives the information
// people actually use to tell sessions apart; the full cwd and id go in title, visible on hover.
function folderName(cwd) {
  if (!cwd) return "(unknown directory)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}
// Prefix the Session ID with the folder name: a truncated UUID alone does not tell you which session
// it is, and folderName(cwd) is usually far easier to remember than session_id, so show both
// (when the table is narrow the full cwd still has its own column/title).
function sessionIdCell(sessionId, cwd) {
  const idPart = sessionId ? escapeHtml(sessionId.slice(0, 8)) + "…" : "-";
  if (!cwd) return idPart;
  return `${escapeHtml(folderName(cwd))} · ${idPart}`;
}
function modelShort(model) {
  if (!model) return "";
  return model.replace(/^claude-/, "");
}
function sessionLabel(r) {
  const folder = folderName(r.cwd);
  const model = modelShort(r.model);
  const shortId = r.session_id.slice(0, 8);
  return `${folder}${model ? " · " + model : ""} · ${shortId}… (${r.event_count})`;
}

async function refreshLogSessionOptions() {
  const rows = await api("/api/log-sessions");
  if (!rows) return [];
  // Rebuilding a <select>'s <option> list while the native dropdown is open closes it (even if nothing
  // changed). If the user is on this dropdown (it has focus, whether or not it is expanded), skip this
  // rebuild so the options do not vanish under their hand; it refreshes again 8 seconds later anyway.
  if (document.activeElement !== logFilter) {
    const current = logFilter.value;
    logFilter.innerHTML = `<option value="">${t("logs.allSessions")}</option>`;
    for (const r of rows) {
      const opt = document.createElement("option");
      opt.value = r.session_id;
      const flag = r.bypass_count > 0 ? " ⚠" : r.blocked_count > 0 ? " 🛑" : "";
      opt.textContent = sessionLabel(r) + flag;
      opt.title = `${r.cwd || ""}\nID: ${r.session_id}`;
      logFilter.appendChild(opt);
    }
    logFilter.value = current;
  }
  refreshTapSessionOptions(rows);
  return rows;
}

logFilter.addEventListener("change", () => {
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  pollLogs();
});

// Auto-scroll-to-latest toggle: when off, new content is still appended to the list (recording and
// live refresh are unaffected), but the scrollbar is no longer pulled to the bottom, so reading older
// content is not interrupted by every poll. The state lives in localStorage, like language/theme.
// Audit Log and Claude Tap each have their own toggle.
function setupAutoscrollToggle(elementId, storageKey) {
  const el = document.getElementById(elementId);
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) el.checked = saved === "1";
  } catch (e) {
    // localStorage unavailable (private mode etc.): use the default; nothing breaks
  }
  el.addEventListener("change", () => {
    try {
      localStorage.setItem(storageKey, el.checked ? "1" : "0");
    } catch (e) {
      // ignore
    }
  });
  return el;
}
const logAutoscrollToggle = setupAutoscrollToggle("log-autoscroll-toggle", "cc_monitor_log_autoscroll");
const tapAutoscrollToggle = setupAutoscrollToggle("tap-autoscroll-toggle", "cc_monitor_tap_autoscroll");

// "Show thinking details" toggle: off (default) shows only the first few lines of .tap-thinking and
// collapses the rest with CSS; on expands everything. The backend already sends the full thinking
// content (not requested per toggle state), so this is a pure front-end CSS collapse/expand that
// takes effect instantly without refetching.
const tapThinkingDetailToggle = setupAutoscrollToggle("tap-thinking-detail-toggle", "cc_monitor_tap_thinking_detail");
function applyThinkingDetailClass() {
  document.getElementById("tap-list").classList.toggle("show-thinking-detail", tapThinkingDetailToggle.checked);
}
tapThinkingDetailToggle.addEventListener("change", applyThinkingDetailClass);
applyThinkingDetailClass();

// Operation category: read/write/edit/exec/delete, used to pick the badge colour. There is no
// dedicated delete tool; like the Home file-operation stats, we approximate it by rm/unlink/rmdir/shred in the Bash command text.
function operationCategory(ev) {
  if (ev.toolName === "Read") return "read";
  if (ev.toolName === "Write") return "write";
  if (["Edit", "MultiEdit", "NotebookEdit"].includes(ev.toolName)) return "edit";
  if (ev.toolName === "Bash") {
    const text = (ev.summaryHtml || "") + (ev.matchedRule || "");
    if (/dangerous_delete|\brm\b|\bunlink\b|\brmdir\b|\bshred\b/i.test(text)) return "delete";
    return "bash";
  }
  return "other";
}

function renderLogItem(ev) {
  const el = document.createElement("div");
  const opCategory = operationCategory(ev);
  el.className = "log-item" + (ev.risk === "high" ? " risk-high" : "");
  const extraHtml = (ev.extra || [])
    .map((e) => `<div class="extra">${e.label ? `<span class="lbl">${escapeHtml(translateExtraLabel(e.label))}: </span>` : ""}${e.html}</div>`)
    .join("");
  el.innerHTML = `
    <div class="row1">
      <span class="ts">${ev.ts}</span>
      <span class="risk ${ev.risk}">${escapeHtml(riskLabel(ev.risk))}</span>
      <span class="label op-${opCategory}">${escapeHtml(toolLabel(ev.toolName, ev.label))}</span>
      <span class="decision ${ev.decision}">${escapeHtml(decisionLabel(ev.decision))}</span>
      <span class="session-tag">${ev.sessionId ? "📁 " + escapeHtml(folderName(ev.cwd)) + " · " + ev.sessionId.slice(0, 8) + "…" : ""}</span>
    </div>
    <div class="cwd">${escapeHtml(ev.cwd || "")}</div>
    <div class="summary">${ev.summaryHtml || ""}</div>
    ${extraHtml}
  `;
  return el;
}

async function pollLogs() {
  const params = new URLSearchParams({ since_id: String(lastLogId), limit: "300" });
  if (logFilter.value) params.set("session_id", logFilter.value);
  const result = await api("/api/logs?" + params.toString());
  if (!result) return;
  const list = document.getElementById("log-list-full");
  if (result.events.length === 0 && list.children.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("logs.empty")}</div>`;
    return;
  }
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const ev of result.events) {
    lastLogId = Math.max(lastLogId, ev.id);
    frag.appendChild(renderLogItem(ev));
  }
  list.appendChild(frag);
  while (list.children.length > 500) list.removeChild(list.firstChild);
  if (logAutoscrollToggle.checked) list.scrollTop = list.scrollHeight;
}

// ---------- Claude Tap: the full conversation sent to / received from the model ----------
const tapSelect = document.getElementById("tap-session-select");
const tapMeta = document.getElementById("tap-meta");
const TAP_ALL_SESSIONS = "__all__";
let tapNextLine = 0;
let tapKnownSessions = [];

// Same kind of problem as the terminal session "reload means pick again": tapSelect.value is only DOM
// state, the dropdown is recreated on reload and the previous selection is lost. Keep a copy in
// localStorage and restore it the first time the dropdown gets its options (nothing selected yet on this page load).
const TAP_LAST_SESSION_KEY = "cc-monitor-last-tap-session";
function rememberTapSession(id) {
  try {
    if (id) localStorage.setItem(TAP_LAST_SESSION_KEY, id);
    else localStorage.removeItem(TAP_LAST_SESSION_KEY);
  } catch (e) {
    // localStorage unavailable does not break anything; the selection just is not restored after reload
  }
}
function getLastTapSession() {
  try {
    return localStorage.getItem(TAP_LAST_SESSION_KEY);
  } catch (e) {
    return null;
  }
}

let tapOptionsBuiltOnce = false;
function refreshTapSessionOptions(rows) {
  tapKnownSessions = rows;
  // Same reasoning: do not rebuild the <option>s while the user is working the dropdown (it has focus),
  // or the options get "refreshed away" in front of them, which is exactly the bug this guard fixes.
  if (document.activeElement === tapSelect) return;
  // Cannot use tapSelect.options.length === 0 to detect "first time": the HTML already has a hard-coded
  // placeholder <option>, so that is never true; keep our own flag.
  const isFirstBuild = !tapOptionsBuiltOnce;
  tapOptionsBuiltOnce = true;
  const current = tapSelect.value;
  tapSelect.innerHTML = `<option value="">${t("tap.selectPlaceholder")}</option>`;
  const hasAnyTranscript = rows.some((r) => r.has_transcript);
  if (hasAnyTranscript) {
    const allOpt = document.createElement("option");
    allOpt.value = TAP_ALL_SESSIONS;
    allOpt.textContent = t("tap.allSessions");
    tapSelect.appendChild(allOpt);
  }
  for (const r of rows) {
    const opt = document.createElement("option");
    opt.value = r.session_id;
    opt.textContent = sessionLabel(r) + (r.has_transcript ? "" : t("tap.noTranscript"));
    opt.disabled = !r.has_transcript;
    opt.title = `${r.cwd || ""}\nID: ${r.session_id}`;
    tapSelect.appendChild(opt);
  }
  const restoreTarget = current || (isFirstBuild ? getLastTapSession() : null);
  if (restoreTarget && (restoreTarget === TAP_ALL_SESSIONS || rows.some((r) => r.session_id === restoreTarget && r.has_transcript))) {
    tapSelect.value = restoreTarget;
    // Restored on this first page load (not just picked by the user): setting the value from code does
    // not fire a change event, so fetch the data by hand, or the dropdown looks right but the content is empty.
    if (!current) pollTap();
  }
  showTapPlaceholder();
}

// Before a session is selected the list is empty; show a hint, otherwise the blank page looks broken.
function showTapPlaceholder() {
  const list = document.getElementById("tap-list");
  if (!tapSelect.value && list.children.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("tap.pickSession")}</div>`;
  }
}

tapSelect.addEventListener("change", () => {
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  tapMeta.textContent = "";
  rememberTapSession(tapSelect.value || null);
  if (tapSelect.value) pollTap();
  else showTapPlaceholder();
});

function renderTapEntry(entry) {
  const el = document.createElement("div");
  el.className = "tap-entry tap-kind-" + entry.kind;
  const ts = entry.ts ? fmtTime24(new Date(entry.ts)) : "";
  // In the merged "all sessions" view every entry carries sessionId and needs a tag saying which session
  // it belongs to; the single-session view (no entry.sessionId) shows no tag.
  const sessionTag = entry.sessionId
    ? `<span class="tap-session-tag">📁 ${escapeHtml(folderName(entry.cwd))}${entry.model ? " · " + escapeHtml(modelShort(entry.model)) : ""} · ${escapeHtml(entry.sessionId.slice(0, 8))}…</span>`
    : "";
  el.innerHTML = `
    <div class="tap-header">
      <span class="tap-role tap-role-${entry.kind}">${escapeHtml(t("tap.kind." + entry.kind))}</span>
      <span class="tap-ts">${ts}</span>
      ${sessionTag}
      ${entry.usageHtml || ""}
    </div>
    ${entry.blocksHtml || ""}
  `;
  return el;
}

async function pollTap() {
  const sessionId = tapSelect.value;
  if (!sessionId) return;
  const list = document.getElementById("tap-list");

  if (sessionId === TAP_ALL_SESSIONS) {
    // Merged "all sessions" view: take the latest small slice of each session and merge by timestamp,
    // without incremental cursors (for a personal tool there are usually few sessions, and a full refetch
    // each time is much simpler than keeping cursors for many files).
    const result = await api("/api/transcript/all?limit=200&per_session_limit=30");
    if (!result) return;
    tapMeta.textContent = t("tap.allSessionsMeta", { n: result.sessionCount });
    tapMeta.title = "";
    if (result.entries.length === 0) {
      list.innerHTML = `<div class="empty-state">${t("tap.loading")}</div>`;
      return;
    }
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const entry of result.entries) frag.appendChild(renderTapEntry(entry));
    list.appendChild(frag);
    if (tapAutoscrollToggle.checked) list.scrollTop = 0;
    return;
  }

  const params = new URLSearchParams({ session_id: sessionId, since_line: String(tapNextLine), limit: "300" });
  const result = await api("/api/transcript?" + params.toString());
  if (!result) return;
  tapNextLine = result.nextLine;
  if (!result.transcriptPath) {
    list.innerHTML = `<div class="empty-state">${t("tap.noTranscriptBody")}</div>`;
    return;
  }
  if (result.missing) {
    // The hook payload reported this path but the file does not exist: common for one-off tool calls or
    // background tasks that never write a regular project transcript to disk. It is not stuck.
    tapMeta.textContent = result.transcriptPath;
    tapMeta.title = result.transcriptPath;
    list.innerHTML = `<div class="empty-state">${t("tap.transcriptMissing")}</div>`;
    return;
  }
  tapMeta.textContent = `${result.totalLines} · ${result.transcriptPath}`;
  tapMeta.title = result.transcriptPath;
  if (result.entries.length === 0 && list.children.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("tap.loading")}</div>`;
    return;
  }
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  // Newest on top, older entries sink: the API returns entries in chronological order (old -> new), so
  // insert them reversed. Within a batch, build the fragment in reverse order, then put it at the top of
  // the list as a whole; the newest entry of the batch lands on top and stays in order with the earlier content already there.
  const frag = document.createDocumentFragment();
  for (const entry of result.entries.slice().reverse()) frag.appendChild(renderTapEntry(entry));
  list.insertBefore(frag, list.firstChild);
  while (list.children.length > 400) list.removeChild(list.lastChild);
  if (tapAutoscrollToggle.checked) list.scrollTop = 0;
}

// ---------- Home overview ----------
async function refreshOverview() {
  const s = await api("/api/overview");
  if (!s) return;
  document.getElementById("stat-live-sessions").textContent = s.liveSessionCount;
  document.getElementById("stat-total-sessions").textContent = s.sessionCount;
  document.getElementById("stat-total-events").textContent = s.total;
  document.getElementById("stat-blocked").textContent = s.blockedTotal;
  // On macOS the exec-layer cross-check does not run at all (the probe uses nettop, which cannot see
  // execve). Showing "0" would read as "checked, all clear". Show n/a with a tooltip: a missing capability, not a security verdict.
  const bypassEl = document.getElementById("stat-bypass");
  const bypassCard = bypassEl.closest(".strip-card");
  if (s.bypassSupported === false) {
    bypassEl.textContent = t("home.strip.bypassNA");
    if (bypassCard) bypassCard.title = t("home.strip.bypassNATip");
  } else {
    bypassEl.textContent = s.bypassTotal;
    if (bypassCard) bypassCard.removeAttribute("title");
  }
  document.getElementById("stat-tool-calls").textContent = s.toolCalls;
  document.getElementById("stat-mcp-calls").textContent = s.mcpCalls;
  document.getElementById("stat-skill-calls").textContent = s.skillCalls;
  document.getElementById("stat-subagent-calls").textContent = s.subagentCalls;
  document.getElementById("stat-search-calls").textContent = s.searchCalls;
  document.getElementById("stat-todo-calls").textContent = s.todoCalls;
  document.getElementById("stat-ai-trajectory").textContent = s.aiTrajectory;

  if (s.fileOps) {
    document.getElementById("stat-file-reads").textContent = s.fileOps.reads;
    document.getElementById("stat-file-writes").textContent = s.fileOps.writes;
    document.getElementById("stat-file-edits").textContent = s.fileOps.edits;
    document.getElementById("stat-file-deletes").textContent = s.fileOps.deletes;
  }
  if (s.installOps) {
    // The group name is the element id suffix: when the backend adds a group, the front end adds a card; nothing to change here.
    for (const [key, n] of Object.entries(s.installOps)) {
      const el = document.getElementById("stat-install-" + key);
      if (el) el.textContent = n;
    }
  }
  document.getElementById("stat-github-total").textContent = s.githubOpsTotal;
  document.getElementById("stat-ssh-total").textContent = s.sshOpsTotal;
  document.getElementById("stat-download-total").textContent = s.downloadOpsTotal;
  document.getElementById("stat-filesend-total").textContent = s.fileSendOpsTotal;
  document.getElementById("stat-docker-total").textContent = s.dockerOpsTotal;
  document.getElementById("stat-archive-total").textContent = s.archiveOpsTotal;
  document.getElementById("stat-netdiag-total").textContent = s.netdiagOpsTotal;
  document.getElementById("stat-reverseeng-total").textContent = s.reverseEngOpsTotal;
  document.getElementById("stat-procbg-total").textContent = s.procbgOpsTotal;
  document.getElementById("stat-sensitive-total").textContent = s.sensitiveOpsTotal;
  document.getElementById("stat-sensitive-data-total").textContent = s.sensitiveDataTotal;
  document.getElementById("stat-advanced-threat-total").textContent = s.advancedThreatTotal;
  document.getElementById("stat-workdir-escape-total").textContent = s.workdirEscapeTotal;
  if (Array.isArray(s.workdirEscapeBreakdown)) {
    // Small text under the card: reads/writes each, and how many hit sensitive locations (hidden home-dir files / another user / system directories)
    const byKind = Object.fromEntries(s.workdirEscapeBreakdown.map((r) => [r.kind, r.n]));
    const n = (k) => byKind[k] || 0;
    document.getElementById("stat-workdir-escape-sub").textContent = t("home.workdirEscape.sub", {
      read: n("readSensitive") + n("readOther"),
      write: n("writeSensitive") + n("writeOther"),
      sensitive: n("readSensitive") + n("writeSensitive"),
    });
  }
  if (s.screenshotOps) {
    document.getElementById("stat-screenshot").textContent = s.screenshotOps.total;
  }

  // Log type is an "identity" category, so each of the six gets its own colour rather than one accent:
  // previously all six rows were the same blue and colour carried no information. The palette is
  // --cat-1..6 (see the note in style.css; it passed a readability check).
  // Two constraints: colours are bound to the source key, not to rank, so filtering or count changes do
  // not recolour the remaining rows; render order is fixed by SOURCE_ORDER, because the palette's
  // colour-blind separation was verified for adjacent pairs, and changing the order changes adjacency and
  // voids that check. New sources not in the table go last, in neutral grey.
  const ordered = SOURCE_ORDER.map((key) => s.bySource.find((r) => r.source === key)).filter(Boolean);
  const rest = s.bySource.filter((r) => !SOURCE_COLOR[r.source]);
  renderBarList("source-breakdown", [...ordered, ...rest].map((r) => ({
    name: sourceLabel2(r.source) || r.source || "-",
    count: r.n,
    color: SOURCE_COLOR[r.source] || "var(--text-dim)",
  })));
  renderBarList("risk-breakdown", s.byRisk.map((r) => ({
    name: riskLabel(r.risk) || r.risk || "-",
    count: r.n,
    color: RISK_COLOR[r.risk] || "var(--text-dim)",
  })));
  renderBarList("decision-breakdown", s.byDecision.map((r) => ({
    name: decisionLabel(r.decision) || r.decision || "-",
    count: r.n,
    color: DECISION_COLOR[r.decision] || "var(--text-dim)",
  })));
}

// Fixed render order + palette for log types. The order matches the verified order of --cat-1..6 in
// style.css one to one; change one side and you must change the other and rerun dataviz's validate_palette.js.
const SOURCE_ORDER = ["hook_lifecycle", "hook_post", "hook_pre", "hook_prompt", "os_exec", "os_net"];
const SOURCE_COLOR = {
  hook_lifecycle: "var(--cat-1)",
  hook_post: "var(--cat-2)",
  hook_pre: "var(--cat-3)",
  hook_prompt: "var(--cat-4)",
  os_exec: "var(--cat-5)",
  os_net: "var(--cat-6)",
};

function renderBarList(containerId, rows) {
  const el = document.getElementById(containerId);
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  el.innerHTML = rows
    .map(
      (r) => `
    <div class="bar-row">
      <span class="dot" style="background:${r.color}"></span>
      <span class="name">${escapeHtml(r.name)}</span>
      <span class="track"><span class="fill" style="width:${(r.count / max) * 100}%;background:${r.color}"></span></span>
      <span class="count">${r.count}</span>
    </div>`
    )
    .join("");
}

// ---------- Intervention level: three-way segmented control ----------
// The three levels are mutually exclusive, so they form a side-by-side radiogroup: all three visible,
// click a level to go there, any level reachable from any other in one step, and the control itself
// shows the state. The old version was "toggle button + separate stop button": the buttons named
// actions, not states, and only one option was visible at a time. Also, from "Off" the toggle pointed
// to "Enforcing", so Off could not go straight to Permissive: you had to turn enforcing back on first,
// and in that intermediate step it really was blocking.
// Do not call paused "audit paused" again: in that level auditing keeps running, only blocking stops,
// so it is shown as "Permissive (observe only)" (name borrowed from SELinux permissive). The value on disk and in the API is still paused.
const auditSeg = document.getElementById("audit-level-seg");
const auditSegOpts = auditSeg ? Array.from(auditSeg.querySelectorAll(".seg-opt")) : [];
function applyAuditState(state) {
  document.getElementById("audit-state-pill").className = "pill audit-state-" + state;
  document.getElementById("audit-state-text").textContent = t("auditState." + state);
  // First card of the Home status summary: the same state is shown in both the top-bar pill and on Home
  const stripDot = document.getElementById("strip-audit-dot");
  if (stripDot) {
    stripDot.className = "strip-dot " + state;
    const key = { running: "home.strip.auditRunning", paused: "home.strip.auditPaused", stopped: "home.strip.auditStopped" }[state];
    document.getElementById("strip-audit-text").textContent = key ? t(key) : state;
  }

  // Segmented control: the current level has aria-checked=true (the CSS selected state also hangs off
  // this attribute, so styling and accessibility share one source of truth and can never disagree).
  for (const opt of auditSegOpts) {
    const on = opt.dataset.level === state;
    opt.setAttribute("aria-checked", on ? "true" : "false");
    // Only the current level is reachable in the tab order; arrow keys move within the group. This is the
    // standard radiogroup interaction and avoids one tab stop per segment.
    opt.tabIndex = on ? 0 : -1;
  }
  const note = document.getElementById("audit-level-note");
  if (note) note.textContent = t("home.auditCtl.levelNote." + state);
}
async function refreshAuditState() {
  const info = await api("/api/audit-state");
  if (!info) return;
  applyAuditState(info.state);
}
async function setAuditState(state) {
  const info = await api("/api/audit-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!info) return;
  applyAuditState(info.state);
}
// Clicking any segment switches straight to that level: every pair of levels is one step apart,
// including "Off -> Permissive", which used to be unreachable. Only switching to "Off" asks for
// confirmation: that level really stops recording, unlike the other two, and a misclick costs a
// stretch of time with nothing recorded.
async function chooseAuditLevel(level) {
  if (!level) return;
  const current = auditSegOpts.find((o) => o.getAttribute("aria-checked") === "true");
  if (current && current.dataset.level === level) return; // clicked the current level; do nothing
  if (level === "stopped") {
    const ok = await confirmDialog(t("modal.stopAudit.title"), t("modal.stopAudit.body"));
    if (!ok) return;
  }
  setAuditState(level);
}

if (auditSeg) {
  auditSeg.addEventListener("click", (e) => {
    const opt = e.target.closest(".seg-opt");
    if (opt) chooseAuditLevel(opt.dataset.level);
  });
  // Arrow keys move within the group and select directly, Home/End jump to the ends: standard radiogroup keyboard behaviour.
  auditSeg.addEventListener("keydown", (e) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = auditSegOpts.findIndex((o) => o.getAttribute("aria-checked") === "true");
    const last = auditSegOpts.length - 1;
    let next;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else {
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      next = Math.min(last, Math.max(0, (i < 0 ? 0 : i) + step));
    }
    const target = auditSegOpts[next];
    if (target) {
      target.focus();
      chooseAuditLevel(target.dataset.level);
    }
  });
}

// ---------- Whether other devices may access this Web UI ----------
// This toggle only records the intent in a flag. The address the process listens on is fixed at
// startup, so changing the flag does not make 127.0.0.1 reachable from the LAN; to take effect, the
// admin must explicitly set CC_MONITOR_WEBUI_HOST=0.0.0.0 and restart the process. The listeningHost
// field tells us whether the change is "made but not yet in effect", and we say so clearly, so nobody
// thinks one click has already exposed the UI to the network (or, the other way round, that turning
// the toggle off has locked the port back to localhost: whether the port is open depends on the
// startup arguments, not on this flag).
const remoteAccessToggle = document.getElementById("remote-access-toggle");
const remoteAccessNote = document.getElementById("remote-access-note");
function applyRemoteAccessState(info) {
  remoteAccessToggle.checked = info.allowRemote;
  const pill = document.getElementById("remote-access-row");
  pill.classList.toggle("active", info.allowRemote);
  if (info.listeningHost === "127.0.0.1") {
    remoteAccessNote.textContent = t("home.remoteAccess.stillLocalOnly");
  } else if (info.allowRemote) {
    remoteAccessNote.textContent = t("home.remoteAccess.liveWarning", { host: info.listeningHost });
  } else {
    remoteAccessNote.textContent = t("home.remoteAccess.liveBlocked", { host: info.listeningHost });
  }
}
async function refreshRemoteAccessState() {
  const info = await api("/api/remote-access-state");
  if (!info) return;
  applyRemoteAccessState(info);
}
remoteAccessToggle.addEventListener("change", async () => {
  const wantsOn = remoteAccessToggle.checked;
  if (wantsOn) {
    const ok = await confirmDialog(t("modal.remoteAccess.title"), t("modal.remoteAccess.body"));
    if (!ok) {
      remoteAccessToggle.checked = false;
      return;
    }
  }
  const info = await api("/api/remote-access-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowRemote: wantsOn }),
  });
  if (!info) return;
  applyRemoteAccessState(info);
});

// ---------- Data management: persistent archive / clear current data / History list ----------
const archiveModal = document.getElementById("archive-modal");
const archiveLabelInput = document.getElementById("archive-label");

document.getElementById("archive-data-btn").addEventListener("click", () => {
  archiveLabelInput.value = "";
  archiveModal.hidden = false;
  archiveLabelInput.focus();
});
document.getElementById("archive-cancel").addEventListener("click", () => (archiveModal.hidden = true));
archiveModal.addEventListener("click", (ev) => {
  if (ev.target === archiveModal) archiveModal.hidden = true;
});
async function confirmArchive() {
  const label = archiveLabelInput.value.trim();
  archiveModal.hidden = true;
  const result = await api("/api/archives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: label || undefined }),
  });
  if (!result) return;
  // Archiving does not clear the current data, it just stores an extra snapshot. Switching to the
  // History page shows the user the entry just saved, which is better feedback than staying on Home where nothing visibly changes.
  document.querySelector('.tab-btn[data-tab="archives"]').click();
  refreshArchivesList();
}
document.getElementById("archive-confirm").addEventListener("click", confirmArchive);
archiveLabelInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") confirmArchive();
});

document.getElementById("clear-data-btn").addEventListener("click", async () => {
  const ok = await confirmDialog(t("modal.clearData.title"), t("modal.clearData.body"));
  if (!ok) return;
  const result = await api("/api/events/clear", { method: "POST" });
  if (!result) return;
  // Same as on a language switch: log/Tap entries already in the DOM are not "state" and do not clear
  // themselves. Old entries lingering after the data is gone would be odd, so reset the incremental
  // cursors, clear the lists and refresh everything.
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  refreshEverythingNow();
  document.getElementById("flow-close").click();
});

document.getElementById("sync-update-btn").addEventListener("click", async () => {
  const ok = await confirmDialog(t("modal.syncUpdate.title"), t("modal.syncUpdate.body"));
  if (!ok) return;
  const btn = document.getElementById("sync-update-btn");
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = t("home.syncUpdate.running");
  const result = await api("/api/sync-update", { method: "POST" });
  btn.disabled = false;
  btn.textContent = prevText;
  if (!result) return;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  alert((result.ok ? t("home.syncUpdate.ok") : t("home.syncUpdate.fail")) + (output ? "\n\n" + output : ""));
});

function archiveRangeText(a) {
  if (!a.firstTs || !a.lastTs) return "-";
  return a.firstTs === a.lastTs ? a.firstTs : `${a.firstTs} ~ ${a.lastTs}`;
}

async function refreshArchivesList() {
  const list = document.getElementById("archives-list");
  const rows = await api("/api/archives");
  if (!rows) return;
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("archives.empty")}</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (a) => `
    <div class="archive-item" data-id="${escapeHtml(a.id)}">
      <div class="archive-main">
        <div class="archive-label">${escapeHtml(a.label || t("archives.unnamed"))}</div>
        <div class="archive-meta">
          <span>${t("archives.createdAt")}: ${escapeHtml(a.createdAt)}</span>
          <span>${t("archives.eventCount")}: ${a.total}</span>
          <span>${t("archives.sessionCount")}: ${a.sessionCount}</span>
          <span>${t("archives.range")}: ${escapeHtml(archiveRangeText(a))}</span>
        </div>
      </div>
      <div class="archive-actions">
        <button class="btn-secondary archive-open" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label || t("archives.unnamed"))}">${t("archives.open")}</button>
        <button class="btn-secondary archive-delete" data-id="${escapeHtml(a.id)}">${t("archives.delete")}</button>
      </div>
    </div>`
    )
    .join("");
  list.querySelectorAll(".archive-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog(t("modal.deleteArchive.title"), t("modal.deleteArchive.body"));
      if (!ok) return;
      const result = await api(`/api/archives/${btn.dataset.id}`, { method: "DELETE" });
      if (!result) return;
      refreshArchivesList();
    });
  });
  list.querySelectorAll(".archive-open").forEach((btn) => {
    btn.addEventListener("click", () => openArchiveViewer(btn.dataset.id, btn.dataset.label));
  });
}

// ---------- AI Approvals: action=confirm operations; the terminal that triggered one can answer y/N, and so can this page ----------
// These requests are all "blocked waiting for an answer" (the hook process is still blocking, Claude
// Code's tool call has not continued yet). They are not ordinary audit records; the longer they wait
// the worse for the other side, so the poll interval is shorter than for every other list.

// Browser system notifications: when this page is not in front (another tab, minimised window, or the
// whole browser in the background), refreshing the list in the page is useless because nobody sees it.
// Use the Notification API for a system-level notification; one click jumps back here. Notify once per
// request, otherwise a poll every 2 seconds would drive people mad.
const notifiedApprovalIds = new Set();
const APPROVALS_NOTIFY_PREF_KEY = "cc-monitor-approvals-notify-enabled";

// Inside the Electron desktop app this browser Notification API path cannot be used: in the Electron
// renderer Notification.permission is always "granted" and new Notification() does not throw, but on
// macOS an app without proper signing is silently rejected by the system (see the note at the top of
// electron-main.js). The desktop app's main process polls the pending approval list itself (system
// notification + Dock bounce + badge), so this whole path is switched off to avoid duplicates.
const IS_ELECTRON = /\bElectron\//.test(navigator.userAgent);

function approvalsNotifySupported() {
  return !IS_ELECTRON && typeof Notification !== "undefined";
}

function syncApprovalsNotifyBtn() {
  const btn = document.getElementById("approvals-notify-btn");
  if (IS_ELECTRON) {
    btn.hidden = false;
    btn.textContent = t("approvals.notify.electron");
    btn.disabled = true;
    return;
  }
  if (!approvalsNotifySupported()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (Notification.permission === "granted") {
    btn.textContent = t("approvals.notify.enabled");
    btn.disabled = true;
  } else if (Notification.permission === "denied") {
    btn.textContent = t("approvals.notify.blocked");
    btn.disabled = true;
  } else {
    btn.textContent = t("approvals.notify.enable");
    btn.disabled = false;
  }
}

document.getElementById("approvals-notify-btn").addEventListener("click", async () => {
  if (!approvalsNotifySupported()) return;
  const perm = await Notification.requestPermission();
  try {
    localStorage.setItem(APPROVALS_NOTIFY_PREF_KEY, perm === "granted" ? "1" : "0");
  } catch (e) {
    // localStorage unavailable does not affect this permission grant; after reload the button state may just need another click
  }
  syncApprovalsNotifyBtn();
});

function plainTextSummary(r) {
  if (r.kind !== "notify") return r.matched_value;
  try {
    const questions = JSON.parse(r.matched_value);
    return questions.map((q) => q.question || "").join(" / ") || r.matched_value;
  } catch (e) {
    return r.matched_value;
  }
}

function notifyNewApprovals(rows) {
  if (!approvalsNotifySupported() || Notification.permission !== "granted") return;
  for (const r of rows) {
    if (notifiedApprovalIds.has(r.id)) continue;
    notifiedApprovalIds.add(r.id);
    const notifTitle =
      r.kind === "notify" ? t("approvals.notify.questionTitle") : r.kind === "permission" ? t("approvals.notify.permissionTitle") : t("approvals.notify.title");
    const n = new Notification(notifTitle, {
      body: `${toolLabel(r.tool_name, r.tool_name)} · ${folderName(r.cwd)}\n${plainTextSummary(r)}`.slice(0, 200),
      tag: `cc-monitor-approval-${r.id}`,
    });
    n.onclick = () => {
      window.focus();
      document.querySelector('.tab-btn[data-tab="approvals"]').click();
      n.close();
    };
  }
  // Requests already handled (approved/denied/expired) do not appear in the next poll, so there is no
  // point keeping them in this Set. Prune it by the ids in the current batch so a page left open for a long time does not grow the Set forever.
  const stillPending = new Set(rows.map((r) => r.id));
  for (const id of notifiedApprovalIds) {
    if (!stillPending.has(id)) notifiedApprovalIds.delete(id);
  }
}

// For kind='notify' records (e.g. AskUserQuestion) matched_value holds the questions field exactly as
// JSON.stringify produced it (an array; each element has question/header/options). Parse it and lay it
// out as "question + option list"; if parsing fails (should the tool's field shape change one day),
// show it escaped as-is rather than crash the page.
function formatQuestionValue(matchedValue) {
  try {
    const questions = JSON.parse(matchedValue);
    if (!Array.isArray(questions)) throw new Error("not an array");
    return questions
      .map((q) => {
        const opts = (q.options || []).map((o) => `<li>${escapeHtml(o.label)}${o.description ? ` — ${escapeHtml(o.description)}` : ""}</li>`).join("");
        return `<div class="approval-question">${escapeHtml(q.header ? q.header + "：" : "")}${escapeHtml(q.question || "")}</div><ul class="approval-question-options">${opts}</ul>`;
      })
      .join("");
  } catch (e) {
    return escapeHtml(matchedValue);
  }
}

// Rule metadata (id -> title/desc in Chinese and English): AI Approvals turns "which rule matched" into
// "what operation needs confirming". Fetched once at startup, then refreshed with the approval list
// (so edits to the text in rules.json show up too).
let ruleMetaCache = {};
async function refreshRuleMeta() {
  const meta = await api("/api/rules/meta");
  if (meta && typeof meta === "object") ruleMetaCache = meta;
}
function ruleTitle(ruleId) {
  const m = ruleMetaCache[ruleId];
  if (!m) return null;
  return (currentLang === "en" ? m.title_en || m.title : m.title || m.title_en) || null;
}
function ruleDesc(ruleId) {
  const m = ruleMetaCache[ruleId];
  if (!m) return null;
  return (currentLang === "en" ? m.desc_en || m.desc : m.desc || m.desc_en) || null;
}

async function refreshApprovals() {
  const [rows] = await Promise.all([api("/api/pending-approvals"), refreshRuleMeta()]);
  const badge = document.getElementById("approvals-badge");
  if (!rows) return;
  badge.hidden = rows.length === 0;
  badge.textContent = String(rows.length);
  // The "pending approval" card in the Home status summary shares its source with the top-bar badge
  const stripPending = document.getElementById("strip-pending");
  if (stripPending) {
    stripPending.textContent = String(rows.length);
    stripPending.classList.toggle("accent-yellow-text", rows.length > 0);
    document.getElementById("strip-pending-cap").textContent = t(rows.length > 0 ? "home.strip.pendingSome" : "home.strip.pendingNone");
  }
  notifyNewApprovals(rows);

  const list = document.getElementById("approvals-list");
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("approvals.empty")}</div>`;
    return;
  }
  list.innerHTML = rows
    .map((r) => {
      const isNotify = r.kind === "notify";
      // kind='permission': Claude Code's own native confirmation prompt (PermissionRequest hook).
      // matched_rule holds a "permission:<tool name>" key used for remembering, not a rule id from the rule
      // table, so show a plain explanation instead; the buttons work like confirm, and the choice answers on
      // the user's behalf via decision.behavior.
      const isPermission = r.kind === "permission";
      // The title says in one sentence "what operation needs confirming", the subtitle explains why; the rule
      // id and tool name drop to a last line of small text. Three sources: a matched rule uses the rule's
      // title/desc; Claude Code's native permission prompt has no rule, so we give one sentence per tool name;
      // a user-defined rule without a title falls back to its id.
      let headline;
      let explain;
      if (isPermission) {
        headline = t("approvals.permission.rule");
        explain = t("approvals.permission.explain", { tool: toolLabel(r.tool_name, r.tool_name) });
      } else {
        headline = ruleTitle(r.matched_rule) || r.matched_rule || "-";
        explain = ruleDesc(r.matched_rule) || "";
      }
      const ruleLine = isPermission
        ? escapeHtml(toolLabel(r.tool_name, r.tool_name))
        : `${t("approvals.ruleLabel")} ${escapeHtml(r.matched_rule || "-")} · ${escapeHtml(toolLabel(r.tool_name, r.tool_name))}`;
      return `
    <div class="approval-item${isNotify ? " approval-item-notify" : ""}${isPermission ? " approval-item-permission" : ""}" data-id="${r.id}">
      <div class="row1">
        <span class="ts">${escapeHtml(r.ts)}</span>
        <span class="risk ${r.risk}">${escapeHtml(riskLabel(r.risk))}</span>
        <span class="session-tag">📁 ${escapeHtml(folderName(r.cwd))} · ${r.session_id ? escapeHtml(r.session_id.slice(0, 8)) + "…" : "-"}</span>
      </div>
      <div class="approval-headline">${isNotify ? "" : `<span class="approval-headline-prefix">${t("approvals.needConfirm")}</span>`}${escapeHtml(headline)}</div>
      ${explain ? `<div class="approval-explain">${escapeHtml(explain)}</div>` : ""}
      <div class="approval-rule">${ruleLine}</div>
      ${
        isNotify
          ? `<div class="approval-value">${formatQuestionValue(r.matched_value)}</div>
             <div class="approval-notify-hint">${t("approvals.notify.goToTerminal")}</div>`
          : `<div class="approval-value">${escapeHtml(r.matched_value)}</div>
             ${isPermission ? `<div class="approval-notify-hint">${t("approvals.permission.hint")}</div>` : ""}
             <div class="approval-actions">
               <button class="btn-primary approval-allow" data-id="${r.id}">${t("approvals.allowOnce")}</button>
               <button class="btn-danger approval-deny" data-id="${r.id}">${t("approvals.denyOnce")}</button>
               <button class="btn-secondary approval-allow10" data-id="${r.id}">${t("approvals.allow10m")}</button>
               <button class="btn-secondary approval-allow30" data-id="${r.id}">${t("approvals.allow30m")}</button>
               <button class="btn-secondary approval-always" data-id="${r.id}">${t("approvals.alwaysAllow")}</button>
             </div>`
      }
    </div>`;
    })
    .join("");
  const DECISION_BY_CLASS = {
    "approval-allow": "allow",
    "approval-deny": "deny",
    "approval-allow10": "allow_10m",
    "approval-allow30": "allow_30m",
    "approval-always": "always_allow",
  };
  list.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const decision = Object.entries(DECISION_BY_CLASS).find(([cls]) => btn.classList.contains(cls))?.[1];
      const result = await api(`/api/pending-approvals/${btn.dataset.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!result) return;
      refreshApprovals();
      refreshApprovalHistory();
    });
  });
}

const APPROVAL_STATUS_I18N_KEY = {
  allowed: "approvals.history.status.allowed",
  denied: "approvals.history.status.denied",
  always_allowed: "approvals.history.status.alwaysAllowed",
  allowed_10m: "approvals.history.status.allowed10m",
  allowed_30m: "approvals.history.status.allowed30m",
  expired: "approvals.history.status.expired",
  answered: "approvals.history.status.answered",
  deferred: "approvals.history.status.deferred",
};
const APPROVAL_STATUS_CLASS = {
  allowed: "risk low",
  always_allowed: "risk low",
  allowed_10m: "risk low",
  allowed_30m: "risk low",
  answered: "risk info",
  denied: "risk high",
  expired: "risk medium",
  deferred: "risk info",
};
function approvalStatusLabel(status) {
  const key = APPROVAL_STATUS_I18N_KEY[status];
  return key ? t(key) : status || "-";
}
const APPROVAL_VIA_I18N_KEY = {
  web: "approvals.history.via.web",
  tty: "approvals.history.via.tty",
  post_tool_use: "approvals.history.via.auto",
  timeout: "approvals.history.via.timeout",
};
function approvalViaLabel(via) {
  const key = APPROVAL_VIA_I18N_KEY[via];
  return key ? t(key) : via || "-";
}

// History (every record with status != 'pending', kept long term; see listHistory() in approvals.js).
// Unlike the "pending approval" list above, this needs no frequent polling; it refreshes only when the
// tab is actually opened. resolved_value is what hook.py extracts for notify records (e.g.
// AskUserQuestion) after they are answered in the terminal, from the matching PostToolUse
// tool_response.answers: JSON of {question text: answer text}. Only the answer text is shown here (the
// question is already in the "matched content" column, no need to repeat it).
function formatAnswerValue(resolvedValue) {
  if (!resolvedValue) return null;
  try {
    const answers = JSON.parse(resolvedValue);
    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
      const vals = Object.values(answers);
      if (vals.length) return vals.join("; ");
    }
  } catch (e) {
    // Not the expected JSON shape; show as-is
  }
  return resolvedValue;
}

async function refreshApprovalHistory() {
  const rows = await api("/api/approvals/history?limit=200");
  const wrap = document.getElementById("approvals-history-wrap");
  if (!rows) return;
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${t("approvals.history.empty")}</div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="dd-table">
      <thead><tr>
        <th>${t("drilldown.col.time")}</th>
        <th>${t("drilldown.col.sessionId")}</th>
        <th>${t("approvals.history.col.tool")}</th>
        <th>${t("approvals.history.col.rule")}</th>
        <th>${t("approvals.history.col.value")}</th>
        <th>${t("approvals.history.col.status")}</th>
        <th>${t("approvals.history.col.answer")}</th>
        <th>${t("approvals.history.col.via")}</th>
      </tr></thead>
      <tbody>
        ${rows
          .map((r) => {
            const answer = formatAnswerValue(r.resolved_value);
            return `<tr>
          <td class="dd-mono dd-nowrap">${escapeHtml((r.resolved_at || r.ts || "").slice(0, 19).replace("T", " "))}</td>
          <td class="dd-mono">${sessionIdCell(r.session_id, r.cwd)}</td>
          <td class="dd-nowrap">${escapeHtml(toolLabel(r.tool_name, r.tool_name))}${r.kind === "notify" ? " (notify)" : r.kind === "permission" ? " (native)" : ""}</td>
          <td title="${escapeHtml(r.matched_rule || "")}">${escapeHtml(r.kind === "permission" ? t("approvals.permission.rule") : ruleTitle(r.matched_rule) || r.matched_rule || "-")}</td>
          <td class="dd-mono dd-clip" title="${escapeHtml(r.matched_value || "")}">${escapeHtml((r.matched_value || "-").slice(0, 60))}</td>
          <td class="dd-nowrap"><span class="${APPROVAL_STATUS_CLASS[r.status] || ""}">${escapeHtml(approvalStatusLabel(r.status))}</span></td>
          <td class="dd-clip" title="${escapeHtml(answer || "")}">${answer ? escapeHtml(answer.slice(0, 60)) : "-"}</td>
          <td class="dd-nowrap">${escapeHtml(approvalViaLabel(r.resolved_via))}</td>
        </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}
// The content reuses the same renderLogItem() as the Audit Log page, so it looks consistent.
// An archive is a fixed snapshot, so no polling; with many events, "Load more" pages further.
let archiveViewerNextId = 0;
let archiveViewerArchiveId = null;
async function loadMoreArchiveEvents(list, loadMoreBtn) {
  const result = await api(`/api/archives/${archiveViewerArchiveId}/events?since_id=${archiveViewerNextId}&limit=500`);
  if (!result) return;
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const ev of result.events) {
    archiveViewerNextId = Math.max(archiveViewerNextId, ev.id);
    frag.appendChild(renderLogItem(ev));
  }
  list.appendChild(frag);
  loadMoreBtn.hidden = result.events.length < 500;
}
async function openArchiveViewer(id, label) {
  const title = document.getElementById("drilldown-title");
  const body = document.getElementById("drilldown-body");
  title.textContent = `${t("archives.viewerTitle")} · ${label}`;
  body.innerHTML = `<div class="empty-state">${t("drilldown.loading")}</div>`;
  drilldownModal.hidden = false;

  archiveViewerArchiveId = id;
  archiveViewerNextId = 0;
  const list = document.createElement("div");
  list.className = "log-list";
  const loadMoreBtn = document.createElement("button");
  loadMoreBtn.className = "btn-secondary archive-load-more";
  loadMoreBtn.textContent = t("archives.loadMore");
  loadMoreBtn.hidden = true;
  loadMoreBtn.addEventListener("click", () => loadMoreArchiveEvents(list, loadMoreBtn));
  body.innerHTML = "";
  body.appendChild(list);
  body.appendChild(loadMoreBtn);
  await loadMoreArchiveEvents(list, loadMoreBtn);
  if (list.children.length === 0) list.innerHTML = `<div class="empty-state">${t("archives.viewerEmpty")}</div>`;
}

// ---------- Drill-down details for Home stat cards ----------
const drilldownModal = document.getElementById("drilldown-modal");
document.getElementById("drilldown-close").addEventListener("click", () => (drilldownModal.hidden = true));
drilldownModal.addEventListener("click", (ev) => {
  if (ev.target === drilldownModal) drilldownModal.hidden = true;
});

// In the network traffic table, clicking "connections" shows each connection time/process for that
// destination, and the summary cards at the top of the Network page (total connections / distinct IPs)
// open the full details. These elements are all rebuilt via innerHTML on every poll, so one delegated
// listener on document handles them, instead of re-attaching listeners after each refresh.
document.addEventListener("click", (ev) => {
  const targetEl = ev.target.closest("[data-target-ip]");
  if (targetEl) {
    showTargetConnections(targetEl.dataset.targetIp, targetEl.dataset.targetPort, targetEl.dataset.targetHost);
    return;
  }
  // In the compact Home layout a card may contain smaller clickable areas (the three numbers in a merged
  // card, the four small stats in the file-operation box, "terminal sessions" in a summary card's caption);
  // closest picks the nearest one, so the inner one wins.
  const drilldownEl = ev.target.closest(".clickable[data-drilldown]");
  if (drilldownEl) {
    openDrilldown(drilldownEl.dataset.drilldown);
    return;
  }
  const gotoEl = ev.target.closest("[data-goto-tab]");
  if (gotoEl) {
    const tabBtn = document.querySelector(`.tab-btn[data-tab="${gotoEl.dataset.gotoTab}"]`);
    if (tabBtn) tabBtn.click();
  }
});

async function showTargetConnections(ip, port, host) {
  const title = document.getElementById("drilldown-title");
  const body = document.getElementById("drilldown-body");
  const targetLabel = host ? `${host} (${ip}:${port})` : `${ip}:${port}`;
  title.textContent = t("network.targetDrilldown.title", { target: targetLabel });
  body.innerHTML = `<div class="empty-state">${t("drilldown.loading")}</div>`;
  drilldownModal.hidden = false;
  const events = await api("/api/drilldown/ai-trajectory-events");
  if (!events) return;
  const matched = events.filter((e) => e.ip === ip && String(e.port) === String(port));
  if (matched.length === 0) {
    body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
    return;
  }
  body.innerHTML = `
    <table class="dd-table">
      <thead><tr><th>${t("drilldown.col.time")}</th><th>${t("drilldown.col.process")}</th><th>PID</th></tr></thead>
      <tbody>
        ${matched
          .map(
            (e) => `<tr>
          <td class="dd-mono">${escapeHtml((e.ts || "").slice(0, 19))}</td>
          <td class="dd-mono">${escapeHtml(e.comm || "-")}</td>
          <td class="dd-mono">${e.pid ?? "-"}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

// When a drill-down request fails (e.g. the Web UI server still runs old code without this route and
// returns 404), each branch's `if (!result) return;` exits early and the dialog stays on "Loading…"
// forever. Catch it here in one place: if the placeholder is still there afterwards, replace it with a
// sentence telling the user what to do.
async function openDrilldown(kind) {
  const body = document.getElementById("drilldown-body");
  try {
    // Several drill-downs show rule ids as plain explanations (block stats, approval history). The rule
    // text is normally refreshed along with AI Approvals and may not be loaded on first paint, so fetch it
    // on demand here (the server caches it for 5 s; cheap).
    if (Object.keys(ruleMetaCache).length === 0) await refreshRuleMeta();
    await openDrilldownInner(kind);
  } finally {
    const placeholder = body.querySelector(".empty-state");
    if (placeholder && body.children.length === 1 && placeholder.textContent === t("drilldown.loading")) {
      placeholder.textContent = t("drilldown.loadFailed");
    }
  }
}

async function openDrilldownInner(kind) {
  const title = document.getElementById("drilldown-title");
  const body = document.getElementById("drilldown-body");
  body.innerHTML = `<div class="empty-state">${t("drilldown.loading")}</div>`;
  drilldownModal.hidden = false;

  if (kind === "live-sessions") {
    title.textContent = t("drilldown.liveSessions.title");
    const rows = await api("/api/sessions");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.liveSessions.cwd")}</th><th>${t("drilldown.sessions.sessionId")}</th>
          <th>${t("drilldown.liveSessions.status")}</th>
          <th>${t("drilldown.liveSessions.uptime")}</th><th>${t("drilldown.lastActive")}</th>
          <th>${t("drilldown.liveSessions.clients")}</th>
          <th>${t("drilldown.liveSessions.model")}</th><th>${t("drilldown.liveSessions.events")}</th>
          <th>${t("drilldown.sessions.flags")}</th><th>${t("drilldown.sessions.range")}</th><th></th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (s) => `
            <tr class="dd-row-clickable" data-id="${escapeHtml(s.id)}">
              <td>${escapeHtml(s.cwd || "-")}</td>
              <td class="dd-mono">${s.auditSessionId ? escapeHtml(s.auditSessionId) : "-"}</td>
              <td>${renderVital(s.status, s.statusAgoMs)}</td>
              <td class="dd-mono">${formatUptime(Date.now() - s.createdAt)}</td>
              <td class="dd-mono">${s.lastOutputAt ? formatAgo(Date.now() - s.lastOutputAt) : "-"}</td>
              <td>${s.clientCount}</td>
              <td>${escapeHtml(modelShort(s.model) || "-")}</td>
              <td>${s.eventCount === null || s.eventCount === undefined ? "-" : s.eventCount}</td>
              <td>${(s.blockedCount || 0) > 0 ? `🛑${s.blockedCount} ` : ""}${(s.bypassCount || 0) > 0 ? `⚠${s.bypassCount}` : ""}${
                !s.blockedCount && !s.bypassCount ? "-" : ""
              }</td>
              <td class="dd-mono">${s.firstTs ? (s.firstTs || "").slice(0, 19) + " ~ " + (s.lastTs || "").slice(11, 19) : "-"}</td>
              <td>${s.alive ? `<span class="dd-open-hint">${t("drilldown.liveSessions.open")} ›</span>` : ""}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    body.querySelectorAll(".dd-row-clickable").forEach((tr) => {
      tr.addEventListener("click", () => {
        drilldownModal.hidden = true;
        document.querySelector('.tab-btn[data-tab="terminal"]').click();
        selectSession(tr.dataset.id);
      });
    });
    return;
  }

  if (kind === "sessions") {
    title.textContent = t("drilldown.sessions.title");
    const rows = await api("/api/drilldown/sessions");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.sessions.cwd")}</th><th>${t("drilldown.sessions.sessionId")}</th>
          <th>${t("drilldown.sessions.status")}</th><th>${t("drilldown.lastActive")}</th>
          <th>${t("drilldown.sessions.model")}</th>
          <th>${t("drilldown.sessions.tokIn")}</th><th>${t("drilldown.sessions.tokOut")}</th>
          <th>${t("drilldown.sessions.tokCached")}</th><th>${t("drilldown.sessions.tokTotal")}</th>
          <th>${t("drilldown.sessions.events")}</th>
          <th>${t("drilldown.sessions.flags")}</th><th>${t("drilldown.sessions.range")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.cwd || "-")}</td>
              <td class="dd-mono dd-nowrap">${escapeHtml(r.sessionId)}</td>
              <td class="dd-nowrap">${renderVital(r.status, r.statusAgoMs)}</td>
              <td class="dd-mono dd-nowrap">${r.lastTs ? formatAgo(Date.now() - new Date(r.lastTs).getTime()) : "-"}</td>
              <td class="dd-nowrap">${escapeHtml(modelShort(r.model) || "-")}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalInputTokens) : "-"}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalOutputTokens) : "-"}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalCachedTokens) : "-"}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalTokens) : "-"}</td>
              <td class="dd-nowrap">${r.eventCount}</td>
              <td class="dd-nowrap">${r.blockedCount > 0 ? `🛑${r.blockedCount} ` : ""}${r.bypassCount > 0 ? `⚠${r.bypassCount}` : ""}${
                r.blockedCount === 0 && r.bypassCount === 0 ? "-" : ""
              }</td>
              <td class="dd-mono dd-nowrap">${(r.firstTs || "").slice(0, 19)} ~ ${(r.lastTs || "").slice(11, 19)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    return;
  }

  if (kind === "claude-processes") {
    title.textContent = t("drilldown.identity.title");
    const result = identityLastResult || (await api("/api/claude-processes"));
    if (!result) return;
    if (result.processes.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.identity.pid")}</th><th>${t("drilldown.identity.user")}</th>
          <th>${t("drilldown.sessions.status")}</th><th>${t("drilldown.lastActive")}</th>
          <th>${t("drilldown.identity.uptime")}</th><th>${t("drilldown.identity.model")}</th>
          <th>${t("drilldown.identity.events")}</th><th>${t("drilldown.identity.rss")}</th>
          <th>${t("drilldown.identity.cwd")}</th>
        </tr></thead>
        <tbody>
          ${result.processes
            .map(
              (p) => `
            <tr${p.user !== result.currentUser ? ' class="dd-row-mismatch"' : ""}>
              <td class="dd-mono dd-nowrap">${p.pid}</td>
              <td class="dd-nowrap">${escapeHtml(p.user)}${p.user === result.currentUser ? " " + t("home.identity.currentTag") : ""}</td>
              <td class="dd-nowrap">${renderVital(p.status, p.statusAgoMs)}</td>
              <td class="dd-mono dd-nowrap">${p.lastEventTs ? formatAgo(Date.now() - new Date(p.lastEventTs).getTime()) : "-"}</td>
              <td class="dd-mono dd-nowrap"${p.startedAt ? ` title="${t("drilldown.identity.startedAt", { t: fmtDateTime24(new Date(p.startedAt)) })}"` : ""}>${formatDuration(p.uptimeSec)}</td>
              <td class="dd-mono dd-nowrap">${
                p.model
                  ? escapeHtml(p.model)
                  : `<span class="hint">${t("drilldown.identity.modelUnknown")}</span>`
              }</td>
              <td class="dd-mono dd-nowrap">${p.eventCount === null || p.eventCount === undefined ? "-" : p.eventCount}</td>
              <td class="dd-mono dd-nowrap">${p.rssKb ? formatBytes(p.rssKb * 1024) : "-"}</td>
              <td title="${escapeHtml(p.args || "")}">${p.cwd ? escapeHtml(p.cwd) : `<span class="hint">${t("drilldown.identity.cwdUnknown")}</span>`}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    return;
  }

  if (kind === "event-types") {
    title.textContent = t("drilldown.eventTypes.title");
    const [rows, sessionRows] = await Promise.all([api("/api/drilldown/event-types"), api("/api/drilldown/sessions")]);
    if (!rows) return;
    // A hex Session ID cannot identify the session; as elsewhere, add the folder name + model.
    const sessionInfo = new Map((sessionRows || []).map((r) => [r.sessionId, r]));
    const describeSession = (sessionId) => {
      const info = sessionInfo.get(sessionId);
      const folder = info ? folderName(info.cwd) : "?";
      const model = info ? modelShort(info.model) : "";
      return `${escapeHtml(folder)}${model ? " · " + escapeHtml(model) : ""} · <span class="dd-mono">${escapeHtml(sessionId.slice(0, 8))}…</span>`;
    };
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
      <div class="dd-group">
        <div class="dd-group-title">${escapeHtml(sourceLabel2(r.source))} · ${escapeHtml(
          toolLabel(r.toolName, r.toolName) || t("drilldown.eventTypes.none")
        )} <span class="n">${t("drilldown.eventTypes.times", { n: r.total })}</span></div>
        <table class="dd-table">
          <thead><tr><th>${t("drilldown.eventTypes.sessionId")}</th><th>${t("drilldown.eventTypes.count")}</th></tr></thead>
          <tbody>
            ${
              r.sessions
                .sort((a, b) => b.count - a.count)
                .map((s) => `<tr><td>${describeSession(s.sessionId)}</td><td>${s.count}</td></tr>`)
                .join("") || `<tr><td colspan="2">${t("drilldown.eventTypes.none")}</td></tr>`
            }
          </tbody>
        </table>
      </div>`
      )
      .join("");
    return;
  }

  if (kind === "tool-calls" || kind === "mcp-calls" || kind === "skill-calls" || kind === "subagent-calls" || kind === "search-calls") {
    const groupKind = kind === "mcp-calls" ? "mcp" : kind === "skill-calls" ? "skill" : kind === "subagent-calls" ? "subagent" : kind === "search-calls" ? "search" : "tool";
    title.textContent =
      groupKind === "mcp"
        ? t("drilldown.mcpCalls.title")
        : groupKind === "skill"
          ? t("drilldown.skillCalls.title")
          : groupKind === "subagent"
            ? t("drilldown.subagentCalls.title")
            : groupKind === "search"
              ? t("drilldown.searchCalls.title")
              : t("drilldown.toolCalls.title");
    const result = await api(`/api/drilldown/${kind}`);
    if (!result) return;
    const { breakdown, events } = result;
    if (breakdown.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    const columnLabel =
      groupKind === "mcp"
        ? t("drilldown.mcpCalls.server")
        : groupKind === "skill"
          ? t("drilldown.skillCalls.skill")
          : groupKind === "subagent"
            ? t("drilldown.subagentCalls.type")
            : t("drilldown.toolCalls.tool");
    const rowLabel = (r) => (groupKind === "mcp" ? r.server : groupKind === "skill" ? r.skill : groupKind === "subagent" ? r.subagentType : toolLabel(r.tool_name, r.tool_name));
    const eventLabel = (e) => (groupKind === "skill" ? e.skill : groupKind === "subagent" ? e.subagentType + (e.description ? " — " + e.description : "") : toolLabel(e.tool_name, e.tool_name));
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${columnLabel}</th>
          <th>${t("drilldown.toolCalls.count")}</th>
        </tr></thead>
        <tbody>
          ${breakdown.map((r) => `<tr><td>${escapeHtml(rowLabel(r))}</td><td>${r.n}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="box-title" style="margin:18px 0 8px;">${t("drilldown.eventDetail")}</div>
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.col.time")}</th>
          <th>${t("drilldown.col.sessionId")}</th>
          <th>${t("drilldown.col.cwd")}</th>
          <th>${columnLabel}</th>
        </tr></thead>
        <tbody>
          ${
            events
              .map(
                (e) => `<tr>
              <td class="dd-mono">${escapeHtml((e.ts || "").slice(0, 19))}</td>
              <td class="dd-mono">${sessionIdCell(e.session_id, e.cwd)}</td>
              <td>${escapeHtml(e.cwd || "-")}</td>
              <td>${escapeHtml(eventLabel(e))}</td>
            </tr>`
              )
              .join("") || `<tr><td colspan="4">${t("drilldown.empty")}</td></tr>`
          }
        </tbody>
      </table>`;
    return;
  }

  const GROUPED_OPS_KINDS = {
    "github-ops": { titleKey: "home.githubOps.title", labels: { push: "home.githubOps.push", clone: "home.githubOps.clone", commit: "home.githubOps.commit", pullFetch: "home.githubOps.pullFetch", ghCli: "home.githubOps.ghCli", otherGit: "home.githubOps.otherGit" } },
    "ssh-ops": { titleKey: "home.sshOps.title", labels: { ssh: "home.sshOps.ssh", scp: "home.sshOps.scp", sftp: "home.sshOps.sftp", keyManagement: "home.sshOps.keyManagement", other: "home.sshOps.other" } },
    "download-ops": { titleKey: "home.downloadOps.title", labels: { wget: "home.downloadOps.wget", curl: "home.downloadOps.curl", aria2: "home.downloadOps.aria2", other: "home.downloadOps.other" } },
    "file-send-ops": { titleKey: "home.fileSendOps.title", labels: { scp: "home.fileSendOps.scp", rsync: "home.fileSendOps.rsync", sftp: "home.fileSendOps.sftp", curlUpload: "home.fileSendOps.curlUpload", cloudSync: "home.fileSendOps.cloudSync", netcatSend: "home.fileSendOps.netcatSend", artifactUpload: "home.fileSendOps.artifactUpload", mcpFileSend: "home.fileSendOps.mcpFileSend", toolFileBody: "home.fileSendOps.toolFileBody", other: "home.fileSendOps.other" } },
    "docker-ops": { titleKey: "home.dockerOps.title", labels: { run: "home.dockerOps.run", build: "home.dockerOps.build", exec: "home.dockerOps.exec", compose: "home.dockerOps.compose", other: "home.dockerOps.other" } },
    "archive-ops": { titleKey: "home.archiveOps.title", labels: { tar: "home.archiveOps.tar", zip: "home.archiveOps.zip", sevenZip: "home.archiveOps.sevenZip", gzip: "home.archiveOps.gzip", other: "home.archiveOps.other" } },
    "netdiag-ops": { titleKey: "home.netdiagOps.title", labels: { nc: "home.netdiagOps.nc", nmap: "home.netdiagOps.nmap", telnet: "home.netdiagOps.telnet", other: "home.netdiagOps.other" } },
    "reverseeng-ops": { titleKey: "home.reverseEngOps.title", labels: { ida: "home.reverseEngOps.ida", ghidra: "home.reverseEngOps.ghidra", radare2: "home.reverseEngOps.radare2", gdb: "home.reverseEngOps.gdb", other: "home.reverseEngOps.other" } },
    "procbg-ops": { titleKey: "home.procbgOps.title", labels: { nohup: "home.procbgOps.nohup", disown: "home.procbgOps.disown", backgroundJob: "home.procbgOps.backgroundJob", other: "home.procbgOps.other" } },
    "sensitive-ops": { titleKey: "home.sensitiveOps.title", labels: { sshKey: "home.sensitiveOps.sshKey", credential: "home.sensitiveOps.credential", envVar: "home.sensitiveOps.envVar", other: "home.sensitiveOps.other" } },
    "sensitive-data": { titleKey: "home.sensitiveData.title", labels: { credential: "home.sensitiveData.credential", pii: "home.sensitiveData.pii", vpnConfig: "home.sensitiveData.vpnConfig", other: "home.sensitiveData.other" } },
    "advanced-threat": { titleKey: "home.advancedThreat.title", labels: { cryptoMining: "home.advancedThreat.cryptoMining", dbFileWrite: "home.advancedThreat.dbFileWrite", webshell: "home.advancedThreat.webshell", reverseEscapeShell: "home.advancedThreat.reverseEscapeShell", downloadExec: "home.advancedThreat.downloadExec", c2Framework: "home.advancedThreat.c2Framework", postExploitation: "home.advancedThreat.postExploitation", suspiciousMcp: "home.advancedThreat.suspiciousMcp", pentestRecon: "home.advancedThreat.pentestRecon", covertTunnel: "home.advancedThreat.covertTunnel" } },
    "workdir-escape": { titleKey: "home.workdirEscape.title", labels: { writeSensitive: "home.workdirEscape.writeSensitive", writeOther: "home.workdirEscape.writeOther", readSensitive: "home.workdirEscape.readSensitive", readOther: "home.workdirEscape.readOther" } },
  };
  // The groups whose Home cards are marked with accent-red-strong also get red bold category badges in
  // the drill-down details. At first only "sensitive operations / sensitive data / advanced threat
  // detection / reverse-engineering tool calls" were marked; later the "command operation stats"
  // (GitHub/SSH/download/Docker/archive/network diagnostics/process management) were also asked to have
  // red bold category labels in their grouped drill-downs. So this simply applies to every group going
  // through the GROUPED_OPS_KINDS drill-down path, instead of editing this set for each new group.
  if (GROUPED_OPS_KINDS[kind]) {
    // The seven groups GitHub/SSH/download/Docker/archive/network diagnostics/process management: Home
    // used to show a full row of sub-category cards per group (30+ cards in total, flooding the page).
    // Now each group has one summary card; opening it shows a category subtotal table first (the same
    // table as MCP/Skill/subagent calls), then the full command list below (reusing the log-item
    // summaryHtml rendering with syntax highlighting, each entry prefixed by a category badge).
    const cfg = GROUPED_OPS_KINDS[kind];
    title.textContent = t(cfg.titleKey);
    const result = await api(`/api/drilldown/${kind}`);
    if (!result) return;
    const { breakdown, events } = result;
    if (breakdown.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    const kindLabel = (k) => (cfg.labels[k] ? t(cfg.labels[k]) : k);
    // For the groups whose Home cards are red (sensitive operations / sensitive data / advanced threat
    // detection / reverse-engineering tool calls), the category badges in the drill-down are red and bold
    // too, matching the card's visual weight; not every group needs it.
    const badgeCls = "dd-badge-category dd-badge-danger";
    const tdCls = " class=\"dd-badge-danger\"";
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr><th>${t("drilldown.opsBreakdown.category")}</th><th>${t("drilldown.toolCalls.count")}</th></tr></thead>
        <tbody>
          ${breakdown.map((r) => `<tr><td${tdCls}>${escapeHtml(kindLabel(r.kind))}</td><td>${r.n}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="box-title" style="margin:18px 0 8px;">${t("drilldown.eventDetail")}</div>
      ${
        events
          .map(
            (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="${badgeCls}">${escapeHtml(kindLabel(r.kind))}</span>
          <span class="label dd-badge-danger">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
          )
          .join("") || `<div class="empty-state">${t("drilldown.empty")}</div>`
      }`;
    return;
  }

  if (kind === "ai-trajectory") {
    title.textContent = t("drilldown.aiTrajectory.title");
    const [result, connectEvents] = await Promise.all([api(`/api/network-traffic?limit=500&lang=${currentLang}`), api("/api/drilldown/ai-trajectory-events")]);
    if (!result) return;
    const rows = result.rows;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("network.col.target")}</th><th>${t("network.col.location")}</th>
          <th>${t("network.col.tx")}</th><th>${t("network.col.rx")}</th>
          <th>${t("network.col.connects")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const badge = r.inferred ? `<span class="dd-badge-inferred" title="${t("network.inferredHint")}">${t("network.inferredBadge")}</span> ` : "";
              const target = r.host ? `${badge}${escapeHtml(r.host)}<br><span class="dd-mono hint">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>` : `${badge}<span class="dd-mono">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>`;
              const countryLabel = r.geo ? r.geo.country || r.geo.countryCode : null;
              const loc = r.geo ? escapeHtml([r.geo.city, countryLabel].filter(Boolean).join(", ") || "-") : `<span class="hint">${t("network.noLocation")}</span>`;
              return `<tr>
                <td>${target}</td>
                <td>${loc}</td>
                <td>${formatBytes(r.txBytes)}</td>
                <td>${formatBytes(r.rxBytes)}</td>
                <td><span class="dd-open-hint" style="cursor:pointer;" data-target-ip="${escapeHtml(r.ip)}" data-target-port="${r.port}" data-target-host="${escapeHtml(r.host || "")}">${r.connectCount} ›</span></td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      <div class="box-title" style="margin:18px 0 4px;">${t("drilldown.eventDetail")}</div>
      <div class="hint" style="margin-bottom:10px;">${t("drilldown.aiTrajectory.noSessionHint")}</div>
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.col.time")}</th>
          <th>${t("drilldown.col.process")}</th>
          <th>${t("network.col.target")}</th>
          <th>${t("drilldown.sessions.sessionId")}</th>
          <th>PID</th>
        </tr></thead>
        <tbody>
          ${
            (connectEvents || [])
              .map((e) => {
                const badge = e.inferred ? `<span class="dd-badge-inferred" title="${t("network.inferredHint")}">${t("network.inferredBadge")}</span> ` : "";
                const target = e.host ? `${badge}${escapeHtml(e.host)}<br><span class="dd-mono hint">${escapeHtml(e.ip || "")}:${e.port ?? "-"}</span>` : `${badge}<span class="dd-mono">${escapeHtml(e.ip || "-")}:${e.port ?? "-"}</span>`;
                const proc = `<span class="dd-mono">${escapeHtml((e.comm || "-").slice(0, 60))}</span>`;
                const session = e.inferred && e.sessionId ? `${escapeHtml(folderName(e.cwd))} · ${escapeHtml(e.sessionId.slice(0, 8))}…` : `<span class="hint">-</span>`;
                return `<tr>
                <td class="dd-mono">${escapeHtml((e.ts || "").slice(0, 19))}</td>
                <td>${proc}</td>
                <td>${target}</td>
                <td>${session}</td>
                <td class="dd-mono">${e.pid ?? "-"}</td>
              </tr>`;
              })
              .join("") || `<tr><td colspan="5">${t("drilldown.empty")}</td></tr>`
          }
        </tbody>
      </table>`;
    return;
  }

  if (kind === "blocked") {
    title.textContent = t("drilldown.blocked.title");
    const rows = await api("/api/drilldown/blocked");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.blocked.empty")}</div>`;
      return;
    }
    // Give a set of statistics before the detail list: a long list of events alone does not show "what is
    // mostly being blocked". All three dimensions are computed from the rows we already have; no extra API call.
    const countBy = (keyFn) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const byRule = countBy((r) => r.matchedRule || "-");
    const byTool = countBy((r) => r.toolName || "-");
    const byDir = countBy((r) => r.cwd || "-");
    const now = Date.now();
    const since = (ms) => rows.filter((r) => now - new Date(r.ts).getTime() <= ms).length;
    const statTable = (titleKey, entries, labelFn) => `
      <div class="home-box">
        <div class="box-title">${t(titleKey)}</div>
        <table class="dd-table">
          <thead><tr><th>${t("drilldown.blocked.category")}</th><th>${t("drilldown.blocked.count")}</th></tr></thead>
          <tbody>
            ${entries
              .map(([k, n]) => `<tr><td class="dd-badge-danger">${escapeHtml(labelFn(k))}</td><td class="dd-nowrap">${n}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>`;
    body.innerHTML = `
      <div class="home-grid cols-3" style="margin-bottom:14px;">
        <div class="card dense"><div class="card-num accent-red-text">${rows.length}</div><div class="card-label">${t("drilldown.blocked.total")}</div></div>
        <div class="card dense"><div class="card-num">${since(24 * 3600 * 1000)}</div><div class="card-label">${t("drilldown.blocked.last24h")}</div></div>
        <div class="card dense"><div class="card-num">${since(7 * 24 * 3600 * 1000)}</div><div class="card-label">${t("drilldown.blocked.last7d")}</div></div>
      </div>
      <div class="home-grid cols-3" style="margin-bottom:18px;">
        ${statTable("drilldown.blocked.byRule", byRule, (k) => ruleTitle(k) || k)}
        ${statTable("drilldown.blocked.byTool", byTool, (k) => toolLabel(k, k))}
        ${statTable("drilldown.blocked.byDir", byDir, (k) => folderName(k) || k)}
      </div>
      <div class="box-title" style="margin:0 0 8px;">${t("drilldown.eventDetail")}</div>
      ${rows
        .map(
          (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="risk high">${escapeHtml(riskLabel("high"))}</span>
          <span class="label op-${operationCategory(r)}">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
          <span class="decision blocked">${escapeHtml(decisionLabel("blocked"))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}<span class="sep"> · </span><span class="rule">${escapeHtml(
            ruleTitle(r.matchedRule) || r.matchedRule || "-"
          )}</span></div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
        )
        .join("")}`;
    return;
  }

  if (kind === "screenshot") {
    // Only one card, no subtypes, unlike the shared "file-op-/install-op-/github-op-" logic above: handled
    // separately, calling /api/drilldown/screenshot directly without building an opType.
    title.textContent = t("home.screenshotOps.total") + " — " + t("drilldown.fileOp.suffix");
    const result = await api("/api/drilldown/screenshot");
    if (!result) return;
    const rows = result.events || [];
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    // "Really took a screenshot" and "just opened an image" must be shown separately: most entries in this
    // card are the latter, and with one combined number you cannot tell whether screenshot commands were detected at all.
    const shotKindLabel = (k) => t("drilldown.screenshot.kind." + k) || k;
    const bd = result.breakdown || [];
    const realShots = bd.filter((r) => r.kind !== "imageRead").reduce((a, r) => a + r.n, 0);
    body.innerHTML = `
      <div class="home-grid cols-3" style="margin-bottom:14px;">
        <div class="card dense"><div class="card-num accent-red-text">${realShots}</div><div class="card-label">${t("drilldown.screenshot.realTotal")}</div></div>
        ${bd
          .map(
            (r) =>
              `<div class="card dense"><div class="card-num shot-kind-${escapeHtml(r.kind || "")}">${r.n}</div><div class="card-label">${escapeHtml(
                shotKindLabel(r.kind)
              )}</div></div>`
          )
          .join("")}
      </div>
      <div class="box-title" style="margin:0 0 8px;">${t("drilldown.eventDetail")}</div>
      ${rows
        .map(
          (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="dd-badge-category shot-kind-${escapeHtml(r.kind || "")}">${escapeHtml(shotKindLabel(r.kind))}</span>
          <span class="label op-${operationCategory(r)}">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
        )
        .join("")}`;
    return;
  }

  if (kind === "todo-calls") {
    // Single card, no subtypes, same pattern as the screenshot audit card. TodoWrite has no natural
    // category dimension, so list the recent calls flat, each with the number of items in its task list
    // (not the task text itself, the same "basic information only" level as the other drill-down cards).
    title.textContent = t("home.card.todoCalls") + " — " + t("drilldown.fileOp.suffix");
    const rows = await api("/api/drilldown/todo-calls");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="label">${escapeHtml(t("drilldown.todoCalls.itemCount", { n: r.todoCount }))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
      </div>`
      )
      .join("");
    return;
  }

  const OP_DRILLDOWN_PREFIXES = ["file-op-", "install-op-"];
  if (OP_DRILLDOWN_PREFIXES.some((p) => kind.startsWith(p))) {
    // File operations (read/write/edit/delete) and software installs (pip/system packages/npm/other)
    // have identical drill-down data shapes and rendering, only the backend API path prefix differs, so
    // they share one code path. GitHub/SSH/download/Docker/archive/network diagnostics/process management
    // used to be part of this family too; since Home moved to one summary card per group they live in the
    // dedicated GROUPED_OPS_KINDS branch below (those seven drill-downs are now "category subtotal table +
    // event details", no longer the same shape as the flat file-op/install-op lists).
    const OP_LABEL_KEYS = {
      "install-op": { pip: "home.installOps.pip", uv: "home.installOps.uv", pythonOther: "home.installOps.pythonOther", js: "home.installOps.js", toolchain: "home.installOps.toolchain", system: "home.installOps.system", other: "home.installOps.other" },
      "file-op": { read: "home.fileOps.reads", write: "home.fileOps.writes", edit: "home.fileOps.edits", delete: "home.fileOps.deletes" },
    };
    const apiKind = OP_DRILLDOWN_PREFIXES.find((p) => kind.startsWith(p)).slice(0, -1);
    const prefix = apiKind + "-";
    const opType = kind.slice(prefix.length);
    const opLabelKey = OP_LABEL_KEYS[apiKind][opType];
    const suffixKey = apiKind === "install-op" ? "drilldown.installOp.suffix" : "drilldown.fileOp.suffix";
    title.textContent = t(opLabelKey) + " — " + t(suffixKey);
    const rows = await api(`/api/drilldown/${apiKind}/${opType}`);
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    const renderLogItems = (list) =>
      list
        .map(
          (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="label op-${operationCategory(r)}">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
        )
        .join("");

    if (apiKind === "install-op" && opType === "npm") {
      // The "npm install" card is backed by two rules with different risk levels (local install at log
      // level, global install at confirm level). One combined total is better for seeing at a glance "how
      // many npm installs happened", but the details must not mix both into one flat list: group by
      // matchedRule, each with its own subheading, since things with different risk levels should not look equally weighty.
      const local = rows.filter((r) => r.matchedRule === "npm_local_install");
      const global = rows.filter((r) => r.matchedRule === "npm_global_install");
      body.innerHTML = `
        <div class="box-title" style="margin:0 0 8px;">${t("drilldown.installOp.npmGlobal")}</div>
        ${global.length ? renderLogItems(global) : `<div class="empty-state">${t("drilldown.empty")}</div>`}
        <div class="box-title" style="margin:18px 0 8px;">${t("drilldown.installOp.npmLocal")}</div>
        ${local.length ? renderLogItems(local) : `<div class="empty-state">${t("drilldown.empty")}</div>`}
      `;
      return;
    }

    body.innerHTML = renderLogItems(rows);
    return;
  }
}

// ---------- Status page (ccstatusline-like) ----------
// Same format as ccstatusline's TokensTotal/TokensCached widgets ("2.6M"/"30.6k"), and the numbers use
// the same definition: Total = input+output+cached, Cached = cache_read+cache_creation.
function formatTokensShort(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function fmtDuration(fromTs, toTs) {
  try {
    const ms = new Date(toTs.replace(/T/, " ").replace(/-(\d{2}):?(\d{2})$/, "")).getTime() -
      new Date(fromTs.replace(/T/, " ").replace(/-(\d{2}):?(\d{2})$/, "")).getTime();
    const mins = Math.max(0, Math.round(ms / 60000));
    return t("status.durationMinutes", { n: mins < 1 ? "<1" : mins });
  } catch (e) {
    return "-";
  }
}

async function refreshModelUsage() {
  const result = await api("/api/model-usage");
  const wrap = document.getElementById("model-usage-wrap");
  if (!result) return;
  const models = result.models || [];
  if (models.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${t("status.modelUsage.empty")}</div>`;
    return;
  }
  const maxTotal = Math.max(1, ...models.map((m) => m.totalTokens));
  wrap.innerHTML = `
    <table class="dd-table">
      <thead><tr>
        <th>${t("status.modelUsage.col.model")}</th>
        <th>${t("status.modelUsage.col.sessions")}</th>
        <th>${t("status.modelUsage.col.input")}</th>
        <th>${t("status.modelUsage.col.output")}</th>
        <th>${t("status.modelUsage.col.cache")}</th>
        <th>${t("status.modelUsage.col.total")}</th>
      </tr></thead>
      <tbody>
        ${models
          .map((m) => {
            const barPct = Math.round((m.totalTokens / maxTotal) * 100);
            return `<tr>
          <td><b>${escapeHtml(modelShort(m.model))}</b></td>
          <td class="dd-mono">${m.sessionCount}</td>
          <td class="dd-mono">${formatTokensShort(m.inputTokens)}</td>
          <td class="dd-mono">${formatTokensShort(m.outputTokens)}</td>
          <td class="dd-mono">${formatTokensShort(m.cacheReadTokens + m.cacheCreationTokens)}</td>
          <td>
            <div class="neon-bar-cell">
              <div class="neon-bar" style="width:120px;border:1px solid var(--accent);"><div class="neon-bar-fill" style="width:${barPct}%;background:linear-gradient(90deg, color-mix(in srgb, var(--accent) 45%, white), var(--accent));"></div></div>
              <span class="neon-bar-pct" style="color:var(--accent);">${formatTokensShort(m.totalTokens)}</span>
            </div>
          </td>
        </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

async function refreshStatusBoard() {
  const status = await api("/api/status");
  if (!status) return;
  const { liveSessions, auditSessions } = status;
  const board = document.getElementById("status-board");
  const rows = [];

  for (const s of liveSessions) {
    const mins = Math.floor(s.uptimeMs / 60000);
    rows.push(`
      <div class="status-row">
        <span class="seg kind webui">🖥 Web UI</span>
        <span class="seg">${renderVital(s.status, s.statusAgoMs)}</span>
        <span class="seg cwd">📁 ${escapeHtml(s.cwd)}</span>
        ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="seg">⏱ ${mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins })}</span>
      </div>`);
  }

  for (const s of auditSessions) {
    const ts = s.tokenStats;
    let tokenSegs = "";
    let contextSeg = "";
    if (ts) {
      const rate = ts.outputTokensPerSec != null ? `${ts.outputTokensPerSec.toFixed(1)} tok/s ↑` : "";
      const rateIn = ts.inputTokensPerSec != null ? `${ts.inputTokensPerSec.toFixed(1)} tok/s ↓` : "";
      const totalShort = formatTokensShort(ts.totalTokens);
      const cachedShort = formatTokensShort(ts.totalCachedTokens);
      tokenSegs = `
        <span class="seg">💬 in=${ts.totalInputTokens} out=${ts.totalOutputTokens}${ts.totalCacheReadTokens ? ` cache=${ts.totalCacheReadTokens}` : ""}</span>
        ${totalShort ? `<span class="seg">Σ Total: ${totalShort}${cachedShort ? " · Cached: " + cachedShort : ""}</span>` : ""}
        ${rate ? `<span class="seg">⚡ ${rate}${rateIn ? " · " + rateIn : ""}</span>` : ""}
      `;
      if (ts.contextTokens != null) {
        // Claude Code does not tell our hooks the current model's exact context window size (only its own
        // statusLine input has that field). Like ccstatusline when the value is missing, fall back to the
        // standard 200K context window: an approximation, not an exact reading, and the UI text must say so.
        const ctxPct = Math.min(100, Math.round((ts.contextTokens / DEFAULT_CONTEXT_WINDOW) * 100));
        const ctxColor = healthColor(100 - ctxPct);
        contextSeg = `<span class="seg" style="color:${ctxColor};" title="${t("status.contextWindow.hint")}">📐 ${t("status.contextWindow.label")}: ${ctxPct}% (${formatTokensShort(ts.contextTokens)}/200k)</span>`;
      }
    }
    const cs = s.compactionStats;
    const compactionSeg = cs && cs.count > 0
      ? `<span class="seg" title="${t("status.compaction.hint", { n: cs.autoCount, m: cs.manualCount, tokens: formatTokensShort(cs.cumulativeDroppedTokens) })}">🗜 ${t("status.compaction.label", { n: cs.count })}</span>`
      : "";
    rows.push(`
      <div class="status-row">
        <span class="seg kind">🤖 ${folderName(s.cwd)} · ${s.sessionId.slice(0, 8)}…</span>
        <span class="seg">${renderVital(s.status, s.statusAgoMs)}</span>
        ${s.model ? `<span class="seg model">🧠 ${escapeHtml(modelShort(s.model))}</span>` : ""}
        <span class="seg cwd">📁 ${escapeHtml(s.cwd || "-")}</span>
        ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="seg">⏱ ${fmtDuration(s.firstTs, s.lastTs)}</span>
        <span class="seg">${t("status.eventCount", { n: s.eventCount })}</span>
        ${tokenSegs}
        ${contextSeg}
        ${compactionSeg}
        ${s.blockedCount > 0 ? `<span class="seg blocked">${t("status.blockedCount", { n: s.blockedCount })}</span>` : ""}
        ${s.bypassCount > 0 ? `<span class="seg bypass">${t("status.bypassCount", { n: s.bypassCount })}</span>` : ""}
      </div>`);
  }

  board.innerHTML = rows.join("") || `<div class="empty-state">${t("status.empty")}</div>`;
}

function fmtResetAt(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    // This used Math.round(hours), accurate only to the hour: "in 4.98 hours" and "in 4.02 hours" both
    // showed "in 5 hours", nearly an hour apart without any visible difference. For a reset time a few
    // minutes can be the difference between "not reset yet" and "already reset", so show minutes.
    const totalMinutes = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const when = days > 0 ? t("status.daysHoursLater", { d: days, h: hours }) : t("status.hoursMinutesLater", { h: hours, m: minutes });
    return `${when} (${fmtDateTime24(d)})`;
  } catch (e) {
    return iso;
  }
}

// 5 hours / 7 days are the window lengths written in the API's own text ("session quota (5-hour
// window)" / "weekly quota"), not guesses: the hourglass needs the total window length to work out how much has elapsed.
const SESSION_WINDOW_MS = 5 * 3600 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
// Claude Code does not tell our hooks the current model's exact context window size (that is only
// in its own statusLine input). Like ccstatusline when it is missing, fall back to this standard value
// (the standard context window of most models); it is an approximation.
const DEFAULT_CONTEXT_WINDOW = 200000;

let hourglassUidCounter = 0;
// Hourglass: sand left in the top bulb = 1-elapsed, sand fallen into the bottom bulb = elapsed. Pure
// SVG, no image assets; the colour follows the theme's --accent (the gradient's two stops are derived
// from --accent with color-mix in CSS, so a theme change carries over automatically).
//
// Geometry: viewBox 28x44, a plate at top and bottom, the classic hourglass outline in between, the
// bulbs meeting at y=21.8. Sand in the top bulb rests on the bulb's floor (it drains through the neck,
// so what is left sits at the bottom with a flat surface); sand in the bottom bulb piles up from the
// base, its top drawn as a quadratic Bezier peaking in the middle, which looks more like real sand
// than a flat rectangle. Both are clipped again so no ratio can spill outside the glass outline.
// If color is passed in, the sand follows the card's own colour (quota card colours are computed from
// health: green/yellow/orange differ); otherwise it falls back to the theme's --accent. Within one
// card the hourglass and the progress bar share a colour, which looks more unified than always using the accent.
function hourglassSvg(elapsedFraction, color) {
  const e = Math.max(0, Math.min(1, elapsedFraction));
  const uid = `hg${hourglassUidCounter++}`;
  const NECK = 21.8;          // y where the bulbs meet
  const TOP_Y = 6.2;          // top of the upper bulb
  const BOT_Y = 37.8;         // bottom of the lower bulb
  const TOP_H = NECK - TOP_Y; // sand height the upper bulb can hold
  const BOT_H = BOT_Y - NECK;

  const topH = (1 - e) * TOP_H;
  const botH = e * BOT_H;
  const topSandY = NECK - topH;
  const botSandY = BOT_Y - botH;
  // Height of the sand pile's crown: more sand makes a sharper pile, capped at 2.6 so it never pokes through the glass when nearly full.
  const mound = Math.min(3.4, botH * 0.55);

  // Draw the falling stream only while sand is running; not when it is done or has not started.
  const streaming = e > 0.02 && e < 0.995;
  const sandLight = color ? rgbToHex(lerpRgb(hexToRgb(color), [255, 255, 255], 0.45)) : null;

  return `
    <svg class="hourglass-svg" width="30" height="46" viewBox="0 0 28 44" aria-hidden="true">
      <defs>
        <linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="44" gradientUnits="userSpaceOnUse">
          <stop class="hg-stop-a" offset="0"${sandLight ? ` style="stop-color:${sandLight}"` : ""}/>
          <stop class="hg-stop-b" offset="1"${color ? ` style="stop-color:${color}"` : ""}/>
        </linearGradient>
        <clipPath id="${uid}t"><path d="M6.4 ${TOP_Y} H21.6 L14 ${NECK} Z"/></clipPath>
        <clipPath id="${uid}b"><path d="M14 ${NECK} L21.6 ${BOT_Y} H6.4 Z"/></clipPath>
      </defs>

      <g clip-path="url(#${uid}t)">
        <rect fill="url(#${uid}g)" x="0" y="${topSandY.toFixed(2)}" width="28" height="${(topH + 0.4).toFixed(2)}"/>
      </g>

      ${streaming ? `<rect class="hg-stream" x="13.5" y="${NECK.toFixed(2)}" width="1" height="${Math.max(0, botSandY - NECK).toFixed(2)}"${color ? ` style="fill:${color}"` : ""}/>` : ""}

      <g clip-path="url(#${uid}b)">
        <path fill="url(#${uid}g)" d="M6.4 ${BOT_Y} H21.6 V${botSandY.toFixed(2)} Q14 ${(botSandY - mound).toFixed(2)} 6.4 ${botSandY.toFixed(2)} Z"/>
      </g>

      <path class="hg-glass" d="M6.4 ${TOP_Y} H21.6 L14 ${NECK} L21.6 ${BOT_Y} H6.4 L14 ${NECK} Z"/>
      <rect class="hg-cap" x="4.6" y="2.6" width="18.8" height="3.2" rx="1.6"/>
      <rect class="hg-cap" x="4.6" y="38.2" width="18.8" height="3.2" rx="1.6"/>
    </svg>`;
}

function hexToRgb(hex) {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function lerpRgb(c1, c2, t) { return [0, 1, 2].map((i) => c1[i] + (c2[i] - c1[i]) * t); }
function themeVarHex(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
// Health gradient: 0 = most dangerous (red), 100 = healthiest (green), passing through yellow, two
// linear segments. The three anchors read the current theme's --red/--yellow/--green rather than fixed
// colours, so the gradient follows a theme change (consistent with the earlier "whole-card tint"
// feedback: colours follow the theme, never hard-coded).
function healthColor(healthPct) {
  const p = Math.max(0, Math.min(100, healthPct));
  const red = hexToRgb(themeVarHex("--red", "#ff5f6d"));
  const yellow = hexToRgb(themeVarHex("--yellow", "#e6b450"));
  const green = hexToRgb(themeVarHex("--green", "#4fd18b"));
  const rgb = p <= 50 ? lerpRgb(red, yellow, p / 50) : lerpRgb(yellow, green, (p - 50) / 50);
  return rgbToHex(rgb);
}
function withAlpha(hex, alpha) {
  return hex + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
}

// conky-style banded colours: not a continuous gradient but fixed steps, one per 10%, with two extra
// bands below 5% and above 85% (redder/greener). The colour values are hard-coded and vivid, not theme
// variables (this is only for the "session quota remaining percentage" bar; the other quota bars use the
// continuous healthColor() gradient, a separate colour logic; per the requirement it is used only here).
const CONKY_STEPS = [
  [5, "#d90000"], // <5%: very red
  [10, "#ff4d3d"], // ~10%: slightly red
  [20, "#ff7a3d"],
  [30, "#ff9f3d"],
  [40, "#ffc93d"],
  [50, "#e9e64a"],
  [60, "#c3e64a"],
  [70, "#8fdb4a"],
  [85, "#4fd15f"],
  [100, "#00e05a"], // 85-100%: very green
];
function conkyStepColor(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (const [ceiling, color] of CONKY_STEPS) {
    if (p <= ceiling) return color;
  }
  return CONKY_STEPS[CONKY_STEPS.length - 1][1];
}

// Colour scheme for the quota bars: originally two hard-coded schemes, "remaining" with conky bands
// and "used" with a continuous gradient. Some people prefer red/yellow/green steps at a glance, others
// do not want the bars to draw the eye (single colour). So it is an option stored in this browser:
// display only, no effect on any data.
const USAGE_SCHEME_KEY = "cc_monitor_usage_scheme";

// A colour scheme = a set of anchor colours, interpolated by "health" (0 = most dangerous, 100 =
// healthiest). The original schemes were all red/yellow/green and looked alike; these add genuinely
// different palettes (ocean/neon/sunset/forest/greyscale/spectrum) so switching is clearly visible.
// Anchors left to right = most dangerous to healthiest.
const USAGE_PALETTES = {
  health: ["#d90000", "#e6b450", "#10c378"], // red -> yellow -> green (classic)
  ocean: ["#1e3a8a", "#0ea5e9", "#67e8f9"], // dark blue -> sky blue -> cyan
  neon: ["#6d28d9", "#d946ef", "#f9a8d4"], // purple -> magenta -> pink
  sunset: ["#7f1d1d", "#f97316", "#fbbf24"], // dark red -> orange -> amber
  forest: ["#14532d", "#16a34a", "#bef264"], // dark green -> green -> yellow-green
  mono: ["#3f3f46", "#a1a1aa", "#e4e4e7"], // greyscale: does not draw the eye at all
};

function lerpPalette(anchors, pct) {
  const p = Math.max(0, Math.min(100, pct));
  const pos = (p / 100) * (anchors.length - 1);
  const i = Math.min(anchors.length - 2, Math.floor(pos));
  const a = hexToRgb(anchors[i]);
  const b = hexToRgb(anchors[i + 1]);
  if (!a || !b) return anchors[anchors.length - 1];
  return rgbToHex(lerpRgb(a, b, pos - i));
}

// Spectrum: map health directly to hue (0 = red -> 120 = green -> 200 = cyan) at full saturation.
// Entirely different from the "interpolate between two or three anchors" schemes above; the widest colour range.
function spectrumColor(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const hue = (p / 100) * 200; // 0 (red) -> 200 (cyan-blue)
  const s = 0.72;
  const l = 0.48;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60);
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
  ][Math.min(3, seg)];
  return rgbToHex(rgb.map((v) => (v + m) * 255));
}

const USAGE_SCHEMES = ["default", "steps", "traffic", "ocean", "neon", "sunset", "forest", "spectrum", "mono", "accent"];
let usageScheme = "default";
try {
  const saved = localStorage.getItem(USAGE_SCHEME_KEY);
  if (saved && USAGE_SCHEMES.includes(saved)) usageScheme = saved;
} catch (e) {
  // Private mode / site data disabled: use the default scheme
}

// healthPct is "health" (0 = most dangerous, 100 = healthiest), not percentage used. The two card
// kinds show different numbers (remaining vs used), but colour is always computed from health; see the conversion in usageCard.
function usageBarColor(healthPct, isSession) {
  const p = Math.max(0, Math.min(100, healthPct));
  switch (usageScheme) {
    case "steps":
      return conkyStepColor(p);
    case "traffic":
      return themeVarHex(p <= 10 ? "--red" : p <= 30 ? "--yellow" : "--green", "#4fd18b");
    case "spectrum":
      return spectrumColor(p);
    case "accent":
      return themeVarHex("--accent", "#4f8cff");
    case "ocean":
    case "neon":
    case "sunset":
    case "forest":
    case "mono":
      return lerpPalette(USAGE_PALETTES[usageScheme], p);
    default:
      // Keep the original behaviour: session quota (remaining) uses banded colours, the others (used) a continuous gradient
      return isSession ? conkyStepColor(p) : healthColor(p);
  }
}

function syncUsageSchemeSelects() {
  document.querySelectorAll(".usage-scheme-select").forEach((sel) => {
    sel.value = usageScheme;
  });
}

function setUsageScheme(value) {
  if (!USAGE_SCHEMES.includes(value)) return;
  usageScheme = value;
  try {
    localStorage.setItem(USAGE_SCHEME_KEY, value);
  } catch (e) {
    // If it cannot be stored, it applies to this session only
  }
  syncUsageSchemeSelects();
  // Redraw both quota panels (the API server caches for 180 s, so another request here is cheap)
  refreshUsageBoard();
  refreshHomeAnthropicInfo();
}

document.addEventListener("change", (ev) => {
  const sel = ev.target.closest(".usage-scheme-select");
  if (sel) setUsageScheme(sel.value);
});

// Quotas with optional=true (per-model Sonnet/Opus weekly quotas): if the API does not return the
// bucket, skip the whole card. Not every account has these two (e.g. accounts with only a Fable limit),
// and a card showing "-" would only make people think something is broken. The session quota and the
// all-models weekly quota are not optional: without data they still hold their place, signalling "something belongs here".
function usageCard(label, bucket, windowMs, optional = false) {
  if (!bucket || bucket.utilization === null) {
    if (optional) return "";
    return `<div class="card"><div class="card-num">-</div><div class="card-label">${label}</div></div>`;
  }
  // If resets_at is already in the past, the window has rolled over, but no new request has made the API
  // refresh the numbers yet. The API still returns the usage at the end of the previous window (e.g. a
  // full 100%), and computing "remaining" from it gives 0%, the exact opposite of reality (new window,
  // nothing used yet). Treat an expired window as 0 used; also clamp usage to 0..100 so an occasional
  // value above 100 from the API cannot produce negative remaining.
  const windowExpired = bucket.resetsAt && new Date(bucket.resetsAt).getTime() < Date.now();
  const usedPct = windowExpired ? 0 : Math.max(0, Math.min(100, Math.round(bucket.utilization)));
  const isSession = windowMs === SESSION_WINDOW_MS;
  const accent = usedPct >= 90 ? "accent-red" : usedPct >= 70 ? "accent-yellow" : "";
  // The session quota shows "percentage remaining" (more left = healthier); other quotas still show
  // "percentage used", but their colour is converted to "health" too (more left = greener): the numbers mean different things, the colour logic is the same.
  const displayPct = isSession ? 100 - usedPct : usedPct;
  const healthPct = isSession ? displayPct : 100 - usedPct;
  const barColor = usageBarColor(healthPct, isSession);
  const barColorLight = rgbToHex(lerpRgb(hexToRgb(barColor), [255, 255, 255], 0.6));
  let hourglass = "";
  if (bucket.resetsAt && windowMs) {
    const msLeft = new Date(bucket.resetsAt).getTime() - Date.now();
    if (!Number.isNaN(msLeft)) {
      const elapsed = 1 - Math.max(0, Math.min(1, msLeft / windowMs));
      hourglass = `<span class="hourglass-wrap" title="${t("status.usage.windowElapsed", { pct: Math.round(elapsed * 100) })}">${hourglassSvg(elapsed, barColor)}</span>`;
    }
  }
  return `
    <div class="card ${accent}">
      <div class="card-num" style="color:${barColor}">${displayPct}%</div>
      <div class="neon-bar neon-bar-lg" style="border:1px solid ${barColor}; box-shadow:0 0 10px ${withAlpha(barColor, 0.55)};">
        <div class="neon-bar-fill" style="width:${displayPct}%; background:linear-gradient(90deg, ${barColorLight}, ${barColor});"></div>
      </div>
      <div class="card-label">
        <div>${t(isSession ? "status.usage.remainingLabel" : "status.usage.usedLabel")} · ${label}</div>
        ${bucket.resetsAt ? `<div class="reset-row">${hourglass}<span>${t("status.usage.resetLabel")}: ${fmtResetAt(bucket.resetsAt)}</span></div>` : ""}
      </div>
    </div>`;
}

async function refreshUsageBoard() {
  const result = await api("/api/usage");
  const el = document.getElementById("usage-board");
  if (!result) return;
  if (result.error) {
    el.innerHTML = `<div class="empty-state">${t("status.usageError", { msg: escapeHtml(result.error) })}</div>`;
    return;
  }
  const d = result.data;
  el.innerHTML = [
    usageCard(t("status.usage.session"), d.session, SESSION_WINDOW_MS),
    usageCard(t("status.usage.weekly"), d.weekly, WEEKLY_WINDOW_MS),
    usageCard(t("status.usage.weeklySonnet"), d.weeklySonnet, WEEKLY_WINDOW_MS, true),
    usageCard(t("status.usage.weeklyOpus"), d.weeklyOpus, WEEKLY_WINDOW_MS, true),
    ...perModelWeeklyCards(d),
  ].join("");
}

// Some models (Fable, so far) have no dedicated top-level field, only a per-model limit entry in
// limits[]. usage.js already extracts these into the perModelWeekly array; here we generate as many
// cards as the array has entries, without hard-coding model names.
function perModelWeeklyCards(d) {
  return (d.perModelWeekly || []).map((m) => usageCard(t("status.usage.weeklyModel", { model: m.model }), m, WEEKLY_WINDOW_MS));
}

// ---------- Home: Anthropic account info (four usage figures + limits details + spend) ----------
const SEVERITY_COLOR = { normal: "var(--green)", warning: "var(--yellow)", critical: "var(--red)" };
function severityLabel(sev) {
  return t("home.anthropicAccount.severity." + sev) || sev || "-";
}
function limitKindLabel(kind) {
  return t("home.anthropicAccount.limitKind." + kind) || kind || "-";
}

const SEVERITY_BAR_CLASS = { normal: "sev-normal", warning: "sev-warning", critical: "sev-critical", purple: "sev-purple" };
// With a non-default colour scheme, the "percentage used" and "reset time" bars follow the same
// colours too; otherwise half the bars use the scheme colour and half the old severity colour, which
// looks like two different things. With the default scheme keep the original (severity colours): the
// "level" column already says normal/warning/critical, no need to repeat it.
function usageBarOverride(healthPct) {
  return usageScheme === "default" ? null : usageBarColor(healthPct, false);
}

function neonPercentBar(percent, severity, big, colorOverride) {
  if (percent === null || percent === undefined) return "-";
  const pct = Math.max(0, Math.min(100, percent));
  if (!colorOverride) {
    const sevClass = SEVERITY_BAR_CLASS[severity] || "sev-normal";
    return `
    <div class="neon-bar ${sevClass}${big ? " neon-bar-lg" : ""}">
      <div class="neon-bar-fill" style="width:${pct}%"></div>
    </div>
    <span class="neon-bar-pct">${percent}%</span>`;
  }
  const light = rgbToHex(lerpRgb(hexToRgb(colorOverride) || [128, 128, 128], [255, 255, 255], 0.6));
  return `
    <div class="neon-bar${big ? " neon-bar-lg" : ""}" style="border:1px solid ${colorOverride}; box-shadow:0 0 6px ${withAlpha(
    colorOverride,
    0.45
  )};">
      <div class="neon-bar-fill" style="width:${pct}%; background:linear-gradient(90deg, ${light}, ${colorOverride});"></div>
    </div>
    <span class="neon-bar-pct" style="color:${colorOverride};">${percent}%</span>`;
}

// The purple "how much of this window has elapsed" bar in the reset-time column; not the same thing as
// the quota percentage. kind=session uses the 5-hour window, the others (weekly_all/weekly_scoped) the 7-day window.
function limitElapsedBar(resetsAt, kind) {
  if (!resetsAt) return "";
  const windowMs = kind === "session" ? SESSION_WINDOW_MS : WEEKLY_WINDOW_MS;
  const msLeft = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(msLeft)) return "";
  const elapsed = Math.round((1 - Math.max(0, Math.min(1, msLeft / windowMs))) * 100);
  return `<div class="neon-bar-cell" style="margin-top:4px;">${neonPercentBar(elapsed, "purple", false, usageBarOverride(100 - elapsed))}</div>`;
}

function fmtAccountDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString();
  } catch (e) {
    return iso;
  }
}

let accountInfoCache = null;
async function fetchAccountInfo() {
  accountInfoCache = await api("/api/account");
  return accountInfoCache;
}

// Account info masking toggle: when taking screenshots, recording or pair programming, fields that
// identify a person at a glance (name, email, organisation, plan, billing method) should not be
// exposed along with them (this project has stepped on that rake in its own commit history). Affects
// only this browser's display: it does not change API responses or any data. Quota percentages are not
// masked; they are not private.
const ACCOUNT_MASK_KEY = "cc_monitor_mask_account";
const ACCOUNT_MASK_TEXT = "***";
let accountMasked = false;
try {
  accountMasked = localStorage.getItem(ACCOUNT_MASK_KEY) === "1";
} catch (e) {
  // Private mode / site data disabled: treat as off; the page still works
}

function syncAccountMaskBtns() {
  document.querySelectorAll(".account-mask-btn").forEach((btn) => {
    btn.textContent = t(accountMasked ? "home.account.unmask" : "home.account.mask");
    btn.classList.toggle("active", accountMasked);
  });
}

function toggleAccountMask() {
  accountMasked = !accountMasked;
  try {
    localStorage.setItem(ACCOUNT_MASK_KEY, accountMasked ? "1" : "0");
  } catch (e) {
    // If it cannot be stored, it applies to this session only
  }
  syncAccountMaskBtns();
  // Redraw in place from the cached account info; no need to call the API again
  renderAccountProfileInto("anthropic-profile-box", "anthropic-profile-info", accountInfoCache);
  renderAccountProfileInto("status-profile-box", "status-profile-info", accountInfoCache);
}

document.addEventListener("click", (ev) => {
  if (ev.target.closest(".account-mask-btn")) toggleAccountMask();
});

// The "folder · session · full path" line in drill-down lists: each part has its own colour, which is
// much quicker to scan in a long list than one grey line. The session id field is named sessionId or
// session_id depending on the API; both are handled here.
function sessionCwdLine(r) {
  const sid = r.sessionId || r.session_id || "";
  const cwd = r.cwd || "";
  const head = sid
    ? `<span class="folder">${escapeHtml(folderName(cwd))}</span><span class="sep"> · </span><span class="sid">${escapeHtml(
        sid.slice(0, 8)
      )}…</span><span class="sep"> · </span>`
    : "";
  return `${head}<span class="path">${escapeHtml(cwd)}</span>`;
}

function renderAccountProfileInto(boxId, listId, info) {
  const box = document.getElementById(boxId);
  const list = document.getElementById(listId);
  if (!box || !list) return;
  if (!info || (!info.email && !info.displayName)) {
    box.hidden = true;
    return;
  }
  // Masking applies only to the three fields that point to a specific person: name, email, organisation
  // name. What screenshots and recordings actually need is "nobody can tell whose account this is", not
  // blurring the whole panel. Plan type, quota tier, billing method and account/subscription creation
  // dates are account attributes, not identity; blurring them would leave the panel with nothing worth
  // showing. Masked values always show as ***, so not even the original length leaks.
  const mask = (text) => (accountMasked ? ACCOUNT_MASK_TEXT : escapeHtml(text));
  const plain = (text) => escapeHtml(text);
  // Identifiers are long (UUID 36 chars, machineID/userID 64 hex chars) and this column is only 266px
  // wide, so truncate to "first 8 … last 4" and put the full value in title for hover. When masked, title
  // must be masked too, otherwise the text is hidden but hovering reveals the original, which defeats the masking.
  const ident = (text) => {
    if (accountMasked) return ACCOUNT_MASK_TEXT;
    const v = String(text);
    const short = v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
    return `<span title="${escapeHtml(v)}" class="ident-val">${escapeHtml(short)}</span>`;
  };
  const rows = [];
  if (info.displayName) rows.push({ label: t("home.anthropicAccount.profile.name"), value: mask(info.displayName) });
  if (info.email) rows.push({ label: t("home.anthropicAccount.profile.email"), value: mask(info.email) });
  if (info.organizationName) rows.push({ label: t("home.anthropicAccount.profile.org"), value: mask(info.organizationName) });
  if (info.organizationRole) rows.push({ label: t("home.anthropicAccount.profile.role"), value: plain(info.organizationRole) });
  if (info.organizationType) rows.push({ label: t("home.anthropicAccount.profile.plan"), value: plain(info.organizationType) });
  if (info.organizationRateLimitTier) rows.push({ label: t("home.anthropicAccount.profile.rateLimitTier"), value: plain(info.organizationRateLimitTier) });
  if (info.billingType) rows.push({ label: t("home.anthropicAccount.profile.billing"), value: plain(info.billingType) });
  const createdAt = fmtAccountDate(info.accountCreatedAt);
  if (createdAt) rows.push({ label: t("home.anthropicAccount.profile.createdAt"), value: plain(createdAt) });
  const subCreatedAt = fmtAccountDate(info.subscriptionCreatedAt);
  if (subCreatedAt) rows.push({ label: t("home.anthropicAccount.profile.subCreatedAt"), value: plain(subCreatedAt) });
  // Identifiers: shown by default, masked together with "hide sensitive info".
  if (info.accountUuid) rows.push({ label: t("home.anthropicAccount.profile.accountUuid"), value: ident(info.accountUuid) });
  if (info.organizationUuid) rows.push({ label: t("home.anthropicAccount.profile.orgUuid"), value: ident(info.organizationUuid) });
  if (info.userID) rows.push({ label: t("home.anthropicAccount.profile.userId"), value: ident(info.userID) });
  if (info.machineID) rows.push({ label: t("home.anthropicAccount.profile.machineId"), value: ident(info.machineID) });
  // This machine's Claude Code status, not "who the account is". These are always shown in clear: they
  // are not identity information, and they are exactly what you need when troubleshooting a broken hook; masking them is pointless.
  if (info.claudeCodeVersion) {
    const v = info.claudeCodeVersion;
    rows.push({
      label: t("home.anthropicAccount.profile.ccVersion"),
      value: plain(v.value) + (v.approx ? ` <span class="approx-tag" title="${t("home.anthropicAccount.profile.ccVersionApproxTip")}">${t("home.anthropicAccount.profile.approx")}</span>` : ""),
    });
  }
  if (info.installMethod) rows.push({ label: t("home.anthropicAccount.profile.installMethod"), value: plain(info.installMethod) });
  if (info.autoUpdates !== null && info.autoUpdates !== undefined) {
    rows.push({
      label: t("home.anthropicAccount.profile.autoUpdates"),
      value: plain(t(info.autoUpdates ? "common.on" : "common.off")),
    });
  }
  if (typeof info.mcpServerCount === "number") {
    const names = (info.mcpServerNames || []).join(", ");
    rows.push({
      label: t("home.anthropicAccount.profile.mcpServers"),
      value: names
        ? `<span title="${escapeHtml(names)}">${t("home.anthropicAccount.profile.mcpCount", { n: info.mcpServerCount })}</span>`
        : plain(t("home.anthropicAccount.profile.mcpCount", { n: info.mcpServerCount })),
    });
  }
  box.hidden = rows.length === 0;
  list.innerHTML = rows.map((r) => `<div class="bar-row"><span class="name">${r.label}</span><span>${r.value}</span></div>`).join("");
}

async function refreshAccountProfile() {
  const info = await fetchAccountInfo();
  renderAccountProfileInto("anthropic-profile-box", "anthropic-profile-info", info);
  renderAccountProfileInto("status-profile-box", "status-profile-info", info);
}

// Quota details (limits) table: Home and the Status page each have their own DOM (the same data rendered
// twice). The Status page copy uses the longer, bolder neon-bar-lg; Home keeps the original small version.
function renderLimitsInto(box, list, limits) {
  if (!box || !list) return;
  if (!limits || limits.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const big = box.id === "status-limits-box";
  list.innerHTML = `
    <table class="dd-table">
      <thead><tr>
        <th>${t("home.anthropicAccount.limitKindCol")}</th><th>${t("home.anthropicAccount.percentCol")}</th>
        <th>${t("home.anthropicAccount.severityCol")}</th><th>${t("home.anthropicAccount.resetCol")}</th><th>${t("home.anthropicAccount.activeCol")}</th>
      </tr></thead>
      <tbody>
        ${limits
          .map(
            (l) => `
          <tr>
            <td>${escapeHtml(limitKindLabel(l.kind))}${l.scopeModel ? ` (${escapeHtml(l.scopeModel)})` : ""}</td>
            <!-- .neon-bar-cell must be wrapped in a div, not put on the <td> itself: once display:flex
                 is applied directly to a <td>, the cell no longer stretches to the height of the tallest
                 sibling cell in the row (the "reset time" column has two lines and makes the row taller),
                 so the percentage bar sticks to the top of the cell with empty space below and looks
                 misaligned with the other columns of the same row. -->
            <td><div class="neon-bar-cell">${neonPercentBar(l.percent, l.severity, big, usageBarOverride(100 - (l.percent || 0)))}</div></td>
            <td><span style="color:${SEVERITY_COLOR[l.severity] || "var(--text-dim)"}">${escapeHtml(severityLabel(l.severity))}</span></td>
            <td class="dd-mono">${l.resetsAt ? fmtResetAt(l.resetsAt) : "-"}${limitElapsedBar(l.resetsAt, l.kind)}</td>
            <td>${l.isActive ? "●" : "-"}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

// Rightmost card of the Home status summary: session quota remaining percentage + mini neon bar + reset
// countdown. Same data and same conky banded colours as the large card in the account section below, just smaller.
function renderStripUsage(bucket) {
  const el = document.getElementById("strip-usage");
  if (!el) return;
  const title = `<div class="strip-title">${t("home.strip.sessionQuota")}</div>`;
  if (!bucket || bucket.utilization === null) {
    el.innerHTML = `<div class="strip-num" style="color:var(--text-dim)">-</div><div class="strip-body">${title}<div class="strip-cap">${t("home.strip.quotaUnavailable")}</div></div>`;
    return;
  }
  const windowExpired = bucket.resetsAt && new Date(bucket.resetsAt).getTime() < Date.now();
  const usedPct = windowExpired ? 0 : Math.max(0, Math.min(100, Math.round(bucket.utilization)));
  const remaining = 100 - usedPct;
  const color = usageBarColor(remaining, true);
  const light = rgbToHex(lerpRgb(hexToRgb(color), [255, 255, 255], 0.6));
  const reset = bucket.resetsAt ? fmtResetAt(bucket.resetsAt).replace(/\s*\(.*\)$/, "") : "";
  el.innerHTML = `
    <div class="strip-num" style="color:${color}">${remaining}%</div>
    <div class="strip-body">
      ${title}
      <div class="neon-bar" style="border:1px solid ${color}; box-shadow:0 0 8px ${withAlpha(color, 0.45)};"><div class="neon-bar-fill" style="width:${remaining}%; background:linear-gradient(90deg, ${light}, ${color});"></div></div>
      ${reset ? `<div class="strip-cap">${t("home.strip.quotaReset", { when: reset })}</div>` : ""}
    </div>`;
}

async function refreshHomeAnthropicInfo() {
  await refreshAccountProfile();
  const result = await api("/api/usage");
  const cardsEl = document.getElementById("anthropic-usage-cards");
  const limitsBox = document.getElementById("anthropic-limits-box");
  const limitsList = document.getElementById("anthropic-limits-list");
  const spendBox = document.getElementById("anthropic-spend-box");
  const spendInfo = document.getElementById("anthropic-spend-info");
  if (!result) return;
  if (result.error) {
    cardsEl.innerHTML = `<div class="empty-state">${t("status.usageError", { msg: escapeHtml(result.error) })}</div>`;
    limitsBox.hidden = true;
    spendBox.hidden = true;
    renderStripUsage(null);
    return;
  }
  const d = result.data;
  renderStripUsage(d.session);
  cardsEl.innerHTML = [
    usageCard(t("status.usage.session"), d.session, SESSION_WINDOW_MS),
    usageCard(t("status.usage.weekly"), d.weekly, WEEKLY_WINDOW_MS),
    usageCard(t("status.usage.weeklySonnet"), d.weeklySonnet, WEEKLY_WINDOW_MS, true),
    usageCard(t("status.usage.weeklyOpus"), d.weeklyOpus, WEEKLY_WINDOW_MS, true),
    ...perModelWeeklyCards(d),
  ].join("");

  renderLimitsInto(limitsBox, limitsList, d.limits);
  renderLimitsInto(document.getElementById("status-limits-box"), document.getElementById("status-limits-list"), d.limits);

  if (d.spend) {
    spendBox.hidden = false;
    const s = d.spend;
    const rows = [];
    rows.push({ label: t("home.anthropicAccount.spendEnabled"), value: s.enabled ? t("home.anthropicAccount.yes") : t("home.anthropicAccount.no") });
    if (s.enabled) {
      const amount = s.usedAmountMinor !== null ? (s.usedAmountMinor / Math.pow(10, s.exponent)).toFixed(s.exponent) : "-";
      rows.push({ label: t("home.anthropicAccount.spendUsed"), value: `${amount} ${s.currency || ""}` });
      rows.push({ label: t("home.anthropicAccount.spendPercent"), value: s.percent === null ? "-" : s.percent + "%" });
      rows.push({ label: t("home.anthropicAccount.spendCanPurchase"), value: s.canPurchaseCredits ? t("home.anthropicAccount.yes") : t("home.anthropicAccount.no") });
    } else if (s.disabledReason) {
      rows.push({ label: t("home.anthropicAccount.spendDisabledReason"), value: escapeHtml(s.disabledReason) });
    }
    spendInfo.innerHTML = rows.map((r) => `<div class="bar-row"><span class="name">${escapeHtml(r.label)}</span><span>${r.value}</span></div>`).join("");
  } else {
    spendBox.hidden = true;
  }
  // The account info box on the left: when both the account details and spend are empty (e.g. no login
  // credentials), collapse it entirely instead of leaving an empty frame.
  const accountCol = document.querySelector(".home-account .account-col");
  if (accountCol) accountCol.hidden = document.getElementById("anthropic-profile-box").hidden && spendBox.hidden;
}

// ---------- Detect the identity the claude process runs as ----------
let identityLastResult = null;
async function refreshIdentityCard() {
  const result = await api("/api/claude-processes");
  if (!result) return;
  identityLastResult = result;
  document.getElementById("stat-identity-total").textContent = String(result.total);

  // Mini heartbeat badge on the "Claude Code sessions detected" card: shown as soon as any process is in
  // the working state, giving Home an at-a-glance "something is happening right now" signal. When all
  // are idle or there are no processes it takes no space at all (hidden), rather than always showing a lifeless icon.
  const vitalBadge = document.getElementById("stat-sessions-vital");
  if (vitalBadge) {
    const anyWorking = result.processes.some((p) => p.status === "working");
    vitalBadge.hidden = !anyWorking;
    vitalBadge.innerHTML = anyWorking ? renderVital("working", 0) : "";
  }

  const banner = document.getElementById("identity-mismatch-banner");
  if (result.mismatchedUsers.length > 0) {
    banner.hidden = false;
    banner.textContent = t("home.identity.mismatchWarning", {
      n: result.mismatchedUsers.reduce((sum, u) => sum + result.byUser[u], 0),
      users: result.mismatchedUsers.join(", "),
    });
  } else {
    banner.hidden = true;
  }

  const byUserEl = document.getElementById("identity-by-user");
  const users = Object.keys(result.byUser);
  if (users.length === 0) {
    byUserEl.innerHTML = "";
  } else {
    byUserEl.innerHTML = users
      .map((u) => {
        const isCurrent = u === result.currentUser;
        return `<div class="bar-row"><span class="name">${escapeHtml(u)}${isCurrent ? " " + t("home.identity.currentTag") : ""}</span><span>${result.byUser[u]}</span></div>`;
      })
      .join("");
  }
}

// ---------- Claude Code network traffic ----------
function formatBytes(n) {
  if (n === null || n === undefined) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

let networkMap = null;
function ensureNetworkMap() {
  if (networkMap || !window.NetworkWorldMap) return;
  const canvas = document.getElementById("network-map-canvas");
  networkMap = new NetworkWorldMap(canvas);
  if (!networkMap.ok) {
    document.getElementById("network-map-empty").hidden = false;
    document.getElementById("network-map-empty").textContent = t("network.mapNoWebgl");
    return;
  }
  networkMap.loadLand("/world.geo.json");
}

async function refreshNetworkTraffic() {
  const [trafficResult, geoResult] = await Promise.all([
    api(`/api/network-traffic?limit=200&lang=${currentLang}`),
    api(`/api/network-traffic/geopairs?limit=500&lang=${currentLang}`),
  ]);
  if (!trafficResult) return;

  const badge = document.getElementById("network-geo-badge");
  const geo = trafficResult.geo;
  if (geo.available) {
    badge.hidden = false;
    badge.className = "geo-acc-badge geo-acc-" + geo.accuracy;
    badge.textContent = geo.accuracy === "city" ? t("network.geoCity") : t("network.geoCountry");
    badge.title = geo.dbPath;
  } else {
    badge.hidden = false;
    badge.className = "geo-acc-badge geo-acc-none";
    badge.textContent = t("network.geoNone");
    badge.title = t("network.geoNoneHint");
  }

  const s = trafficResult.summary;
  document.getElementById("network-summary").innerHTML = `
    <div class="card dense"><div class="card-num">${formatBytes(s.txBytes)}</div><div class="card-label">${t("network.totalTx")}</div></div>
    <div class="card dense"><div class="card-num">${formatBytes(s.rxBytes)}</div><div class="card-label">${t("network.totalRx")}</div></div>
    <div class="card dense clickable" data-drilldown="ai-trajectory"><div class="card-num">${s.connectCount}</div><div class="card-label">${t("network.totalConnects")} <span class="click-hint">${t("home.card.clickHint")}</span></div></div>
    <div class="card dense clickable" data-drilldown="ai-trajectory"><div class="card-num">${s.distinctIps}</div><div class="card-label">${t("network.distinctIps")} <span class="click-hint">${t("home.card.clickHint")}</span></div></div>
  `;

  const rows = trafficResult.rows;
  const tableWrap = document.getElementById("network-table-wrap");
  if (rows.length === 0) {
    tableWrap.innerHTML = `<div class="empty-state">${t("network.empty")}</div>`;
  } else {
    tableWrap.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("network.col.target")}</th><th>${t("network.col.location")}</th>
          <th>${t("network.col.tx")}</th><th>${t("network.col.rx")}</th>
          <th>${t("network.col.connects")}</th><th>${t("network.col.lastSeen")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const badge = r.inferred ? `<span class="dd-badge-inferred" title="${t("network.inferredHint")}">${t("network.inferredBadge")}</span> ` : "";
              const target = r.host ? `${badge}${escapeHtml(r.host)}<br><span class="dd-mono hint">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>` : `${badge}<span class="dd-mono">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>`;
              const countryLabel = r.geo ? r.geo.country || r.geo.countryCode : null;
              const loc = r.geo ? escapeHtml([r.geo.city, countryLabel].filter(Boolean).join(", ") || "-") : `<span class="hint">${t("network.noLocation")}</span>`;
              return `<tr>
                <td>${target}</td>
                <td>${loc}</td>
                <td>${formatBytes(r.txBytes)}</td>
                <td>${formatBytes(r.rxBytes)}</td>
                <td><span class="dd-open-hint" style="cursor:pointer;" data-target-ip="${escapeHtml(r.ip)}" data-target-port="${r.port}" data-target-host="${escapeHtml(r.host || "")}">${r.connectCount} ›</span></td>
                <td class="dd-mono">${escapeHtml((r.lastSeen || "").slice(0, 19))}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  if (networkMap && networkMap.ok && geoResult) {
    document.getElementById("network-map-empty").hidden = geoResult.pairs.length > 0;
    if (geoResult.pairs.length === 0) document.getElementById("network-map-empty").textContent = t("network.mapEmpty");
    networkMap.setData(geoResult.pairs);
  }
}

// ---------- Operation timeline ----------
let sessionTimeline = null;
function ensureSessionTimeline() {
  if (sessionTimeline || !window.SessionTimeline) return;
  sessionTimeline = new SessionTimeline(document.getElementById("timeline-canvas"), document.getElementById("timeline-tooltip"));
  // Clicking a lane = view that session's full operation sequence: reuse the Audit Log page's existing
  // per-session filter instead of building another per-event renderer (fmt.describe()'s summaries/highlighting live there).
  sessionTimeline.onLaneClick = (sessionId, range) => {
    document.getElementById("timeline-tooltip").hidden = true;
    openSessionFlow(sessionId, range);
  };
  sessionTimeline.tooltipHtml = (lane, bucket, bucketMs) => {
    const head = `<div class="tt-title">${escapeHtml(folderName(lane.cwd) || lane.sessionId)}</div>
      <div class="hint">${escapeHtml(lane.sessionId.slice(0, 8))}…${lane.model ? " · " + escapeHtml(modelShort(lane.model)) : ""}</div>`;
    if (!bucket) {
      return `${head}<div>${t("timeline.tt.total", { n: lane.eventCount })}${lane.blockedCount ? " · " + t("timeline.tt.blocked", { n: lane.blockedCount }) : ""}</div>
        <div class="hint">${t("timeline.tt.clickHint")}</div>`;
    }
    const s = new Date(bucket.startMs);
    const e = new Date(bucket.startMs + bucketMs);
    const risks = ["high", "medium", "low", "info"]
      .map((r) => ({ r, n: bucket["n" + r[0].toUpperCase() + r.slice(1)] }))
      .filter((x) => x.n > 0)
      .map((x) => `<span style="color:${RISK_COLOR[x.r]}">●</span> ${riskLabel(x.r)} ${x.n}`)
      .join("&nbsp;&nbsp;");
    return `${head}
      <div>${fmtTime24(s)} – ${fmtTime24(e)}</div>
      <div>${t("timeline.tt.events", { n: bucket.n })}${bucket.nBlocked ? ` · <span style="color:var(--red)">${t("timeline.tt.blocked", { n: bucket.nBlocked })}</span>` : ""}</div>
      <div>${risks}</div>
      <div class="hint">${t("timeline.tt.clickHint")}</div>`;
  };
}

function timelineBucketLabel(bucketMs) {
  const zh = currentLang === "zh";
  if (bucketMs < 60 * 60 * 1000) return `${bucketMs / 60000} ${zh ? "分钟" : "min"}`;
  return `${bucketMs / 3600000} ${zh ? "小时" : "h"}`;
}

// Fetch data only while the Timeline page is visible: this endpoint scans and buckets the events of the
// last few dozen sessions, heavier than other polls, so there is no point recomputing it every 15 seconds while another page is open.
async function refreshTimeline() {
  if (!document.getElementById("view-timeline").classList.contains("active")) return;
  ensureSessionTimeline();
  if (!sessionTimeline) return;
  const range = document.getElementById("timeline-range").value;
  const data = await api(`/api/timeline?range_minutes=${encodeURIComponent(range)}&lanes=50`);
  if (!data) return;
  // Keep only sessions with operations inside the window: among the top N that listSessions returns by
  // last activity, some may have their last operation before the window start; drawn, they are empty lanes that just take up space.
  data.lanes = data.lanes.filter((l) => l.buckets.length > 0);
  const empty = document.getElementById("timeline-empty");
  empty.hidden = data.lanes.length > 0;
  if (!data.lanes.length) empty.textContent = t("timeline.empty");
  document.getElementById("timeline-axis-note").textContent = t("timeline.axisNote", { bucket: timelineBucketLabel(data.bucketMs) });
  sessionTimeline.setData(data);
}

document.getElementById("timeline-range").addEventListener("change", refreshTimeline);

// The two canvases (timeline, flow-chart minimap) read their colours from CSS variables at render time,
// so redraw them after a theme switch, otherwise they keep the previous theme's colours (dark text becomes invisible on the dark theme)
new MutationObserver(() => {
  if (sessionTimeline) sessionTimeline.render();
  if (sessionFlowGraph) sessionFlowGraph._drawMinimap();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// ---------- Session flow chart ----------
let sessionFlowGraph = null;
let flowSessionId = null;
let flowLive = false;
let flowData = null;
let flowDetailState = null; // {node, turn}: redraw the detail panel in the current language on a language switch

function openLogsForSession(sessionId) {
  document.querySelector('.tab-btn[data-tab="logs"]').click();
  if (![...logFilter.options].some((o) => o.value === sessionId)) {
    const opt = document.createElement("option");
    opt.value = sessionId;
    opt.textContent = sessionId.slice(0, 8) + "…";
    logFilter.appendChild(opt);
  }
  logFilter.value = sessionId;
  logFilter.dispatchEvent(new Event("change"));
}

function flowToolLabel(node) {
  if (node.type === "observe") return node.label;
  return KNOWN_TOOLS.has(node.tool) ? t("tool." + node.tool) : node.tool || node.label;
}

function ensureSessionFlow() {
  if (sessionFlowGraph || !window.SessionFlowGraph) return;
  sessionFlowGraph = new SessionFlowGraph(document.getElementById("flow-viewport"), {
    text: t,
    toolLabel: flowToolLabel,
    onNodeClick: (node, turn) => renderFlowDetail(node, turn),
  });
}

function flowReasonText(n) {
  if (n.reason) return t("flow.reason." + n.reason, { d: n.detail || "" });
  if (["blocked", "running", "background"].includes(n.status)) return t("flow.reason." + n.status);
  return "";
}

function fdRow(k, vHtml) {
  return vHtml ? `<div class="fd-row"><span class="k">${escapeHtml(k)}</span><span class="v">${vHtml}</span></div>` : "";
}

function flowDurationText(msv) {
  if (msv === null || msv === undefined) return "";
  // hook timestamps are only accurate to the second
  if (msv < 1000) return "< 1 s";
  return Math.round(msv / 1000) + " s";
}

function renderFlowDetail(node, turn) {
  const box = document.getElementById("flow-detail");
  flowDetailState = { node, turn };
  if (!node && !turn) {
    box.innerHTML = `<div class="empty-state">${escapeHtml(t("flow.detailEmpty"))}</div>`;
    return;
  }
  if (!node) {
    const s = turn.stats || {};
    const span = turn.startTs ? fmtDateTime24(new Date(turn.startTs)) + (turn.endTs ? " → " + fmtTime24(new Date(turn.endTs)) : "") : "";
    const stats = ["ok", "warn", "fail", "blocked", "running", "background"]
      .filter((k) => s[k])
      .map((k) => `<span class="fc-chip fc-st-${k}">${t("flow.status." + k)} ${s[k]}</span>`)
      .join(" · ");
    box.innerHTML = `
      <div class="fd-title">${escapeHtml(turn.prompt ? t("flow.d.prompt") : t("flow.turn.start"))}</div>
      ${fdRow(t("flow.d.time"), escapeHtml(span))}
      ${fdRow(t("flow.d.stats"), stats || escapeHtml(t("flow.turn.noOps")))}
      ${turn.subagentStops ? fdRow("", escapeHtml(t("flow.d.subagents", { n: turn.subagentStops }))) : ""}
      ${turn.prompt ? `<div class="fd-block"><div class="fd-pre">${escapeHtml(turn.prompt.text)}</div></div>` : ""}`;
    return;
  }
  const statusHtml = `<span class="fc-status fc-st-${escapeHtml(node.status)}">${escapeHtml(t("flow.status." + node.status))}</span>`;
  const reason = flowReasonText(node);
  const timeHtml = escapeHtml(fmtDateTime24(new Date(node.startTs)) + (node.endTs && node.endTs !== node.startTs ? " → " + fmtTime24(new Date(node.endTs)) : ""));
  const ruleHtml = node.matchedRule
    ? `${escapeHtml(ruleTitle(node.matchedRule) || node.matchedRule)}<br><span class="hint dd-mono">${escapeHtml(node.matchedRule)}</span>${ruleDesc(node.matchedRule) ? `<br><span class="hint">${escapeHtml(ruleDesc(node.matchedRule))}</span>` : ""}`
    : "";
  const extras = (node.extra || [])
    .map((e) => `<div class="fd-block">${e.label ? `<div class="k">${escapeHtml(translateExtraLabel(e.label))}</div>` : ""}<div class="fd-pre">${e.html}</div></div>`)
    .join("");
  let items = "";
  if (node.type === "group") {
    items = `<div class="fd-block"><div class="k">${escapeHtml(t("flow.d.items", { n: node.count }))}</div><ul class="fd-items">${node.items
      .map((it, i) => `<li data-item="${i}"><span class="t">${escapeHtml(fmtTime24(new Date(it.startTs)))}</span>${it.summaryHtml}</li>`)
      .join("")}</ul></div>`;
  }
  box.innerHTML = `
    <div class="fd-title">${escapeHtml(flowToolLabel(node))}${node.type === "group" ? " ×" + node.count : ""}</div>
    ${fdRow(t("flow.d.status"), statusHtml)}
    ${fdRow(t("flow.d.why"), escapeHtml(reason))}
    ${fdRow(t("flow.d.time"), timeHtml)}
    ${fdRow(t("flow.d.duration"), escapeHtml(flowDurationText(node.durationMs)))}
    ${fdRow(t("flow.d.tool"), escapeHtml(node.tool || ""))}
    ${node.risk && node.risk !== "-" ? fdRow(t("flow.d.risk"), `<span style="color:${RISK_COLOR[node.risk] || "inherit"}">● </span>${escapeHtml(riskLabel(node.risk))}`) : ""}
    ${node.decision ? fdRow(t("flow.d.decision"), escapeHtml(decisionLabel(node.decision))) : ""}
    ${fdRow(t("flow.d.rule"), ruleHtml)}
    ${node.type !== "group" ? `<div class="fd-block"><div class="k">${escapeHtml(t("flow.d.content"))}</div><div class="fd-pre">${node.summaryHtml || "-"}</div></div>` : ""}
    ${extras}
    ${items}
    ${node.eventIds ? fdRow(t("flow.d.events"), `<span class="dd-mono">${node.eventIds.map((x) => "#" + x).join(" ")}</span>`) : ""}`;
  if (node.type === "group") {
    box.querySelectorAll(".fd-items li").forEach((li) => {
      li.addEventListener("click", () => renderFlowDetail(node.items[Number(li.dataset.item)], turn));
    });
  }
}

// Title bar session name + hint bar: separate from the flow chart itself, so a language switch can redraw them without a new request
function renderFlowChrome(data) {
  const label = [folderName(data.cwd), modelShort(data.model), data.sessionId.slice(0, 8) + "…"].filter(Boolean).join(" · ");
  document.getElementById("flow-session-label").textContent = label;
  document.getElementById("flow-session-label").title = `${data.cwd || ""}\nID: ${data.sessionId}`;
  const notes = [];
  if (data.truncated) notes.push(t("flow.truncated", { n: 3000 }));
  if (data.turns.some((tt) => tt.nodes.some((n) => n.branch))) notes.push(t("flow.subagentNote"));
  if (!data.turns.length) notes.push(t("flow.empty"));
  const noteEl = document.getElementById("flow-note");
  noteEl.hidden = !notes.length;
  noteEl.textContent = notes.join(" ");
}

async function loadSessionFlow({ keepView }) {
  const data = await api(`/api/session-flow?session_id=${encodeURIComponent(flowSessionId)}`);
  if (!data || data.sessionId !== flowSessionId) return null;
  flowLive = !!data.live;
  flowData = data;
  renderFlowChrome(data);
  sessionFlowGraph.setData(data, { keepView });
  return data;
}

// Language switch: redraw in the new language from the data we already have, without a new request (a
// language switch triggers a full refresh round, and the flow-chart request is queued late, so for a
// good while the cards would still be in the old language)
function rerenderSessionFlowText() {
  if (!flowData || !sessionFlowGraph || document.getElementById("flow-section").hidden) return;
  renderFlowChrome(flowData);
  sessionFlowGraph.setData(flowData, { keepView: true });
  if (flowDetailState) renderFlowDetail(flowDetailState.node, flowDetailState.turn);
}

async function openSessionFlow(sessionId, range) {
  ensureSessionFlow();
  if (!sessionFlowGraph) return;
  const section = document.getElementById("flow-section");
  section.hidden = false;
  const switching = flowSessionId !== sessionId;
  flowSessionId = sessionId;
  if (switching) {
    renderFlowDetail(null, null);
    const noteEl = document.getElementById("flow-note");
    noteEl.hidden = false;
    noteEl.textContent = t("flow.loading");
  }
  if (Object.keys(ruleMetaCache).length === 0) refreshRuleMeta();
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  const data = await loadSessionFlow({ keepView: !switching });
  if (data && range) sessionFlowGraph.focusRange(range.startMs, range.endMs);
}

// Sessions in progress refresh every 15 seconds with the timeline; finished sessions need no repeated fetching
async function refreshSessionFlow() {
  if (!flowSessionId || !flowLive || document.getElementById("flow-section").hidden) return;
  if (!document.getElementById("view-timeline").classList.contains("active")) return;
  await loadSessionFlow({ keepView: true });
}

document.getElementById("flow-close").addEventListener("click", () => {
  document.getElementById("flow-section").hidden = true;
  flowSessionId = null;
  flowData = null;
  flowDetailState = null;
});
document.getElementById("flow-open-logs").addEventListener("click", () => {
  if (flowSessionId) openLogsForSession(flowSessionId);
});

// ---------- Startup ----------
function refreshEverythingNow() {
  refreshSessionList();
  refreshLogSessionOptions();
  pollLogs();
  pollTap();
  refreshOverview();
  refreshStatusBoard();
  refreshModelUsage();
  refreshUsageBoard();
  refreshHomeAnthropicInfo();
  refreshTerminalStatusline();
  refreshAuditState();
  refreshRemoteAccessState();
  refreshApprovals();
  refreshApprovalHistory();
  refreshIdentityCard();
  refreshNetworkTraffic();
  refreshTimeline();
}

// Browsers heavily throttle setInterval in background tabs (sometimes to once every few minutes) to
// save power. With polling alone, new sessions/events that happen while the tab is in the background
// keep showing as stale until the next tick the throttler lets through. Force a refresh the moment the
// tab comes back to the foreground, so what you look at is always current without waiting for polling to recover.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshEverythingNow();
});
window.addEventListener("focus", refreshEverythingNow);

// ---------- Language / theme switching ----------
document.getElementById("theme-select").addEventListener("change", (ev) => applyTheme(ev.target.value));

// ---------- Appearance settings dialog (theme swatches / font / font size) ----------
function buildThemeSwatchGrid() {
  const grid = document.getElementById("theme-swatch-grid");
  grid.innerHTML = THEMES.map(
    (theme) => `
    <button type="button" class="theme-swatch${theme === currentTheme ? " active" : ""}" data-theme="${theme}">
      <span class="swatch-dot" style="background:${THEME_ACCENT[theme]}"></span>
      ${t("theme." + theme)}
    </button>`
  ).join("");
  grid.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  });
}

const settingsModal = document.getElementById("settings-modal");
document.getElementById("settings-btn").addEventListener("click", () => {
  buildThemeSwatchGrid();
  settingsModal.hidden = false;
});
document.getElementById("settings-close-btn").addEventListener("click", () => (settingsModal.hidden = true));
settingsModal.addEventListener("click", (ev) => {
  if (ev.target === settingsModal) settingsModal.hidden = true;
});
document.getElementById("font-family-select").addEventListener("change", (ev) => applyFont(ev.target.value));
document.getElementById("font-size-range").addEventListener("input", (ev) => applyFontSize(ev.target.value));
document.getElementById("settings-reset-btn").addEventListener("click", () => {
  applyTheme("brand");
  applyFont("system");
  applyFontSize(14);
  buildThemeSwatchGrid();
});
document.getElementById("lang-toggle-btn").addEventListener("click", () => {
  setLang(currentLang === "zh" ? "en" : "zh");
  syncGridToggleBtnText();
  syncApprovalsNotifyBtn();
  syncAccountMaskBtns();
  syncNewSessionModalText();
  setGpuState(gpuState);
  // Static text was already refreshed in setLang -> applyStaticI18n. Log/Tap entries already appended to
  // the lists are not re-translated automatically (they are generated DOM, not "state"), so clear them and fetch again.
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  refreshEverythingNow();
  rerenderSessionFlowText();
});

async function bootstrap() {
  applyTheme(currentTheme);
  applyFont(currentFont);
  applyFontSize(currentFontSize);
  applyStaticI18n();
  syncGridToggleBtnText();
  syncApprovalsNotifyBtn();
  syncAccountMaskBtns();
  syncUsageSchemeSelects();

  const initialSessions = await refreshSessionList();
  const lastId = getLastSession();
  if (lastId && (initialSessions || []).some((s) => s.id === lastId)) {
    selectSession(lastId);
  }
  await refreshLogSessionOptions();
  await pollLogs();
  await refreshOverview();
  await refreshStatusBoard();
  await refreshModelUsage();
  await refreshUsageBoard();
  await refreshHomeAnthropicInfo();
  await refreshAuditState();
  await refreshRemoteAccessState();
  await refreshApprovals();
  await refreshIdentityCard();

  setInterval(refreshSessionList, 4000);
  setInterval(refreshLogSessionOptions, 8000);
  setInterval(pollLogs, 1500);
  setInterval(pollTap, 2000);
  setInterval(refreshOverview, 5000);
  setInterval(refreshStatusBoard, 5000);
  setInterval(refreshUsageBoard, 30000); // the backend already caches for 180 s, the front end need not ask often
  setInterval(refreshHomeAnthropicInfo, 30000);
  setInterval(refreshTerminalStatusline, 5000);
  setInterval(refreshAuditState, 5000);
  setInterval(refreshRemoteAccessState, 15000); // security-related but rarely changes; no need to poll as often as the audit state
  setInterval(refreshIdentityCard, 15000); // the process identity rarely changes either; same pace as the remote access toggle
  setInterval(refreshApprovals, 2000); // these block waiting for an answer, so the poll interval is shorter than all others
  setInterval(refreshNetworkTraffic, 10000);
  setInterval(refreshTimeline, 15000);
  setInterval(refreshSessionFlow, 15000);
}
bootstrap();
