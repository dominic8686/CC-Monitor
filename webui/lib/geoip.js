"use strict";
// IP geolocation lookup from a local MaxMind GeoLite2 database, rather than asking a third-party
// API for every IP (that would leak which sites and servers Claude Code visited to yet another
// third party). Users must register a free account on the MaxMind site and download the database
// with a license key themselves; it is not done for them or bundled here (the license terms do
// not allow redistributing the database file).
//
// Without a configured database this module degrades gracefully: lookups return null and the
// frontend honestly shows "no geolocation data", never inventing or estimating fake
// coordinates, following the "label accuracy honestly" idea of BeeEye's GeoAccuracyBadge
// (download: https://github.com/cn0xroot/BeeEye/blob/main/BeeEye-web/src/components/GeoAccuracyBadge.jsx).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { countryNameZh } = require("./countryNamesZh");

const CANDIDATE_PATHS = [
  process.env.CC_MONITOR_GEOIP_DB,
  path.join(os.homedir(), ".cc-monitor", "GeoLite2-City.mmdb"),
  path.join(os.homedir(), ".cc-monitor", "GeoLite2-Country.mmdb"),
  // dbip-city.mmdb: DB-IP Lite (CC BY 4.0, no MaxMind account needed), see
  // https://github.com/sapics/ip-location-db. Its fields are flat; lookup() below already
  // handles that, so it works with no extra configuration.
  path.join(os.homedir(), ".cc-monitor", "dbip-city.mmdb"),
].filter(Boolean);

let reader = null; // maxmind.Reader instance, lazy-loaded once
let dbPath = null;
let dbKind = null; // "city" | "country" | null
let loadPromise = null; // in-progress or finished load Promise, not a simple boolean flag

function resolveDbPath() {
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Use a shared in-flight Promise rather than a "have we tried yet" boolean: getStatus() and
// lookup() are often called concurrently via Promise.all in the same HTTP request. With only a
// boolean ("not tried yet, so await"), the second concurrent call sees "already trying", skips
// ahead and gets a reader that is not assigned yet (still null), so getStatus() reports
// "unavailable" even though the database actually loaded. When every caller awaits the same
// Promise this cannot happen.
function ensureLoaded() {
  if (!loadPromise) loadPromise = _load();
  return loadPromise;
}

async function _load() {
  const found = resolveDbPath();
  if (!found) return;
  try {
    const maxmind = require("maxmind");
    reader = await maxmind.open(found);
    dbPath = found;
    dbKind = found.toLowerCase().includes("country") ? "country" : "city";
  } catch (e) {
    reader = null;
    dbPath = null;
    dbKind = null;
  }
}

async function getStatus() {
  await ensureLoaded();
  return {
    available: !!reader,
    accuracy: dbKind, // "city" | "country" | null (the frontend uses this field to choose which badge to show)
    dbPath: dbPath || null,
    candidatePaths: CANDIDATE_PATHS,
  };
}

// city.names/country.names in MaxMind GeoLite2 is a multilingual object (en/zh-CN/ja/de/fr/es/
// pt-BR/ru). It used to be hard-coded to .en, so the Chinese UI showed city/country names in
// English too (e.g. "Tseung Kwan O, HK"). Flat-format sources such as DB-IP Lite (converted by
// sapics/ip-location-db) have no multilingual fields at all, so when zh-CN is missing it falls
// back to English; that is a limit of the data source, not a bug. UI languages ("zh"/"en") do
// not map one-to-one to mmdb locale keys: "zh" maps to "zh-CN", and other languages fall back
// to en for now.
const UI_LANG_TO_MMDB_LOCALE = { zh: "zh-CN", en: "en" };
function localizedName(names, lang) {
  if (!names) return null;
  const locale = UI_LANG_TO_MMDB_LOCALE[lang] || "en";
  return names[locale] || names.en || null;
}

const lookupCache = new Map(); // (ip, lang) -> result (or null); valid for the life of the process, since an IP's location does not change

async function lookup(ip, lang = "en") {
  if (!ip) return null;
  const cacheKey = ip + "|" + lang;
  if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey);
  await ensureLoaded();
  if (!reader) {
    lookupCache.set(cacheKey, null);
    return null;
  }
  let result = null;
  try {
    const rec = reader.get(ip);
    if (rec) {
      // Both common mmdb field layouts must be recognised: official MaxMind databases are nested
      // (city.names.en / location.latitude), while mmdb files exported from non-MaxMind sources
      // such as DB-IP Lite (the sapics/ip-location-db conversion) have flat fields
      // (city / country_code / latitude). Reading only the MaxMind nested paths would return a
      // pile of nulls for a flat database that actually has the data.
      const lat = rec.location?.latitude ?? rec.latitude;
      const lon = rec.location?.longitude ?? rec.longitude;
      const countryCode = rec.country?.iso_code || rec.country_code || null;
      result = {
        // Flat-format sources such as dbip-city.mmdb (DB-IP Lite) have no multilingual names
        // field and not even the full English country name, only the ISO code country_code, so
        // localizedName() never finds anything there. The final fallback is the static ISO
        // code -> Chinese name table (country/region level only; there is no Chinese data source
        // for city names, so those cannot be translated).
        country:
          localizedName(rec.country?.names, lang) ||
          localizedName(rec.registered_country?.names, lang) ||
          rec.country_name ||
          (lang === "zh" ? countryNameZh(countryCode) : null) ||
          null,
        countryCode,
        city:
          localizedName(rec.city?.names, lang) ||
          (typeof rec.city === "string" ? rec.city : null) ||
          null,
        lat: typeof lat === "number" ? lat : null,
        lon: typeof lon === "number" ? lon : null,
        accuracyRadiusKm: rec.location?.accuracy_radius ?? null,
      };
    }
  } catch (e) {
    result = null;
  }
  lookupCache.set(cacheKey, result);
  return result;
}

module.exports = { getStatus, lookup };
