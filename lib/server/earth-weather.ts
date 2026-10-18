// Server-only provider adapter. Features import the shared contract, never this module.
// https://api.met.no/doc/TermsOfService
// https://docs.api.met.no/doc/locationforecast/datamodel.html
import type { EarthWeatherCondition, EarthWeatherErrorResponse, EarthWeatherResponse } from "@/lib/earth-weather-contract";

const USER_AGENT = "YaZhivoy/0.7.1 (https://github.com/NolReaction/zhiv-app)";
const ENDPOINT = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_CELLS = 64;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_STALE_MS = 6 * HOUR;
const CLIENT_TTL_MS = 15 * MINUTE;

type Forecast = Omit<EarthWeatherResponse, "provider" | "latitude" | "longitude" | "updatedAt" | "expiresAt" | "staleUntil" | "stale"> & { time: number };
interface Entry {
  forecasts: Forecast[];
  updatedAt: string;
  validUntil: number;
  revalidateAfter: number;
  lastModified: string | null;
}
interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  /** Injectable short deadline for deterministic tests; production defaults to eight seconds. */
  timeoutMs?: number;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const numberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
const timestamp = (value: unknown) => typeof value === "string" && value.length <= 64 ? Date.parse(value) : NaN;

function conditionFrom(symbol: unknown): EarthWeatherCondition {
  if (typeof symbol !== "string") return "unknown";
  if (symbol.includes("thunder")) return "thunderstorm";
  if (symbol.includes("sleet")) return "sleet";
  if (symbol.includes("snow")) return "snow";
  if (symbol.includes("rain")) return "rain";
  if (symbol.startsWith("fog")) return "fog";
  if (symbol.startsWith("clearsky")) return "clear";
  if (symbol.startsWith("fair") || symbol.startsWith("partlycloudy")) return "partly-cloudy";
  if (symbol.startsWith("cloudy")) return "cloudy";
  return "unknown";
}

function parseForecasts(value: unknown) {
  const properties = record(record(value).properties);
  const updatedTime = timestamp(record(properties.meta).updated_at);
  if (!Number.isFinite(updatedTime) || !Array.isArray(properties.timeseries) || properties.timeseries.length > 300) throw new Error("Invalid forecast");
  const forecasts: Forecast[] = [];
  for (const raw of properties.timeseries) {
    const item = record(raw), time = timestamp(item.time);
    if (!Number.isFinite(time)) continue;
    const data = record(item.data), instant = record(record(data.instant).details);
    const nextHour = record(data.next_1_hours), summary = record(nextHour.summary);
    const symbol = summary.symbol_code;
    const cloudCoverPercent = numberIn(instant.cloud_area_fraction, 0, 100);
    const temperatureC = numberIn(instant.air_temperature, -100, 70);
    const condition = conditionFrom(symbol);
    if (cloudCoverPercent === null && temperatureC === null && condition === "unknown") continue;
    forecasts.push({
      time, forecastAt: new Date(time).toISOString(), condition, temperatureC, cloudCoverPercent,
      precipitationNextHourMm: numberIn(record(nextHour.details).precipitation_amount, 0, 1000),
      windSpeedMps: numberIn(instant.wind_speed, 0, 150),
      isDay: typeof symbol === "string" && symbol.endsWith("_day") ? true : typeof symbol === "string" && symbol.endsWith("_night") ? false : null,
    });
  }
  if (!forecasts.length) throw new Error("Empty forecast");
  forecasts.sort((a, b) => a.time - b.time);
  return { forecasts, updatedAt: new Date(updatedTime).toISOString() };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > MAX_BODY_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("Oversized or empty forecast");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Oversized forecast");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

function retryUntil(value: string | null, now: number, fallback: number) {
  if (value !== null) {
    const seconds = Number(value);
    if (value.trim() && Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(now + seconds * 1000)) return now + seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date) && date > now) return date;
  }
  return now + fallback;
}

function validUntil(response: Response, now: number) {
  const expires = Date.parse(response.headers.get("Expires") ?? "");
  // Preserve an expired provider deadline: a cooldown must never make stale data fresh.
  return Number.isFinite(expires) ? expires : now;
}

function errorResponse(error: EarthWeatherErrorResponse["error"], status: number, retryMs = 0): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryMs / 1000));
  return Response.json({ error, ...(retryMs > 0 ? { retryAfterSeconds } : {}) } satisfies EarthWeatherErrorResponse, {
    status,
    headers: { "Cache-Control": "no-store", ...(retryMs > 0 ? { "Retry-After": String(retryAfterSeconds) } : {}) },
  });
}

/** A process-local, bounded cache; no account, database, filesystem or user location is accessed. */
export function createEarthWeatherHandler(dependencies: Dependencies = {}) {
  const requestForecast = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Entry | null>>();
  let nextRequestAt = 0, upstreamBlockedUntil = 0;

  async function refresh(key: string, latitude: number, longitude: number, previous?: Entry): Promise<Entry | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 8000);
    try {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
      if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;
      const response = await requestForecast(`${ENDPOINT}?lat=${latitude}&lon=${longitude}`, {
        headers, signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error",
      });
      const receivedAt = now();
      if (response.status === 403 || response.status === 429) {
        upstreamBlockedUntil = Math.max(upstreamBlockedUntil, retryUntil(response.headers.get("Retry-After"), receivedAt, response.status === 403 ? HOUR : 15 * MINUTE));
        await response.body?.cancel();
        return null;
      }
      if (response.status === 304 && previous) {
        const expiry = validUntil(response, receivedAt);
        const refreshed = { ...previous, validUntil: expiry, revalidateAfter: Math.max(expiry, receivedAt + MINUTE) };
        cache.delete(key); cache.set(key, refreshed);
        return refreshed;
      }
      if (response.status !== 200 && response.status !== 203) {
        upstreamBlockedUntil = Math.max(upstreamBlockedUntil, retryUntil(response.headers.get("Retry-After"), receivedAt, MINUTE));
        await response.body?.cancel();
        return null;
      }
      const parsed = parseForecasts(await readBoundedJson(response));
      const lastModified = response.headers.get("Last-Modified");
      const expiry = validUntil(response, receivedAt);
      const entry = { ...parsed, validUntil: expiry, revalidateAfter: Math.max(expiry, receivedAt + MINUTE), lastModified: lastModified && lastModified.length <= 128 && Number.isFinite(Date.parse(lastModified)) ? lastModified : null };
      cache.delete(key); cache.set(key, entry);
      return entry;
    } catch {
      upstreamBlockedUntil = Math.max(upstreamBlockedUntil, now() + 30_000);
      return null;
    } finally {
      clearTimeout(timeout);
      inFlight.delete(key);
    }
  }

  function snapshot(entry: Entry, latitude: number, longitude: number): Response | null {
    const time = now(), stale = entry.validUntil <= time;
    // Select a current model hour even when HTTP 304 reused the same forecast run.
    const forecast = entry.forecasts.findLast(item => item.time <= time) ?? entry.forecasts[0];
    if (!forecast || forecast.time > time + HOUR) return null;
    const staleUntil = Math.min(entry.validUntil + MAX_STALE_MS, forecast.time + 3 * HOUR);
    if (time >= staleUntil) return null;
    const clientExpiry = stale ? Math.min(time + MINUTE, staleUntil)
      : Math.max(time, Math.min(entry.validUntil, time + CLIENT_TTL_MS, forecast.time + HOUR));
    const maxAge = Math.max(0, Math.floor((clientExpiry - time) / 1000));
    const body: EarthWeatherResponse = {
      provider: "met-norway", latitude, longitude,
      condition: forecast.condition, temperatureC: forecast.temperatureC,
      cloudCoverPercent: forecast.cloudCoverPercent, precipitationNextHourMm: forecast.precipitationNextHourMm,
      windSpeedMps: forecast.windSpeedMps, forecastAt: forecast.forecastAt, updatedAt: entry.updatedAt,
      expiresAt: new Date(clientExpiry).toISOString(), staleUntil: new Date(staleUntil).toISOString(), isDay: forecast.isDay, stale,
    };
    return Response.json(body, { headers: {
      "Cache-Control": `public, max-age=${maxAge}, must-revalidate`,
      Expires: new Date(clientExpiry).toUTCString(),
      "X-Content-Type-Options": "nosniff",
    } });
  }

  return async function handleEarthWeather(request: Request): Promise<Response> {
    const parameters = new URL(request.url).searchParams;
    const rawLatitude = parameters.get("lat"), rawLongitude = parameters.get("lng");
    // Reject precision instead of rounding it here: the user's GPS must never reach this route.
    const integer = (value: string | null) => value !== null && /^-?(?:0|[1-9]\d{0,2})$/.test(value);
    if ([...parameters.keys()].some(key => key !== "lat" && key !== "lng") || parameters.getAll("lat").length !== 1 || parameters.getAll("lng").length !== 1 || !integer(rawLatitude) || !integer(rawLongitude)) return errorResponse("invalid_coordinates", 400);
    const latitude = Number(rawLatitude), longitude = Number(rawLongitude);
    if (latitude < -89 || latitude > 89 || longitude < -180 || longitude > 179) return errorResponse("invalid_coordinates", 400);
    const key = `${latitude},${longitude}`, time = now();
    let entry = cache.get(key);
    if (entry && time < entry.revalidateAfter) {
      cache.delete(key); cache.set(key, entry);
      return snapshot(entry, latitude, longitude) ?? errorResponse("weather_unavailable", 503, entry.revalidateAfter - time);
    }
    const pending = inFlight.get(key);
    if (pending) {
      entry = await pending ?? entry;
      return entry && snapshot(entry, latitude, longitude) || errorResponse("weather_unavailable", 503, Math.max(MINUTE, upstreamBlockedUntil - now()));
    }
    const blockedUntil = Math.max(nextRequestAt, upstreamBlockedUntil);
    if (time < blockedUntil) return entry && snapshot(entry, latitude, longitude) || errorResponse("weather_busy", 429, blockedUntil - time);
    if (!entry && cache.size + inFlight.size >= MAX_CELLS) {
      // Evict only expired cells. Dropping fresh entries would defeat the provider's Expires rule.
      const expired = [...cache].find(([candidate, value]) => value.revalidateAfter <= time && !inFlight.has(candidate));
      if (expired) cache.delete(expired[0]);
      else {
        const nextExpiry = Math.min(...[...cache.values()].map(value => value.revalidateAfter));
        return errorResponse("weather_busy", 429, Number.isFinite(nextExpiry) ? Math.max(1000, nextExpiry - time) : 1000);
      }
    }
    nextRequestAt = time + 1000;
    const operation = Promise.resolve().then(() => refresh(key, latitude, longitude, entry));
    inFlight.set(key, operation);
    entry = await operation ?? entry;
    return entry && snapshot(entry, latitude, longitude) || errorResponse("weather_unavailable", 503, Math.max(MINUTE, upstreamBlockedUntil - now()));
  };
}
