"use strict";
// Forward DNS resolution with an in-memory cache. Command text only has a host name (e.g.
// github.com in a git clone); to mark it on the world map it must first be resolved to an IP and
// then looked up in GeoIP. This is lazy, query-time resolution, not done in the hook (the hook
// must stay fast and network-independent, see the comment on commandNetworkHosts() in audit.js).
// Each host name is resolved once and cached for the life of the process, so the same domain is
// not queried again on every page refresh.
// Failures (domain gone / network problem / timeout) cache null and are likewise not retried
// until the process restarts, matching how geoip.js handles "not found": honestly return empty,
// and do not retry until the request is slowed down.
const dns = require("dns");

const cache = new Map(); // host -> Promise<string|null>
const LOOKUP_TIMEOUT_MS = 3000;

function lookupWithTimeout(host) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, LOOKUP_TIMEOUT_MS);
    dns.lookup(host, { family: 4 }, (err, address) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(err ? null : address);
    });
  });
}

function resolveHost(host) {
  if (!cache.has(host)) {
    cache.set(host, lookupWithTimeout(host));
  }
  return cache.get(host);
}

module.exports = { resolveHost };
