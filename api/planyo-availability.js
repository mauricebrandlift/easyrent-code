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
 * Env vars:
 * - PLANYO_API_BASE     (default: https://www.planyo.com/rest/)
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

function isUnixSeconds(n) {
  return typeof n === "number" && n > 1000000000 && n < 99999999999;
}

function unixSecondsToDateUTC(sec) {
  return new Date(sec * 1000);
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
  const url = new URL(baseUrl || "https://www.planyo.com/rest/");
  url.searchParams.set("method", "get_resource_usage");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("resource_id", String(resourceId));
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set("separate_periods", "true");

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

function extractBusyRangesForResource(planyoData, resourceId) {
  const busy = [];
  const rid = String(resourceId);

  const usageByRid = planyoData?.data?.usage?.[rid];
  if (usageByRid && typeof usageByRid === "object") {
    for (const key of Object.keys(usageByRid)) {
      const item = usageByRid[key];
      const from = item?.from;
      const to = item?.to;

      if (isUnixSeconds(from) && isUnixSeconds(to)) {
        busy.push({ start: unixSecondsToDateUTC(from), end: unixSecondsToDateUTC(to) });
      }
    }
    return busy;
  }

  // Fallbacks (niet nodig in jouw case, maar safe)
  const candidates = [
    planyoData?.data?.periods,
    planyoData?.periods,
    planyoData?.data?.bookings,
    planyoData?.bookings,
    planyoData?.result?.periods,
  ].find((arr) => Array.isArray(arr));

  if (!candidates) return busy;

  for (const item of candidates) {
    const fromIso =
      item?.from || item?.start || item?.date_from || item?.begin || item?.start_date;
    const toIso = item?.to || item?.end || item?.date_to || item?.finish || item?.end_date;

    if (isValidISODate(fromIso) && isValidISODate(toIso)) {
      busy.push({ start: toDateUTC(fromIso), end: toDateUTC(toIso) });
      continue;
    }

    const from = item?.from;
    const to = item?.to;
    if (isUnixSeconds(from) && isUnixSeconds(to)) {
      busy.push({ start: unixSecondsToDateUTC(from), end: unixSecondsToDateUTC(to) });
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
        error: "Missing resourceIds. Provide comma-separated resource IDs from Webflow CMS.",
      });
    }

    const checkRange = { start: startDate, end: endDate };
    const CONCURRENCY = 6;

    const errorsByResourceId = {};

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

      // ✅ Belangrijk: bij Planyo error -> markeer NIET als available
      if (planyoData?.response_code && planyoData?.response_code !== 0) {
        errorsByResourceId[String(id)] = {
          response_code: planyoData.response_code,
          response_message: planyoData.response_message,
        };

        if (!debugMode) return { id: String(id), isAvailable: false };

        return {
          id: String(id),
          isAvailable: false,
          debugInfo: {
            error: {
              response_code: planyoData.response_code,
              response_message: planyoData.response_message,
            },
            topLevelKeys: safeKeys(planyoData),
            rawPreview: makeRawPreview(planyoData),
            busyCount: 0,
          },
        };
      }

      const busyRanges = extractBusyRangesForResource(planyoData, id);

      let isAvailable = true;
      for (const b of busyRanges) {
        if (rangesOverlap(checkRange.start, checkRange.end, b.start, b.end)) {
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
          usageKeys: safeKeys(planyoData?.data?.usage),
          busyCount: busyRanges.length,
          busySample: busyRanges.slice(0, 5).map((r) => ({
            start: r.start.toISOString(),
            end: r.end.toISOString(),
          })),
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
      errorsByResourceId,
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
