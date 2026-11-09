"use strict";
// Rule table metadata (Chinese and English title/desc, risk, action), used by AI Approvals and
// the approval history: a bare rule id (e.g. git_force_push) does not tell a person what they are
// confirming, so it needs a plain explanation. Reads rules.json in the user directory
// (~/.cc-monitor/rules.json; ensure_config() on the Python side merges new default rules into it),
// falling back to default_rules.json in the repository when that is unreadable. Read-only.
const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_MS = 5000;
let cache = { at: 0, byId: {} };

function userRulesPath() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "rules.json");
}

function defaultRulesPath() {
  return path.join(__dirname, "..", "..", "cc_monitor", "default_rules.json");
}

function readJson(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function readRules() {
  return readJson(userRulesPath()) || readJson(defaultRulesPath()) || [];
}

// Returns { <rule id>: { title, desc, title_en, desc_en, risk, action } }
function ruleMeta() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.byId;
  // The Python default-rule merge deliberately skips rules the user has edited in rules.json (it
  // does not overwrite user changes), so those rules miss newly added title/desc text. For
  // display, fall back by id to the text of the built-in default table in the repository. This
  // only affects display and never writes back to the user's file.
  const fallback = {};
  for (const r of readJson(defaultRulesPath()) || []) {
    if (r && typeof r.id === "string") fallback[r.id] = r;
  }
  const byId = {};
  for (const r of readRules()) {
    if (!r || typeof r.id !== "string") continue;
    const d = fallback[r.id] || {};
    byId[r.id] = {
      title: r.title || d.title || null,
      desc: r.desc || d.desc || null,
      title_en: r.title_en || d.title_en || null,
      desc_en: r.desc_en || d.desc_en || null,
      risk: r.risk || null,
      action: r.action || null,
    };
  }
  cache = { at: now, byId };
  return byId;
}

module.exports = { ruleMeta };
