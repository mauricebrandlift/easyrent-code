/**
 * Vercel Serverless Function (Node)
 * Endpoint: /api/planyo-availability
 *
 * Query params:
 * - start=YYYY-MM-DD
 * - end=YYYY-MM-DD
 * - resourceIds=248567,143577,...
 * - debug=1  (optioneel)
 *
 * Env vars (Vercel Project Settings):
 * - PLANYO_API_BASE     (default: https://www.planyo.com/rest/)
 * - PLANYO_API_KEY      (jouw Planyo API key)
 * - PLANYO_API_USERNAME (optioneel, als jouw setup dat vereist)
 * - PLANYO_API_PASSWORD (optioneel, als jouw setup dat vereist)
 *
 * Output:
 * {
 *   start, end,
 *   availableResourceIds: [...],
 *   unavailableResourceIds: [...],
 *   meta: {...},
 *   debugResults?: [...]
 * }
 *
 * Planyo doc: get_resource_usage requires:
 * - start_date (required)
 * - end_date (required)
 * - separate_periods (required)
 * - resource_id (optional)
 * - method=get_resource_usage (required)
 * - api_key (required)
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

function toDateUTC(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
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

function makeRawPreview(planyoData) {
  const preview = planyoData?.data ?? planyoData?.result ?? planyoData;
  if (Array.isArray(preview)) return preview.slice(0, 3);
  if (preview && typeof preview === "object") {
    const out = {};
    for (const k of Object.keys(preview).slice(0, 25)) out[k] = preview[k];
    return out;
  }
  return preview;
}

async function callPlanyoGetResourceUsage({
  baseUrl,
  apiKey,
  start,
  end,
  resourceId,
  username,
  password,
}) {
  // ✅ Correct parameter names for get_resource_usage:
  // start_date, end_date, separate_periods (required)
  // resource_id (optional)
  // method, api_key (required)
  // Docs: https://www.planyo.com/api.php?topic=get_resource_usage

  const url = new URL(baseUrl || "https://www.planyo.com/rest/");
  url.searchParams.set("method", "get_resource_usage");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("resource_id", String(resourceId));

  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);

  // required by Planyo; we want grouped ranges (smaller output)
  url.searchParams.set("separate_periods", "true");

  // Sommige setups gebruiken extra auth:
  if (username) url.searchParams.set("username", username);
  if (password) url.searchParams.set("password", password);

  const resp = await fetch(url.toString(), { method: "GET" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Planyo HTTP ${resp.status} for resource ${resourceId}. Body: ${text.slice(0, 300)}`
    );
  }

  const data = await resp.json().catch(async () => {
    const text = await resp.text();
    throw new Error(`Planyo response not JSON. First 200 chars: ${text.slice(0, 200)}`);
  });

  return data;
}

function extractBusyRanges(planyoData) {
  /**
   * Na fix van start_date/end_date/separate_periods zou Planyo nu usage moeten teruggeven.
   * De exacte structuur kan verschillen; we ondersteunen meerdere varianten.
   */

  const busy = [];

  const candidates = [
    planyoData?.data?.periods,
    planyoData?.periods,
    planyoData?.data?.usage,
    planyoData?.usage,
    planyoData?.data?.bookings,
    planyoData?.bookings,
    planyoData?.result?.periods,
    planyoData?.result?.usage,
    planyoData?.result?.bookings,
    planyoData?.data, // soms zit het direct hier in geneste arrays
    planyoData?.result,
  ].find((arr) => Array.isArray(arr));

  if (!candidates) return busy;

  for (const item of candidates) {
    // meest waarschijnlijke velden:
    const from = item?.from || item?.start || item?.date_from || item?.begin || item?.start_date;
    const to = item?.to || item?.end || item?.date_to || item?.finish || item?.end_date;

    if (isValidISODate(from) && isValidISODate(to)) {
      busy.push({ from, to });
    }
  }

  return busy;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
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

    const { start, end, resourceIds, debug } = req.query;
    const debugMode = String(debug || "").toLowerCase() === "1";

    if (!isValidISODate(start) || !isValidISODate(end)) {
      return json(res, 400, { error: "Invalid or missing start/end. Use YYYY-MM-DD." });
    }

    const startDate = toDateUTC(start);
    const endDate = toDateUTC(end);
    if (!(startDate < endDate)) {
      return json(res, 400, { error: "Invalid range: start must be before end." });
    }

    const ids = parseIds(resourceIds);
    if (ids.length === 0) {
      return json(res, 400, {
        error:
          "Missing resourceIds. Provide comma-separated resource IDs from your Webflow CMS (planyo_resource_id).",
      });
    }

    const checkRange = { start: startDate, end: endDate };
    const CONCURRENCY = 6;

    const results = await mapWithConcurrency(ids, CONCURRENCY, async (id) => {
      const planyoData = await callPlanyoGetResourceUsage({
        baseUrl,
        apiKey,
        start,
        end,
        resourceId: id,
        username,
        password,
      });

      // Planyo errors komen vaak als {response_code, response_message}
      if (planyoData?.response_code && planyoData?.response_code !== 0) {
        // We behandelen dit als "unknown" -> beschikbaar (maar met debug zichtbaar)
        const base = { id: String(id), isAvailable: true };
        if (!debugMode) return base;
        return {
          ...base,
          debugInfo: {
            error: {
              response_code: planyoData.response_code,
              response_message: planyoData.response_message,
            },
            topLevelKeys: safeKeys(planyoData),
            rawPreview: makeRawPreview(planyoData),
            busyRanges: [],
          },
        };
      }

      const busyRanges = extractBusyRanges(planyoData);

      let isAvailable = true;
      for (const b of busyRanges) {
        const bStart = toDateUTC(b.from);
        const bEnd = toDateUTC(b.to);
        if (rangesOverlap(checkRange.start, checkRange.end, bStart, bEnd)) {
          isAvailable = false;
          break;
        }
      }

      if (!debugMode) return { id: String(id), isAvailable };

      return {
        id: String(id),
        isAvailable,
        debugInfo: {
          topLevelKeys: safeKeys(planyoData),
          dataKeys: safeKeys(planyoData?.data),
          resultKeys: safeKeys(planyoData?.result),
          busyRanges,
          rawPreview: makeRawPreview(planyoData),
        },
      };
    });

    const availableResourceIds = results.filter((r) => r.isAvailable).map((r) => r.id);
    const unavailableResourceIds = results.filter((r) => !r.isAvailable).map((r) => r.id);

    return json(res, 200, {
      start,
      end,
      availableResourceIds,
      unavailableResourceIds,
      meta: {
        checked: ids.length,
        concurrency: CONCURRENCY,
        debug: debugMode ? 1 : 0,
      },
      ...(debugMode ? { debugResults: results } : {}),
    });
  } catch (err) {
    return json(res, 500, { error: err?.message || "Unknown error" });
  }
}
