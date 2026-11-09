"use strict";
// Selection logic in lib/credentials.js: among several credentials prefer an unexpired one, and
// when all are expired take the latest (reproduces the "a stale acct=root entry left in the
// Keychain -> usage API returns 401 forever" bug).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pickOauth, isExpired } = require("../lib/credentials");

const NOW = 1_000_000;
const raw = (token, expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

test("returns the unexpired credentials even when an expired one comes first", () => {
  const picked = pickOauth([raw("stale-root", NOW - 1), raw("fresh", NOW + 3600_000)], NOW);
  assert.equal(picked.accessToken, "fresh");
});

test("when several are unexpired, takes the first in source order", () => {
  const picked = pickOauth([raw("a", NOW + 10), raw("b", NOW + 20)], NOW);
  assert.equal(picked.accessToken, "a");
});

test("when all are expired, returns the one that expired last so the caller can tell it is expired", () => {
  const picked = pickOauth([raw("older", NOW - 500), raw("newer", NOW - 10)], NOW);
  assert.equal(picked.accessToken, "newer");
  assert.equal(isExpired(picked, NOW), true);
});

test("skips sources that are null, not JSON, or lack claudeAiOauth", () => {
  const picked = pickOauth([null, "not json", JSON.stringify({ foo: 1 }), raw("ok", NOW + 1)], NOW);
  assert.equal(picked.accessToken, "ok");
  assert.equal(pickOauth([null, "{}"], NOW), null);
});

test("treats the old format without expiresAt as unexpired", () => {
  const legacy = JSON.stringify({ claudeAiOauth: { accessToken: "legacy" } });
  assert.equal(isExpired(JSON.parse(legacy).claudeAiOauth, NOW), false);
  assert.equal(pickOauth([raw("stale", NOW - 1), legacy], NOW).accessToken, "legacy");
});
