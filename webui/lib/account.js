"use strict";
// Account profile (name/email/organization/plan). This does not call an Anthropic API: it is the
// oauthAccount field in ~/.claude.json, the global config file Claude Code keeps locally. The
// "Claude Account Email" widget in ccstatusline reads the same file (path and field names
// confirmed by decompiling its dist package). Purely a local file read, with no network request
// and no credential material: oauthAccount holds no token, only the profile itself.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readClaudeOauth } = require("./credentials");

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");

function getAccountInfo() {
  const info = {};
  try {
    const raw = fs.readFileSync(CLAUDE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const oa = parsed?.oauthAccount;
    if (oa) {
      info.displayName = oa.displayName || oa.fullName || null;
      info.email = oa.emailAddress || null;
      info.organizationName = oa.organizationName || null;
      info.organizationRole = oa.organizationRole || null;
      info.organizationType = oa.organizationType || null;
      info.organizationRateLimitTier = oa.organizationRateLimitTier || null;
      info.accountCreatedAt = oa.accountCreatedAt || null;
      info.subscriptionCreatedAt = oa.subscriptionCreatedAt || null;
      info.billingType = oa.billingType || null;
      // Identifiers: no use on their own, but needed to match identities when tracking down
      // problems like "why can't these two terminals see each other". Shown by default; "Hide
      // sensitive info" masks them together with name/email/organization (see app.js).
      info.accountUuid = oa.accountUuid || null;
      info.organizationUuid = oa.organizationUuid || null;
    }
    // The fields below sit at the top level of ~/.claude.json, not in oauthAccount. They describe
    // "what state Claude Code on this machine is in" rather than "who the account is", which is
    // especially useful for this tool: the hook depends on Claude Code's hook interface, so the
    // version is the first thing to check when hooks stop working; MCP servers are supply-chain
    // surface; auto-update decides whether the monitored program can change version underfoot;
    // the install method decides where the config and binary live.
    info.machineID = parsed?.machineID || null;
    info.userID = parsed?.userID || null;
    info.installMethod = parsed?.installMethod || null;
    info.autoUpdates = typeof parsed?.autoUpdates === "boolean" ? parsed.autoUpdates : null;
    const mcp = parsed?.mcpServers;
    if (mcp && typeof mcp === "object") {
      info.mcpServerCount = Object.keys(mcp).length;
      info.mcpServerNames = Object.keys(mcp);
    }
    // Snapshot time of the profile: the whole panel reads a local cache file, not a live API, so not saying how old the data is would be dishonest.
    if (parsed?.oauthAccount?.profileFetchedAt) {
      info.profileFetchedAt = parsed.oauthAccount.profileFetchedAt;
    }
  } catch (e) {
    // File missing, unreadable or malformed: just leave the account info empty, not an error
    // (usage.js already reports its own error when it cannot read the login credentials)
  }
  // subscriptionType/rateLimitTier are fields of the OAuth credentials (in .credentials.json on
  // Linux, in the Keychain on macOS, see lib/credentials.js). That is a different source from
  // oauthAccount and the fields do not fully overlap (for example these two are a snapshot of the
  // tier recorded when the OAuth token was issued, and may not be the same thing as
  // oauthAccount.organizationType). Left empty if unreadable.
  const oauth = readClaudeOauth();
  if (oauth) {
    info.subscriptionType = oauth.subscriptionType || null;
    info.rateLimitTier = oauth.rateLimitTier || null;
  }
  info.claudeCodeVersion = claudeCodeVersion();
  return info;
}

// Claude Code version. `claude --version` is the only authoritative answer, but spawning a
// process on every request is wasteful, so it is cached in-process: the version does not change
// during one Web UI lifetime, and if it does it is because Claude Code was upgraded, when this
// service should be restarted anyway.
//
// Two fallback levels: if the command is unavailable (not on PATH), use the directory with the
// highest version number under ~/.local/share/claude/versions; failing that, fall back to
// lastClawdEntranceVersion in ~/.claude.json. Both are approximations, so the result carries an
// approx flag and the UI labels it honestly instead of pretending it is exact.
let versionCache = null;
function claudeCodeVersion() {
  if (versionCache) return versionCache;
  try {
    const out = execFileSync("claude", ["--version"], { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const m = out.match(/\d+\.\d+\.\d+/);
    if (m) return (versionCache = { value: m[0], approx: false });
  } catch (e) {
    // Not on PATH / timed out / non-zero exit: keep falling back
  }
  try {
    const dir = path.join(os.homedir(), ".local", "share", "claude", "versions");
    const cmp = (a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      return 0;
    };
    const newest = fs
      .readdirSync(dir)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort(cmp)
      .pop();
    if (newest) return (versionCache = { value: newest, approx: true });
  } catch (e) {
    /* Directory missing: keep falling back */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf8"));
    if (parsed?.lastClawdEntranceVersion) {
      return (versionCache = { value: parsed.lastClawdEntranceVersion, approx: true });
    }
  } catch (e) {
    /* Unreadable: return null */
  }
  return null;
}

module.exports = { getAccountInfo };
