"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");
// At startup, make sure node-pty's spawn-helper has its executable bit (see
// scripts/fix-node-pty-perms.js; without it pty.spawn throws "posix_spawnp failed."). Idempotent,
// usually does nothing.
try {
  require("../scripts/fix-node-pty-perms").fixNodePtyPerms();
} catch (e) {
  // If it cannot be fixed (read-only file system and the like), never mind; a real problem will surface at spawn below
}

const SCROLLBACK_LIMIT = 5000;

// If the CC-Monitor Node process itself was started inside a Claude Code session (e.g. running
// `node server.js` directly in claude during development, a perfectly normal thing to do),
// process.env carries that "outer" session's CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_CHILD_SESSION
// and similar variables. If a new terminal session inherits them unchanged, the claude it spawns
// is treated as a "child session" of the outer session rather than an independent top-level
// session. The observed effect is that it never writes its own transcript .jsonl file (so the
// transcript-based info in the Web UI, model ID and token usage, is always empty; nothing to do
// with whether the directory is /tmp, it is purely environment variable pollution). Strip these
// variables before creating the terminal so the claude in every Web UI terminal session is a
// genuine independent top-level session.
const CLAUDE_ENV_PREFIX = /^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/;
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!CLAUDE_ENV_PREFIX.test(k)) env[k] = v;
  }
  return env;
}

// Claude Code draws its trust confirmation prompt word by word with "ESC[<N>G" (absolute cursor
// positioning), not ordinary spaces, so "Yes, I trust this folder" is never a contiguous substring
// of the raw stream. Strip ANSI escape sequences and whitespace before comparing;
// "trustthisfolder" is always contiguous once whitespace is gone.
function stripAnsiAndSpace(s) {
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

class SessionManager {
  constructor() {
    this.sessions = new Map(); // id -> session record
  }

  create({ cwd, cols = 100, rows = 30, launchClaude = true } = {}) {
    const id = crypto.randomUUID();
    const shell = process.env.SHELL || "/bin/bash";
    const workDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workDir,
      env: cleanEnv(),
    });

    const session = {
      id,
      cwd: workDir,
      createdAt: Date.now(),
      pty: term,
      clients: new Set(),
      scrollback: [],
      alive: true,
      exitCode: null,
      lastOutputAt: Date.now(),
    };

    // The first time Claude Code starts in a directory it has not trusted yet, it shows a "trust
    // this folder?" confirmation prompt whose default highlighted option is "No, exit". If nobody
    // answers it, Claude Code stays stuck on that prompt; and if any later keyboard input ends
    // with Enter (even the user's normal typing), it selects "No, exit", quits Claude Code and
    // drops back to a bare shell. The screen looks perfectly normal (the zsh prompt works), but
    // Claude Code is gone. Since this terminal was opened from our own "new session" entry point,
    // the user has effectively already confirmed opening this directory, so when the prompt is
    // detected we press Down + Enter to choose "Yes, I trust this folder".
    let trustPromptHandled = false;
    let recentOutput = "";

    term.onData((data) => {
      session.lastOutputAt = Date.now();
      session.scrollback.push(data);
      if (session.scrollback.length > SCROLLBACK_LIMIT) session.scrollback.shift();
      this._broadcast(session, { type: "data", data });

      if (!trustPromptHandled) {
        recentOutput = (recentOutput + data).slice(-8000);
        if (stripAnsiAndSpace(recentOutput).includes("yes,itrustthisfolder")) {
          trustPromptHandled = true;
          setTimeout(() => {
            if (session.alive) term.write("\x1b[B");
            setTimeout(() => {
              if (session.alive) term.write("\r");
            }, 120);
          }, 150);
        }
      }
    });

    term.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;
      this._broadcast(session, { type: "exit", exitCode });
    });

    this.sessions.set(id, session);

    // "New window" (launchClaude:false) wants a bare shell that does not type claude
    // automatically. It shares the PTY / trust-prompt logic with "new session"; the only
    // difference is whether this one line runs.
    if (launchClaude) {
      // Launch Claude Code directly in this session's shell, like a user typing it.
      setTimeout(() => {
        if (session.alive) term.write("claude\r");
      }, 150);
    }

    return session;
  }

  _broadcast(session, payload) {
    const msg = JSON.stringify(payload);
    for (const ws of session.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
      alive: s.alive,
      exitCode: s.exitCode,
      clientCount: s.clients.size,
      lastOutputAt: s.lastOutputAt,
    }));
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return;
    try {
      s.pty.write(data);
    } catch (e) {
      // The pty happened to exit at this instant; ignore it, the onExit callback updates the alive flag
    }
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.alive && cols > 0 && rows > 0) {
      try {
        s.pty.resize(cols, rows);
      } catch (e) {
        // pty already exited; ignore
      }
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.kill();
    } catch (e) {
      // already dead
    }
    this.sessions.delete(id);
    return true;
  }
}

module.exports = { SessionManager };
