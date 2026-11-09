"use strict";
// Parsing of lsof -Fpn output (the only source of a process's cwd on macOS). If every cwd is null, /api/status
// judges every session dead and the vital-signs indicator draws a flat grey line for all of them; this test
// guards the head of that chain.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseLsofCwds } = require("../lib/processScan");

test("parses pid → cwd from p/f/n line triples", () => {
  const out = parseLsofCwds("p32151\nfcwd\nn/Users/me/work\np47737\nfcwd\nn/Users/me\n");
  assert.equal(out.get(32151), "/Users/me/work");
  assert.equal(out.get(47737), "/Users/me");
  assert.equal(out.size, 2);
});

test("a pid with a p line but no n line (no permission / process exited) produces no entry", () => {
  const out = parseLsofCwds("p111\np222\nfcwd\nn/tmp\n");
  assert.equal(out.has(111), false);
  assert.equal(out.get(222), "/tmp");
});

test("keeps paths containing spaces intact", () => {
  const out = parseLsofCwds("p9\nfcwd\nn/Users/me/My Projects/app\n");
  assert.equal(out.get(9), "/Users/me/My Projects/app");
});

test("empty output / undefined returns an empty Map without throwing", () => {
  assert.equal(parseLsofCwds("").size, 0);
  assert.equal(parseLsofCwds(undefined).size, 0);
});
