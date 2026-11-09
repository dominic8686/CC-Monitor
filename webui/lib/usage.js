"use strict";
// Account-level usage/quota. Reads the same thing as ccstatusline
// (https://github.com/sirmalloc/ccstatusline): the OAuth credentials file Claude Code writes
// locally, used to call Anthropic's usage endpoint. This is not our own API; it was confirmed by
// reverse-engineering the ccstatusline implementation:
//   credentials: claudeAiOauth.accessToken (~/.claude/.credentials.json on Linux, the Keychain
//         on macOS, see lib/credentials.js)
//   endpoint: GET https://api.anthropic.com/api/oauth/usage  (Bearer token)
// Read-only query using credentials Claude Code already holds and trusts; no writes of any kind.
const https = require("https");
const { readClaudeOauth, credentialsLocationHint, isExpired } = require("./credentials");
// https-proxy-agent is installed as a pure ESM package ("type":"module" in package.json, no
// require export condition). Plain node (v22 here, which supports synchronous require(esm)) can
// require it, but the older Node bundled with Electron cannot and throws ERR_REQUIRE_ESM, crashing
// the desktop app's startup. A dynamic import() works on both.

const USAGE_API_HOST = "api.anthropic.com";
const USAGE_API_PATH = "/api/oauth/usage";
const CACHE_MAX_AGE_MS = 180 * 1000; // same as ccstatusline, to avoid hammering the endpoint

async function proxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    return undefined;
  }
}

let cached = null; // { fetchedAt, data } | { fetchedAt, error }

// Returns { token } or { error }: missing and expired credentials get separate messages instead of both blurring into "usage API returned 401".
function readAccessToken() {
  const oauth = readClaudeOauth();
  if (!oauth?.accessToken) {
    return { error: `Claude Code login credentials not found (${credentialsLocationHint()}), cannot query quota` };
  }
  if (isExpired(oauth)) {
    return { error: "Claude Code login credentials have expired. Run any command in Claude Code so it refreshes them, or run /login to sign in again" };
  }
  return { token: oauth.accessToken };
}

function bucketInfo(bucket) {
  if (!bucket) return null;
  return {
    utilization: typeof bucket.utilization === "number" ? bucket.utilization : null,
    resetsAt: bucket.resets_at || null,
  };
}

// The `limits` array is a quota breakdown one level finer than five_hour/seven_day: the same kind
// (session/weekly_all/weekly_scoped) gets its own entry at each severity (normal / warning
// levels), and weekly_scoped entries also carry the specific model they are scoped to
// (scope.model).
function limitInfo(l) {
  return {
    kind: l.kind || null,
    group: l.group || null,
    percent: typeof l.percent === "number" ? l.percent : null,
    severity: l.severity || null,
    resetsAt: l.resets_at || null,
    scopeModel: l?.scope?.model?.display_name || null,
    isActive: !!l.is_active,
  };
}

// `spend`: whether the account can buy / has bought extra usage beyond the plan quota
// (Anthropic's "usage credits"). Not the same thing as the "percentage quota" of
// five_hour/seven_day; this is an actual amount of money.
function spendInfo(spend) {
  if (!spend) return null;
  return {
    usedAmountMinor: spend.used?.amount_minor ?? null,
    currency: spend.used?.currency || null,
    exponent: typeof spend.used?.exponent === "number" ? spend.used.exponent : 2,
    percent: typeof spend.percent === "number" ? spend.percent : null,
    severity: spend.severity || null,
    enabled: !!spend.enabled,
    disabledReason: spend.disabled_reason || null,
    canPurchaseCredits: !!spend.can_purchase_credits,
  };
}

async function fetchUsageOnce(token) {
  const agent = await proxyAgent();
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: USAGE_API_HOST,
        path: USAGE_API_PATH,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        timeout: 5000,
        ...(agent ? { agent } : {}),
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ error: `usage API returned ${res.statusCode}` });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const rawLimits = Array.isArray(parsed.limits) ? parsed.limits : [];
            // Some models (Fable, so far) have no dedicated top-level field (unlike opus/sonnet,
            // which have seven_day_opus/seven_day_sonnet); their quota hangs only on one
            // kind="weekly_scoped" entry in limits[], with scope.model.display_name as the model
            // name. "Fable" is not hard-coded, so future per-model limits from Anthropic show up
            // automatically.
            const perModelWeekly = rawLimits
              .filter((l) => l.kind === "weekly_scoped" && l?.scope?.model?.display_name)
              .map((l) => ({
                model: l.scope.model.display_name,
                utilization: typeof l.percent === "number" ? l.percent : null,
                resetsAt: l.resets_at || null,
              }));
            resolve({
              data: {
                session: bucketInfo(parsed.five_hour),
                weekly: bucketInfo(parsed.seven_day),
                weeklySonnet: bucketInfo(parsed.seven_day_sonnet),
                weeklyOpus: bucketInfo(parsed.seven_day_opus),
                perModelWeekly,
                limits: rawLimits.map(limitInfo),
                spend: spendInfo(parsed.spend),
              },
            });
          } catch (e) {
            resolve({ error: "Failed to parse the usage API response" });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "usage API request timed out" });
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function getUsage() {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MAX_AGE_MS) return cached;

  const { token, error } = readAccessToken();
  if (!token) {
    cached = { fetchedAt: now, error };
    return cached;
  }
  const result = await fetchUsageOnce(token);
  cached = { fetchedAt: now, ...result };
  return cached;
}

module.exports = { getUsage };
