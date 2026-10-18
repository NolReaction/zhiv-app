import type { EarthWeatherCondition, EarthWeatherResponse } from "@/lib/earth-weather-contract";
export type { EarthWeatherCondition } from "@/lib/earth-weather-contract";

export const EARTH_WEATHER_MIN_ZOOM = 3;
export const EARTH_WEATHER_CACHE_TTL_MS = 15 * 60_000;
export const EARTH_WEATHER_MAX_STALE_MS = 6 * 60 * 60_000;
export const EARTH_WEATHER_MIN_INTERVAL_MS = 15_000;
export const EARTH_WEATHER_CACHE_LIMIT = 16;
const REQUEST_TIMEOUT_MS = 12_000;
const VIEW_SETTLE_MS = 450;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ERROR_RETRY_MS = 15_000;
const MAX_ERROR_RETRY_MS = 60_000;

export type EarthWeatherArea = { readonly key: string; readonly longitude: number; readonly latitude: number };
export type EarthWeatherSnapshot = {
  readonly area: EarthWeatherArea;
  readonly condition: EarthWeatherCondition;
  readonly temperatureC: number | null;
  readonly cloudCoverPercent: number | null;
  /** Predicted precipitation for the following hour, not an observation. */
  readonly precipitationMm: number | null;
  readonly windSpeedMps: number | null;
  readonly forecastAt: number;
  readonly updatedAt: number;
  readonly fetchedAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
  readonly isDay: boolean | null;
  readonly stale: boolean;
};
export type EarthWeatherReading = Omit<EarthWeatherSnapshot, "area" | "fetchedAt">;
export type EarthWeatherProvider = {
  readonly id: string;
  readonly minimumIntervalMs?: number;
  fetchWeather(area: EarthWeatherArea, signal: AbortSignal): Promise<EarthWeatherReading>;
};
export type EarthWeatherState = {
  readonly status: "disabled" | "zoom-in" | "waiting" | "loading" | "ready" | "stale" | "error";
  readonly area: EarthWeatherArea | null;
  readonly snapshot: EarthWeatherSnapshot | null;
  readonly nextRequestAt: number | null;
  readonly error: string | null;
};

type CachedWeather = { key: string; snapshot: EarthWeatherSnapshot };
export type EarthWeatherCache = {
  get(key: string): EarthWeatherSnapshot | undefined;
  put(key: string, snapshot: EarthWeatherSnapshot): void;
  nextRequestAt(): number;
  reserve(nextRequestAt: number): void;
};

/** Public, coarse map areas only. The cache is separate from accounts and GPS. */
export function createEarthWeatherCache(): EarthWeatherCache {
  const entries = new Map<string, CachedWeather>();
  let nextRequestAt = 0;
  return {
    get(key) {
      const cached = entries.get(key);
      if (!cached) return undefined;
      entries.delete(key);
      entries.set(key, cached);
      return cached.snapshot;
    },
    put(key, snapshot) {
      entries.delete(key);
      entries.set(key, { key, snapshot });
      while (entries.size > EARTH_WEATHER_CACHE_LIMIT) entries.delete(entries.keys().next().value!);
    },
    nextRequestAt: () => nextRequestAt,
    reserve(value) { if (Number.isFinite(value)) nextRequestAt = Math.max(nextRequestAt, value); },
  };
}

const sharedWeatherCache = createEarthWeatherCache();

/** Round before handing any coordinate to a provider; ±180 share one cell. */
export function earthWeatherArea(longitude: number, latitude: number): EarthWeatherArea | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  const roundedLongitude = Math.round(wrapped);
  const lng = roundedLongitude === 180 ? -180 : roundedLongitude || 0;
  const lat = Math.max(-89, Math.min(89, Math.round(latitude))) || 0;
  return { key: `${lat}:${lng}`, longitude: lng, latitude: lat };
}

const conditions = new Set<EarthWeatherCondition>(["clear", "partly-cloudy", "cloudy", "fog", "rain", "snow", "sleet", "thunderstorm", "unknown"]);
function validReading(value: EarthWeatherReading): boolean {
  return !!value && conditions.has(value.condition)
    && (value.temperatureC === null || (Number.isFinite(value.temperatureC) && value.temperatureC >= -100 && value.temperatureC <= 70))
    && (value.cloudCoverPercent === null || (Number.isFinite(value.cloudCoverPercent) && value.cloudCoverPercent >= 0 && value.cloudCoverPercent <= 100))
    && (value.precipitationMm === null || (Number.isFinite(value.precipitationMm) && value.precipitationMm >= 0 && value.precipitationMm <= 1_000))
    && (value.windSpeedMps === null || (Number.isFinite(value.windSpeedMps) && value.windSpeedMps >= 0 && value.windSpeedMps <= 150))
    && [value.forecastAt, value.updatedAt, value.expiresAt, value.staleUntil].every(Number.isFinite)
    && value.staleUntil >= value.expiresAt
    && (value.isDay === null || typeof value.isDay === "boolean") && typeof value.stale === "boolean";
}

class WeatherRequestError extends Error {
  constructor(readonly retryAt: number | null) { super("Weather request unavailable"); }
}

/** Only this same-origin public proxy contacts the meteorological provider. */
export function createEarthWeatherProvider({ fetch: fetcher = fetch, now = Date.now }: { fetch?: typeof fetch; now?: () => number } = {}): EarthWeatherProvider {
  return {
    id: "met-norway",
    minimumIntervalMs: EARTH_WEATHER_MIN_INTERVAL_MS,
    async fetchWeather(area, signal) {
      const canonical = earthWeatherArea(area.longitude, area.latitude);
      if (!canonical || canonical.key !== area.key || canonical.latitude !== area.latitude || canonical.longitude !== area.longitude) {
        throw new Error("Weather coordinates must already be coarse");
      }
      const response = await fetcher(`/api/v1/earth/weather?lat=${area.latitude}&lng=${area.longitude}`, {
        signal, credentials: "same-origin", headers: { Accept: "application/json" },
      });
      // A reverse proxy can return a non-JSON error and still supply Retry-After.
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const retryHeader = response.headers.get("Retry-After");
        const seconds = retryHeader?.trim() ? Number(retryHeader) : NaN;
        const retryDate = retryHeader ? Date.parse(retryHeader) : NaN;
        const bodySeconds = raw && typeof raw === "object" && "retryAfterSeconds" in raw ? raw.retryAfterSeconds : null;
        const afterSeconds = (delay: number) => Math.min(Number.MAX_SAFE_INTEGER, now() + delay * 1_000);
        const retryAt = Number.isFinite(seconds) && seconds >= 0 ? afterSeconds(seconds)
          : Number.isFinite(retryDate) ? retryDate
            : typeof bodySeconds === "number" && Number.isFinite(bodySeconds) && bodySeconds >= 0 ? afterSeconds(bodySeconds) : null;
        throw new WeatherRequestError(retryAt);
      }
      const value = raw as Partial<EarthWeatherResponse> | null;
      if (!value || value.provider !== "met-norway" || value.latitude !== area.latitude || value.longitude !== area.longitude) {
        throw new Error("Weather region mismatch");
      }
      const reading: EarthWeatherReading = {
        condition: value.condition!, temperatureC: value.temperatureC!, cloudCoverPercent: value.cloudCoverPercent!,
        precipitationMm: value.precipitationNextHourMm!, windSpeedMps: value.windSpeedMps!,
        forecastAt: typeof value.forecastAt === "string" ? Date.parse(value.forecastAt) : NaN,
        updatedAt: typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : NaN,
        expiresAt: typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN,
        staleUntil: typeof value.staleUntil === "string" ? Date.parse(value.staleUntil) : NaN,
        isDay: value.isDay!, stale: value.stale!,
      };
      if (!validReading(reading)) throw new Error("Invalid weather reading");
      return reading;
    },
  };
}

type Timer = ReturnType<typeof setTimeout>;
type WeatherControllerOptions = {
  provider: EarthWeatherProvider | null;
  onState: (state: EarthWeatherState) => void;
  cache?: EarthWeatherCache;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
};

/**
 * Opt-in forecast controller. A camera move never reads GPS or adds resources to
 * the map loader. The chosen provider owns transport, provenance and licensing.
 */
export function createEarthWeatherController({ provider, onState, cache = sharedWeatherCache,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }: WeatherControllerOptions) {
  let enabled = false;
  let visible = false;
  let disposed = false;
  let area: EarthWeatherArea | null = null;
  let timer: Timer | null = null;
  let request: { controller: AbortController; deadline: Timer; version: number } | null = null;
  let version = 0;
  let failureCount = 0;
  let state: EarthWeatherState = { status: "disabled", area: null, snapshot: null, nextRequestAt: null, error: null };
  const minimumInterval = Math.max(EARTH_WEATHER_MIN_INTERVAL_MS,
    Number.isFinite(provider?.minimumIntervalMs) ? provider!.minimumIntervalMs! : 0);

  function publish(status: EarthWeatherState["status"], snapshot: EarthWeatherSnapshot | null = null,
    nextRequestAt: number | null = null, error: string | null = null) {
    if (disposed) return;
    const currentArea = status === "disabled" || status === "zoom-in" ? null : area;
    if (state.status === status && state.area?.key === currentArea?.key && state.snapshot === snapshot
      && state.nextRequestAt === nextRequestAt && state.error === error) return;
    state = { status, area: currentArea, snapshot, nextRequestAt, error };
    onState(state);
  }
  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function stopWork() {
    clearTimer();
    version++;
    if (request) {
      const current = request;
      request = null;
      cancel(current.deadline);
      current.controller.abort();
    }
  }
  function after(delay: number, callback: () => void) {
    clearTimer();
    // Browsers and Node turn overflowing timeout delays into near-immediate
    // callbacks. A long provider backoff is checked in safe-sized intervals.
    timer = schedule(() => { timer = null; callback(); }, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, delay)));
  }
  function cachedWeather(key: string) {
    const cached = cache.get(key);
    return cached && now() < cached.staleUntil ? cached : null;
  }
  function waitUntil(requestAt: number, cached: EarthWeatherSnapshot | null) {
    // The old forecast must disappear at its absolute deadline, including when
    // Retry-After keeps the next request farther into the future.
    after(Math.min(requestAt, cached?.staleUntil ?? Infinity) - now(), () => reconcile());
  }
  function failure(key: string, providerRetryAt: number | null = null) {
    const cached = cachedWeather(key);
    const retryDelay = Math.min(MAX_ERROR_RETRY_MS, ERROR_RETRY_MS * 2 ** Math.min(failureCount++, 2));
    const retryAt = Math.max(cache.nextRequestAt(), providerRetryAt ?? now() + retryDelay);
    cache.reserve(retryAt);
    publish(cached ? "stale" : "error", cached, retryAt, "Не удалось обновить прогноз.");
    waitUntil(retryAt, cached);
  }
  function load(key: string, target: EarthWeatherArea) {
    if (!provider || disposed || !enabled || !visible || area?.key !== target.key) return;
    const started = now();
    // Shared across controller/map instances, including failed or aborted calls.
    cache.reserve(started + minimumInterval);
    const controller = new AbortController();
    const currentVersion = ++version;
    const deadline = schedule(() => {
      if (request?.version !== currentVersion) return;
      stopWork();
      failure(key);
    }, REQUEST_TIMEOUT_MS);
    request = { controller, deadline, version: currentVersion };
    const cached = cachedWeather(key);
    publish(cached ? "stale" : "loading", cached);
    if (cached) after(cached.staleUntil - now(), () => {
      if (request?.version === currentVersion) publish("loading");
    });
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Weather request cancelled");
      return provider.fetchWeather(target, controller.signal);
    }).then(reading => {
      if (disposed || request?.version !== currentVersion || controller.signal.aborted) return;
      if (!validReading(reading) || reading.staleUntil <= now()) throw new Error("Invalid weather reading");
      cancel(deadline);
      request = null;
      const fetchedAt = now();
      const expiresAt = Math.min(reading.expiresAt, fetchedAt + EARTH_WEATHER_CACHE_TTL_MS);
      const snapshot: EarthWeatherSnapshot = { ...reading, area: target, fetchedAt,
        stale: reading.stale || reading.expiresAt <= fetchedAt,
        // The proxy already respects upstream Expires. Its shorter boundary may
        // select a new forecast hour, so the browser must not extend that TTL.
        expiresAt,
        staleUntil: Math.min(reading.staleUntil, expiresAt + EARTH_WEATHER_MAX_STALE_MS) };
      cache.put(key, snapshot);
      failureCount = 0;
      publish(snapshot.stale ? "stale" : "ready", snapshot);
      after(snapshot.expiresAt - now(), () => reconcile());
    }).catch(error => {
      if (disposed || request?.version !== currentVersion || controller.signal.aborted) return;
      cancel(deadline);
      request = null;
      failure(key, error instanceof WeatherRequestError ? error.retryAt : null);
    });
  }
  function reconcile(settleMs = 0) {
    if (disposed) return;
    if (!enabled) { publish("disabled"); return; }
    if (!area) { publish("zoom-in"); return; }
    if (!visible) return;
    if (!provider) { publish("error", null, null, "Источник прогноза пока недоступен."); return; }
    const key = `${provider.id}:${area.key}`;
    const cached = cachedWeather(key);
    const time = now();
    if (cached && time < cached.expiresAt) {
      publish(cached.stale ? "stale" : "ready", cached);
      after(cached.expiresAt - time, () => reconcile());
      return;
    }
    if (request) return;
    const requestAt = Math.max(cache.nextRequestAt(), time + settleMs);
    if (requestAt > time) {
      publish(cached ? "stale" : "waiting", cached, requestAt);
      waitUntil(requestAt, cached);
      return;
    }
    clearTimer();
    load(key, area);
  }

  onState(state);
  return {
    setEnabled(value: boolean) {
      if (disposed || enabled === value) return;
      enabled = value;
      stopWork();
      reconcile();
    },
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value;
      if (!value) stopWork();
      else reconcile();
    },
    setView(view: { longitude: number; latitude: number; zoom: number }) {
      if (disposed) return;
      const nextArea = Number.isFinite(view.zoom) && view.zoom >= EARTH_WEATHER_MIN_ZOOM
        ? earthWeatherArea(view.longitude, view.latitude) : null;
      if (area?.key === nextArea?.key) return;
      area = nextArea;
      stopWork();
      reconcile(VIEW_SETTLE_MS);
    },
    dispose() {
      if (disposed) return;
      stopWork();
      disposed = true;
    },
  };
}
