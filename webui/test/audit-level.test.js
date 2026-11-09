"use strict";
// Regression tests for the intervention level segmented control.
//
// Locks in three properties:
// 1. Each of the three levels has its own segment, and every level is one step from every other. The old version
//    was "a toggle button + a separate stop button"; from "Off" the toggle pointed to "Enforcing", so Off could
//    not switch to Permissive in one step;
// 2. The current level is expressed by aria-checked, so styling and screen readers share one source of truth;
// 3. Every level has explanatory text, in both Chinese and English.
//
// Usage: node --test test/audit-level.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUB = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(PUB, "app.js"), "utf8");
const i18n = fs.readFileSync(path.join(PUB, "i18n.js"), "utf8");
const css = fs.readFileSync(path.join(PUB, "style.css"), "utf8");

const LEVELS = ["running", "paused", "stopped"];

test("each of the three levels has a segment; data-level covers every level", () => {
  const found = [...html.matchAll(/class="seg-opt lv-\w+" data-level="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(found.sort(), [...LEVELS].sort(), "each of the three levels must have exactly one segment");
});

test("every segment is a radio in the same radiogroup", () => {
  assert.match(html, /id="audit-level-seg"[^>]*role="radiogroup"/);
  const radios = html.match(/class="seg-opt[^"]*"[^>]*role="radio"/g) || [];
  assert.equal(radios.length, 3);
});

test("any level is one step from any other: no more indirect nextState jumps", () => {
  // The old implementation used dataset.nextState to decide "where a click goes", which can only express toggling
  // between two levels, so the third level always had an unreachable edge. Now a click goes to the segment's own
  // level, with no such intermediate value.
  assert.ok(!appJs.includes("nextState"), "app.js should no longer contain the indirect nextState jump");
  assert.match(appJs, /chooseAuditLevel\(\s*opt\.dataset\.level\s*\)/,
    "a click should pass the segment's own level directly");
});

test("only switching to Off asks for confirmation; the other two switch directly", () => {
  const fn = appJs.slice(appJs.indexOf("async function chooseAuditLevel"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /level === "stopped"/, "Off must go through the confirmation prompt");
  assert.match(body, /confirmDialog/);
  // The confirmation prompt may wrap only the stopped branch, not block all three levels
  assert.equal((body.match(/confirmDialog/g) || []).length, 1);
});

test("clicking the current level does nothing and sends no repeat request", () => {
  assert.match(appJs, /current\.dataset\.level === level\) return/);
});

test("the current level is expressed by aria-checked, and the CSS hangs on the same attribute", () => {
  assert.match(appJs, /setAttribute\("aria-checked"/);
  for (const lv of LEVELS) {
    assert.ok(
      css.includes(`.lv-${lv}[aria-checked="true"]`),
      `${lv} selected style must be driven by aria-checked, not a separate class`
    );
  }
});

test("each level has its own identity colour and does not reuse the good/bad semantic colours", () => {
  // Enforcing = purple, Permissive = green, Off = yellow. Deliberately not --green/--yellow/--red: those are
  // good/bad semantic colours that change with the theme, while the levels need three identity colours that are
  // clearly distinct and consistent across themes.
  for (const v of ["--lv-enforce", "--lv-observe", "--lv-off"]) {
    assert.ok(css.includes(`${v}:`), `missing level colour variable ${v}`);
    assert.ok(css.includes(`${v}-on:`), `missing matching foreground colour for ${v}`);
  }
  const map = { running: "--lv-enforce", paused: "--lv-observe", stopped: "--lv-off" };
  for (const [lv, v] of Object.entries(map)) {
    const rule = css.match(new RegExp(`\\.lv-${lv}\\[aria-checked="true"\\][^}]*}`));
    assert.ok(rule, `${lv} has no selected-state rule`);
    assert.ok(rule[0].includes(`var(${v})`), `${lv} should use ${v}`);
    assert.ok(rule[0].includes(`var(${v}-on)`), `${lv} text should use the matching foreground colour for contrast`);
  }
});

test("the top bar pill and home page dot use the same level colours as the segmented control", () => {
  const map = { running: "--lv-enforce", paused: "--lv-observe", stopped: "--lv-off" };
  // One level may appear in several rules (for example a grouped selector sharing font-weight across all three
  // levels), so collect every match and pass if any of them uses the level's colour variable; looking only at the
  // first would be cut short by the grouped rule.
  const rulesFor = (sel) => [...css.matchAll(new RegExp(`${sel}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
  for (const [lv, v] of Object.entries(map)) {
    const pill = rulesFor(`\\.audit-state-${lv}`);
    assert.ok(pill.some((r) => r.includes(`var(${v})`)), `top bar pill ${lv} should use ${v}`);
    const dot = rulesFor(`\\.strip-dot\\.${lv}`);
    assert.ok(dot.some((r) => r.includes(`var(${v})`)), `home page dot ${lv} should use ${v}`);
  }
});

test("the selected state does not rely on colour alone: the dot is also hollow vs filled", () => {
  assert.match(css, /\.seg-opt\[aria-checked="true"\] \.seg-dot \{ background: currentColor/);
});

test("every level has explanatory text, in both Chinese and English", () => {
  for (const lv of LEVELS) {
    const key = `"home.auditCtl.levelNote.${lv}":`;
    const n = (i18n.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    assert.equal(n, 2, `${lv} needs one explanatory text in Chinese and one in English`);
  }
});

test("the explanation line element exists and is filled in on render", () => {
  assert.match(html, /id="audit-level-note"/);
  assert.match(appJs, /audit-level-note/);
  assert.match(appJs, /home\.auditCtl\.levelNote\." \+ state/);
});

// ---------- Account masking scope ----------
// "Hide sensitive info" should mask only the three fields that identify a specific person. It once masked all
// nine, which left the panel with nothing worth showing; organisation role / plan / quota tier / billing type /
// creation time are account attributes, not identity.
const ACCOUNT_JS = appJs.slice(
  appJs.indexOf("function renderAccountProfileInto"),
  appJs.indexOf("async function refreshAccountProfile")
);

test("name/email/organisation are masked; the four identifiers go through ident (also masked)", () => {
  for (const f of ["info.displayName", "info.email", "info.organizationName"]) {
    assert.ok(ACCOUNT_JS.includes(`mask(${f})`), `${f} should be masked`);
  }
  // Identifiers go through ident(): shown truncated to "first 8…last 4" normally, and also turned into *** when masked
  for (const f of ["info.accountUuid", "info.organizationUuid", "info.userID", "info.machineID"]) {
    assert.ok(ACCOUNT_JS.includes(`ident(${f})`), `${f} should go through ident`);
  }
});

test("masked ident also hides the title, so hovering cannot reveal the original value", () => {
  const fn = appJs.slice(appJs.indexOf("const ident = (text) =>"));
  const body = fn.slice(0, fn.indexOf("\n  };"));
  // accountMasked is checked first and returns at once, so the title branch is never reached
  assert.match(body, /if \(accountMasked\) return ACCOUNT_MASK_TEXT;/);
  const maskedIdx = body.indexOf("accountMasked");
  const titleIdx = body.indexOf("title=");
  assert.ok(maskedIdx < titleIdx, "the masking check must come before the title is built");
});

test("the local environment fields are always plain text; they are not identity information", () => {
  for (const f of ["info.installMethod"]) {
    assert.ok(ACCOUNT_JS.includes(`plain(${f})`), `${f} should not be masked`);
  }
  // Version / auto-update / MCP count never go through mask or ident
  for (const f of ["claudeCodeVersion", "autoUpdates", "mcpServerCount"]) {
    assert.ok(!ACCOUNT_JS.includes(`mask(info.${f})`), `${f} should not be masked`);
    assert.ok(!ACCOUNT_JS.includes(`ident(info.${f})`), `${f} should not go through ident`);
  }
});

test("the remaining account fields are always plain text", () => {
  for (const f of [
    "info.organizationRole",
    "info.organizationType",
    "info.organizationRateLimitTier",
    "info.billingType",
  ]) {
    assert.ok(ACCOUNT_JS.includes(`plain(${f})`), `${f} should not be masked`);
    assert.ok(!ACCOUNT_JS.includes(`mask(${f})`), `${f} should not be masked`);
  }
  // The two date fields use the formatted variable names
  assert.ok(ACCOUNT_JS.includes("plain(createdAt)"));
  assert.ok(ACCOUNT_JS.includes("plain(subCreatedAt)"));
});

test("masking still uses a fixed-length ***, not leaking the original length", () => {
  assert.match(appJs, /ACCOUNT_MASK_TEXT\s*=\s*"\*\*\*"/);
});
