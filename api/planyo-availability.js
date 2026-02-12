/**
 * Vercel Serverless Function (Node)
 * Endpoint: /api/planyo-availability
 *
 * Query params:
 * - start=YYYY-MM-DD
 * - end=YYYY-MM-DD
 * - resourceIds=123,456,789   (optioneel maar aanbevolen; zo filter je alleen op je CMS IDs)
 *
 * Env vars (Vercel Project Settings):
 * - PLANYO_API_BASE     (default: https://www.planyo.com/rest/)
 * - PLANYO_API_KEY      (jouw Planyo API key)
 * - PLANYO_API_USERNAME (optioneel, als jouw setup dat vereist)
 * - PLANYO_API_PASSWORD (optioneel, als jouw setup dat vereist)
 *
 * Output:
 * { start, end, availableResourceIds: ["123","456"], unavailableResourceIds: ["789"] }
 */

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Kleine cache om spikes te dempen (pas aan naar wens)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.end(JSON.stringify(data));
}

function isValidISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toDateUTC(iso) {
  // Force UTC midnight
  return new Date(`${iso}T00:00:00.000Z`);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  // Overlap if start < otherEnd && otherStart < end
  return aStart < bEnd && bStart < aEnd;
}

function parseIds(csv) {
  if (!csv) return [];
  return String(csv)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

async function callPlanyoGetResourceUsage({ baseUrl, apiKey, start, end, resourceId, username, password }) {
  // Planyo REST endpoint variations bestaan; deze is de meest gangbare:
  // https://www.planyo.com/rest/?method=get_resource_usage&api_key=...&resource_id=...&from=...&to=...
  // Als jouw account andere param-namen vereist, passen we dit straks aan zodra je 1 voorbeeldresponse deelt.

  const url = new URL(baseUrl || "https://www.planyo.com/rest/");
  url.searchParams.set("method", "get_resource_usage");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("resource_id", String(resourceId));
  url.searchParams.set("from", start);
  url.searchParams.set("to", end);

  // Sommige Planyo setups gebruiken extra auth:
  if (username) url.searchParams.set("username", username);
  if (password) url.searchParams.set("password", password);

  const resp = await fetch(url.toString(), { method: "GET" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Planyo HTTP ${resp.status} for resource ${resourceId}. Body: ${text.slice(0, 300)}`);
  }

  // Planyo kan JSON teruggeven; soms is het "text/json"
  const data = await resp.json().catch(async () => {
    const text = await resp.text();
    throw new Error(`Planyo response not JSON. First 200 chars: ${text.slice(0, 200)}`);
  });

  return data;
}

function extractBusyRanges(planyoData) {
  /**
   * Planyo responses verschillen per config.
   * Vaak zit bezetting in een array met items met from/to of start/end.
   *
   * We proberen meerdere vormen “best effort” te ondersteunen.
   * Als jouw response anders is, dan hoef je maar 1 sample te sturen en dan maken we dit exact.
   */

  const busy = [];

  // 1) Veelvoorkomend: { data: { periods: [{from:"YYYY-MM-DD", to:"YYYY-MM-DD"}] } }
  const candidates = [
    planyoData?.data?.periods,
    planyoData?.periods,
    planyoData?.data?.usage,
    planyoData?.usage,
    planyoData?.data?.bookings,
    planyoData?.bookings,
    planyoData?.result?.periods,
  ].find(arr => Array.isArray(arr));

  if (!candidates) return busy;

  for (const item of candidates) {
    const from = item?.from || item?.start || item?.date_from || item?.begin;
    const to = item?.to || item?.end || item?.date_to || item?.finish;

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

    const { start, end, resourceIds } = req.query;

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

    // Concurrency limit om Planyo niet te slopen
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

      const busyRanges = extractBusyRanges(planyoData);

      // Als Planyo bezette periodes teruggeeft, dan is beschikbaar als er GEEN overlap is
      let isAvailable = true;
      for (const b of busyRanges) {
        const bStart = toDateUTC(b.from);
        const bEnd = toDateUTC(b.to);
        if (rangesOverlap(checkRange.start, checkRange.end, bStart, bEnd)) {
          isAvailable = false;
          break;
        }
      }

      return { id: String(id), isAvailable };
    });

    const availableResourceIds = results.filter(r => r.isAvailable).map(r => r.id);
    const unavailableResourceIds = results.filter(r => !r.isAvailable).map(r => r.id);

    return json(res, 200, {
      start,
      end,
      availableResourceIds,
      unavailableResourceIds,
      meta: {
        checked: ids.length,
        concurrency: CONCURRENCY,
      },
    });
  } catch (err) {
    return json(res, 500, { error: err?.message || "Unknown error" });
  }
}
