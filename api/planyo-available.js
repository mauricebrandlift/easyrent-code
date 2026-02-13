/**
 * Vercel Serverless Function (Node)
 * File: /api/planyo-available.js
 * Endpoint: /api/planyo-available
 *
 * Query params:
 * - start=YYYY-MM-DD              (required)
 * - end=YYYY-MM-DD                (required)
 * - quantity=1                    (optional, default 1)
 * - resourceIds=1,2,3             (optional)
 * - debug=1                       (optional)
 *
 * Env vars:
 * - PLANYO_API_BASE (default: https://www.planyo.com/rest/)
 * - PLANYO_API_KEY
 * - PLANYO_API_USERNAME (optional)
 * - PLANYO_API_PASSWORD (optional)
 *
 * CORS:
 * - Allows only:
 *   - https://easyrentsuriname.nl
 *   - https://www.easyrentsuriname.nl
 *   - https://easyrent-suriname-2025.webflow.io
 */

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // CDN caching on Vercel Edge (safe: response depends on query string)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.end(JSON.stringify(data));
}

function isValidISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseIds(csv) {
  if (!csv) return [];
  return String(csv)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeKeys(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj);
}

function makeRawPreview(obj) {
  if (!obj) return obj;
  const preview = obj?.data ?? obj?.result ?? obj;
  if (Array.isArray(preview)) return preview.slice(0, 5);
  if (preview && typeof preview === "object") {
    const out = {};
    for (const k of Object.keys(preview).slice(0, 35)) out[k] = preview[k];
    return out;
  }
  return preview;
}

function extractAvailableIdsStrict(planyoData) {
  const out = [];

  const resultsObj =
    planyoData?.data?.results ||
    planyoData?.result?.results ||
    planyoData?.results ||
    null;

  if (!resultsObj || typeof resultsObj !== "object") return out;

  for (const k of Object.keys(resultsObj)) {
    const item = resultsObj[k];
    const id = item?.id || item?.resource_id;
    if (typeof id === "string" && /^\d+$/.test(id)) out.push(id);
    if (typeof id === "number") out.push(String(id));
  }

  return Array.from(new Set(out));
}

function extractReasons(planyoData) {
  const reasons =
    planyoData?.data?.reason_not_listed ||
    planyoData?.result?.reason_not_listed ||
    planyoData?.reason_not_listed ||
    null;

  if (!reasons || typeof reasons !== "object") return {};
  const out = {};
  for (const rid of Object.keys(reasons)) {
    out[String(rid)] = String(reasons[rid]);
  }
  return out;
}

// --- CORS (allowlist: 2 domains) ---
const ALLOWED_ORIGINS = new Set([
  "https://easyrentsuriname.nl",
  "https://www.easyrentsuriname.nl",
  "https://easyrent-suriname-2025.webflow.io",
]);

function applyCors(req, res) {
  const origin = req.headers.origin;

  // If request has an Origin header, only allow if it's in the allowlist.
  // (If no Origin header, we don't set ACAO — typical for server-to-server requests.)
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // Prevent caches from mixing responses between origins
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // optional: allow cookies (only if you ever use them). Not needed here.
    // res.setHeader("Access-Control-Allow-Credentials", "true");
    return true;
  }

  // If origin exists but isn't allowed, we still respond (with a clear error)
  // and DO NOT set ACAO header -> browser will block.
  return false;
}

async function callPlanyoResourceSearch({
  baseUrl,
  apiKey,
  start,
  end,
  quantity,
  resourceIds,
  username,
  password,
}) {
  const url = new URL(baseUrl || "https://www.planyo.com/rest/");
  url.searchParams.set("method", "resource_search");
  url.searchParams.set("api_key", apiKey);

  url.searchParams.set("start_time", start);
  url.searchParams.set("end_time", end);
  url.searchParams.set("quantity", String(quantity));

  if (resourceIds && resourceIds.length) {
    url.searchParams.set("ppp_resfilter", resourceIds.join(","));
  }

  if (username) url.searchParams.set("username", username);
  if (password) url.searchParams.set("password", password);

  const resp = await fetch(url.toString(), { method: "GET" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Planyo HTTP ${resp.status}. Body: ${text.slice(0, 300)}`);
  }

  // Note: only call resp.json once
  const data = await resp.json().catch(() => null);
  if (!data) {
    throw new Error("Planyo response not valid JSON.");
  }

  return data;
}

export default async function handler(req, res) {
  // --- CORS first (and handle preflight) ---
  const origin = req.headers.origin;
  const isAllowedOrigin = origin ? ALLOWED_ORIGINS.has(origin) : false;

  // If it's a browser preflight, we must answer OPTIONS properly
  if (req.method === "OPTIONS") {
    if (isAllowedOrigin) applyCors(req, res);
    // If origin not allowed, still answer 204/200 without ACAO; browser will block.
    res.statusCode = 204;
    return res.end();
  }

  // For normal requests: set CORS headers only for allowed origins
  if (isAllowedOrigin) applyCors(req, res);

  // If request comes from a disallowed Origin, return a clear JSON error
  // (browser will still block reading it, but it helps debugging via network logs)
  if (origin && !isAllowedOrigin) {
    return json(res, 403, {
      error: "CORS: Origin not allowed",
      origin,
      allowedOrigins: Array.from(ALLOWED_ORIGINS),
    });
  }

  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return json(res, 405, { error: "Method not allowed" });
    }

    const apiKey = process.env.PLANYO_API_KEY;
    const baseUrl = process.env.PLANYO_API_BASE || "https://www.planyo.com/rest/";
    const username = process.env.PLANYO_API_USERNAME || "";
    const password = process.env.PLANYO_API_PASSWORD || "";

    if (!apiKey) return json(res, 500, { error: "Missing env var: PLANYO_API_KEY" });

    const { start, end, quantity, resourceIds, debug } = req.query;
    const debugMode = String(debug || "").toLowerCase() === "1";

    if (!isValidISODate(start) || !isValidISODate(end)) {
      return json(res, 400, { error: "Invalid or missing start/end. Use YYYY-MM-DD." });
    }

    const qty = Number(quantity || 1);
    if (!Number.isFinite(qty) || qty <= 0) {
      return json(res, 400, { error: "Invalid quantity. Use a positive number." });
    }

    const idsFilter = parseIds(resourceIds);

    const planyoData = await callPlanyoResourceSearch({
      baseUrl,
      apiKey,
      start,
      end,
      quantity: qty,
      resourceIds: idsFilter,
      username,
      password,
    });

    const reasonsByResourceId = extractReasons(planyoData);

    // Planyo response_code (e.g. 4 = no results)
    if (planyoData?.response_code && planyoData.response_code !== 0) {
      return json(res, 200, {
        start,
        end,
        quantity: qty,
        availableResourceIds: [],
        unavailableResourceIds: idsFilter.length ? idsFilter.map(String) : [],
        reasonsByResourceId,
        error: {
          response_code: planyoData.response_code,
          response_message: planyoData.response_message,
        },
        meta: {
          requestedFilterCount: idsFilter.length,
          returnedCount: 0,
          reasonsCount: Object.keys(reasonsByResourceId).length,
          debug: debugMode ? 1 : 0,
        },
        ...(debugMode
          ? { debug: { topLevelKeys: safeKeys(planyoData), rawPreview: makeRawPreview(planyoData) } }
          : {}),
      });
    }

    const availableResourceIds = extractAvailableIdsStrict(planyoData);

    let unavailableResourceIds = [];
    if (idsFilter.length) {
      const availSet = new Set(availableResourceIds.map(String));
      unavailableResourceIds = idsFilter.map(String).filter((id) => !availSet.has(id));
    }

    return json(res, 200, {
      start,
      end,
      quantity: qty,
      availableResourceIds,
      unavailableResourceIds,
      reasonsByResourceId,
      meta: {
        requestedFilterCount: idsFilter.length,
        returnedCount: availableResourceIds.length,
        reasonsCount: Object.keys(reasonsByResourceId).length,
        debug: debugMode ? 1 : 0,
      },
      ...(debugMode
        ? { debug: { topLevelKeys: safeKeys(planyoData), rawPreview: makeRawPreview(planyoData) } }
        : {}),
    });
  } catch (err) {
    return json(res, 500, { error: err?.message || "Unknown error" });
  }
}
