"use strict";
// Claude Code network traffic. The main data comes from the system-layer probe
// (cc_monitor/probe_linux.bt on Linux + eBPF; probe_darwin.py + nettop on macOS), which writes the
// network_traffic table in events.db: connection counts and upload/download bytes aggregated by
// (ip, port). When the probe is not installed or not running this table is empty.
//
// Supplementary data comes from operations Claude ran through Bash whose command text looks like
// it goes online (wget/curl/git clone/ssh/scp/..., see commandNetworkHosts() in audit.js). Many
// people never start the system-layer probe by hand, and before this the "AI trail" / world map
// was completely empty in that case even though Claude had clearly run a pile of networked
// commands. This data only means "the command text looks like it connects to this host"; it does
// not prove the connection succeeded (it may have failed, timed out or been blocked by policy),
// and it has no byte counts. It is a different kind of evidence from the probe's measured data,
// so it is all marked inferred:true below; the frontend shows the difference and never passes it
// off as real traffic.
const Database = require("better-sqlite3");
const audit = require("./audit");
const { dbPath } = audit;
const dnscache = require("./dnscache");
const geoip = require("./geoip");

function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

function rawRows(limit) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT ip, port, host, tx_bytes, rx_bytes, connect_count, first_seen, last_seen
         FROM network_traffic
         ORDER BY (tx_bytes + rx_bytes) DESC
         LIMIT ?`
      )
      .all(limit);
  }, []);
}

// On one long-lived connection the probe may record rows with port=0 and no bytes because of
// routing / multiple NICs and the like (see the notes in probe.py). Such a row says nothing
// beyond "a connection happened once", and a list full of that noise hides where the real
// traffic is, so they are filtered out by default.
function isNoiseRow(r) {
  return r.port === 0 && r.tx_bytes === 0 && r.rx_bytes === 0;
}

// Group the "hosts seen in commands" from commandNetworkHosts() by host, deduplicate and resolve
// them to IPs, and build rows of the same shape as rawRows(), so the geoip lookup / sort / filter
// logic in the functions below can be reused instead of writing another set. Hosts that do not
// resolve (dead domain / network problem / timeout) are skipped rather than forced into a fake
// address; when the probe has already measured the same IP, no inferred row is generated for it,
// since that IP already has more trustworthy real traffic data.
async function inferredRows(existingIps) {
  const entries = audit.commandNetworkHosts();
  const byHost = new Map();
  for (const e of entries) {
    let g = byHost.get(e.host);
    if (!g) {
      g = { host: e.host, connectCount: 0, firstSeen: e.ts, lastSeen: e.ts };
      byHost.set(e.host, g);
    }
    g.connectCount += 1;
    if (e.ts < g.firstSeen) g.firstSeen = e.ts;
    if (e.ts > g.lastSeen) g.lastSeen = e.ts;
  }
  const rows = [];
  for (const g of byHost.values()) {
    const ip = await dnscache.resolveHost(g.host);
    if (!ip || existingIps.has(ip)) continue;
    rows.push({
      ip,
      port: 0,
      host: g.host,
      tx_bytes: 0,
      rx_bytes: 0,
      connect_count: g.connectCount,
      first_seen: g.firstSeen,
      last_seen: g.lastSeen,
      inferred: true,
    });
  }
  return rows;
}

async function mergedRows(limit) {
  const real = rawRows(Math.max(limit * 2, limit, 100000)).filter((r) => !isNoiseRow(r));
  const existingIps = new Set(real.map((r) => r.ip));
  const inferred = await inferredRows(existingIps);
  return real.concat(inferred);
}

async function listTraffic(limit = 200, lang = "en") {
  const rows = (await mergedRows(limit)).slice(0, limit);
  const enriched = [];
  for (const r of rows) {
    const geo = await geoip.lookup(r.ip, lang);
    enriched.push({
      ip: r.ip,
      port: r.port,
      host: r.host,
      txBytes: r.tx_bytes,
      rxBytes: r.rx_bytes,
      connectCount: r.connect_count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      inferred: !!r.inferred,
      geo,
    });
  }
  return enriched;
}

async function summary() {
  const rows = await mergedRows(100000);
  let txBytes = 0;
  let rxBytes = 0;
  let connectCount = 0;
  const ips = new Set();
  for (const r of rows) {
    txBytes += r.tx_bytes;
    rxBytes += r.rx_bytes;
    connectCount += r.connect_count;
    ips.add(r.ip);
  }
  return { txBytes, rxBytes, connectCount, distinctIps: ips.size };
}

// Data shape for the world map: only rows with coordinates make sense on the map. Rows without a
// location (no GeoIP database configured, or the IP is not found) do not appear in this list,
// but they still appear in the listTraffic() table (honestly labelled "unknown location", not
// swallowed).
async function geoPairs(limit = 500, lang = "en") {
  const rows = await mergedRows(limit);
  const pairs = [];
  for (const r of rows) {
    const geo = await geoip.lookup(r.ip, lang);
    if (!geo || geo.lat === null || geo.lon === null) continue;
    pairs.push({
      ip: r.ip,
      host: r.host,
      lat: geo.lat,
      lon: geo.lon,
      country: geo.country,
      city: geo.city,
      bytes: r.tx_bytes + r.rx_bytes,
      // The world map's "dots travelling along the line" animation is drawn by direction (mostly
      // upload vs mostly download, arrows point differently), so tx/rx are split out separately
      // instead of giving only the total bytes.
      txBytes: r.tx_bytes,
      rxBytes: r.rx_bytes,
      lastSeen: r.last_seen,
      inferred: !!r.inferred,
    });
    if (pairs.length >= limit) break;
  }
  return pairs;
}

module.exports = { listTraffic, summary, geoPairs };
