/**
 * Vercel Serverless Function (Node)
 * Endpoint: /api/planyo-available
 *
 * Doel:
 * - Alleen start + end => lijst beschikbare Planyo resource IDs terug
 * - Optioneel: beperken tot een set resourceIds (bijv. uit Webflow CMS) via ppp_resfilter
 *
 * Query params:
 * - start=YYYY-MM-DD              (required)
 * - end=YYYY-MM-DD                (required)
 * - quantity=1                    (optional, default 1)
 * - resourceIds=1,2,3             (optional: beperkt search tot deze resource IDs)
 * - debug=1                       (optional: geeft extra debug info terug)
 *
 * Belangrijke Planyo regels:
 * - resource_search vereist start_time, end_time, quantity. :contentReference[oaicite:2]{index=2}
 * - Voor accomodaties / night reservations: end_time = vertrekdatum zonder tijd. :contentReference[oaicite:3]{index=3}
 *
 * Env vars:
 * - PLANYO_API_BASE (default: https://www.planyo.com/rest/)
 * - PLANYO_API_KEY
 * - PLANYO_API_USERNAME (optioneel)
 * - PLANYO_API_PASSWORD (optioneel)
 */

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

/**
 * Extract beschikbare resource IDs uit resource_search response.
 * Planyo output kan per account/config wat verschillen.
 * We doen daarom "best effort" en hebben debug=1 om de exacte structuur te zien.
 */
function extractAvailableIds(planyoData) {
  const ids = new Set();

  // Most likely containers:
  const containers = [
    planyoData?.data,
    planyoData?.result,
    planyoData,
  ].filter(Boolean);

  // Helper: try to read id from common shapes
  const pushId = (v) => {
    if (v == null) return;
    if (typeof v === "number") ids.add(String(v));
    if (typeof v === "string" && /^\d+$/.test(v)) ids.add(v);
  };

  // Try common arrays:
  // e.g. data.results / data.resources / results / resources
  for (const c of containers) {
    const candidates = [
      c?.results,
      c?.resources,
      c?.data?.results,
      c?.data?.resources,
    ].filter(Array.isArray);

    for (const arr of candidates) {
      for (const item of arr) {
        // Common keys: resource_id, id
        pushId(item?.resource_id);
        pushId(item?.id);

        // Sometimes nested:
        pushId(item?.resource?.id);
        pushId(item?.resource?.resource_id);
      }
    }
  }

  // If nothing found, do a shallow scan of objects for numeric keys / resource_id fields
  if (ids.size === 0) {
    const stack = [planyoData];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (const x of cur) stack.push(x);
        continue;
      }

      // If object has a resource_id-like field
      pushId(cur.resource_id);
      pushId(cur.id);

      for (const k of Object.keys(cur)) {
        const v = cur[k];
        // Sometimes results are keyed by resource_id
        if (/^\d+$/.test(k)) pushId(k);
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }

  return Array.from(ids);
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

  // required inputs per docs :contentReference[oaicite:4]{index=4}
  url.searchParams.set("start_time", start);
  url.searchParams.set("end_time", end);
  url.searchParams.set("quantity", String(quantity));

  // Optional: limit searched resources by comma-separated IDs (ppp_resfilter) :contentReference[oaicite:5]{index=5}
  if (resourceIds && resourceIds.length) {
    url.searchParams.set("ppp_resfilter", resourceIds.join(","));
  }

  // Optional auth (some accounts/configs)
  if (username) url.searchParams.set("username", username);
  if (password) url.searchParams.set("password", password);

  const resp = await fetch(url.toString(), { method: "GET" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Planyo HTTP ${resp.status}. Body: ${text.slice(0, 300)}`);
  }

  const data = await resp.json().catch(async () => {
    const text = await resp.text();
    throw new Error(`Planyo response not JSON. First 200 chars: ${text.slice(0, 200)}`);
  });

  return data;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
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

    const ids = parseIds(resourceIds);

    const planyoData = await callPlanyoResourceSearch({
      baseUrl,
      apiKey,
      start,
      end,
      quantity: qty,
      resourceIds: ids,
      username,
      password,
    });

    // Planyo error format (common): response_code + response_message
    if (planyoData?.response_code && planyoData.response_code !== 0) {
      return json(res, 200, {
        start,
        end,
        quantity: qty,
        availableResourceIds: [],
        error: {
          response_code: planyoData.response_code,
          response_message: planyoData.response_message,
        },
        ...(debugMode
          ? {
              debug: {
                topLevelKeys: safeKeys(planyoData),
                rawPreview: makeRawPreview(planyoData),
              },
            }
          : {}),
      });
    }

    const availableResourceIds = extractAvailableIds(planyoData);

    return json(res, 200, {
      start,
      end,
      quantity: qty,
      // Als je resourceIds meegaf, zijn dit de "available binnen die set".
      // Als je niets meegaf, zijn dit alle available resources die Planyo teruggeeft.
      availableResourceIds,
      meta: {
        requestedFilterCount: ids.length,
        returnedCount: availableResourceIds.length,
        debug: debugMode ? 1 : 0,
      },
      ...(debugMode
        ? {
            debug: {
              topLevelKeys: safeKeys(planyoData),
              rawPreview: makeRawPreview(planyoData),
            },
          }
        : {}),
    });
  } catch (err) {
    return json(res, 500, { error: err?.message || "Unknown error" });
  }
}
