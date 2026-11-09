"use strict";
// The OAuth credentials Claude Code stores itself (claudeAiOauth.accessToken / subscriptionType / ...).
// Where they live depends on the platform:
//   - Linux: plain-text file ~/.claude/.credentials.json
//   - macOS: **no file**; a generic password in the login Keychain (login.keychain), with the
//     fixed service name "Claude Code-credentials" and the same JSON string as its content.
// On a fresh Mac ~/.claude/.credentials.json never exists, so reading only the file would never
// find quota/plan. This has nothing to do with whether ccstatusline is installed (we do not call
// ccstatusline, we only replicate how it reads credentials, and on macOS it uses exactly
// `security find-generic-password`).
//
// The Keychain may hold **several** entries for the same service (different acct): for example,
// running Claude Code once under sudo adds an acct=root entry that nobody refreshes afterwards,
// and its token soon expires. `security -s` without `-a` returns only the first match, and
// hitting that expired one gives "usage API returned 401" forever. So:
//   1. query the Keychain by the current user name (-a) first, and fall back to no -a;
//   2. once every source is parsed, prefer an unexpired one (expiresAt in the future); if all
//      are expired, take the one that expired last and let the caller decide how to report it
//      from expiresAt (fields such as plan type still work after expiry).
// Read-only; any failed step returns null and the caller decides how to report the error.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function readFromFile() {
  try {
    return fs.readFileSync(CREDENTIALS_PATH, "utf8");
  } catch (e) {
    return null;
  }
}

function currentUsername() {
  try {
    return os.userInfo().username || null;
  } catch (e) {
    return process.env.USER || null;
  }
}

function keychainLookup(extraArgs) {
  try {
    // On the first call macOS may show a "node wants to access the Keychain" system prompt (it
    // stops after "Always Allow"). That is macOS's own ACL mechanism and not something we can
    // bypass. Use a short timeout so the /api/usage request does not hang while nobody clicks it.
    return execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, ...extraArgs, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch (e) {
    return null;
  }
}

// Returns 0-2 raw JSON strings: the current user's entry first, then the default one without -a (they may be the same; deduplicated).
function readFromKeychain() {
  if (os.platform() !== "darwin") return [];
  const out = [];
  const user = currentUsername();
  if (user) {
    const mine = keychainLookup(["-a", user]);
    if (mine) out.push(mine);
  }
  const any = keychainLookup([]);
  if (any && !out.includes(any)) out.push(any);
  return out;
}

function parseOauth(raw) {
  if (!raw) return null;
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return oauth && typeof oauth === "object" ? oauth : null;
  } catch (e) {
    return null; // content is not the expected JSON
  }
}

function isExpired(oauth, now = Date.now()) {
  // Old format without expiresAt counts as unexpired; the API decides for itself
  return typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now;
}

// Pick from several candidates: an unexpired one first (in source order), otherwise the one that expired last, else null.
function pickOauth(candidates, now = Date.now()) {
  const parsed = candidates.map(parseOauth).filter(Boolean);
  const valid = parsed.find((o) => !isExpired(o, now));
  if (valid) return valid;
  return parsed.reduce((best, o) => (!best || (o.expiresAt || 0) > (best.expiresAt || 0) ? o : best), null);
}

// Returns the parsed claudeAiOauth object, or null.
function readClaudeOauth() {
  return pickOauth([readFromFile(), ...readFromKeychain()]);
}

// For error messages: tell the user where the credentials should be on this machine
function credentialsLocationHint() {
  return os.platform() === "darwin"
    ? `~/.claude/.credentials.json or the Keychain item "${KEYCHAIN_SERVICE}"`
    : "~/.claude/.credentials.json";
}

module.exports = {
  readClaudeOauth,
  credentialsLocationHint,
  isExpired,
  pickOauth,
  CREDENTIALS_PATH,
  KEYCHAIN_SERVICE,
};
