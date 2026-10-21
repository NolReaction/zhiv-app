import type { Map as LibreMap, RasterSourceSpecification } from "maplibre-gl";
import { createEarthSatelliteVisuals } from "./satellite-visuals";

export const EARTH_SATELLITE_SOURCE = "earth-satellite";
export const EARTH_SATELLITE_LAYER = "earth-satellite-imagery";
export const EARTH_SATELLITE_MIN_ZOOM = 10;
const METADATA_URL = "https://api.maptiler.com/tiles/satellite-v2/tiles.json";
const METADATA_LIMIT = 64 * 1024;
const METADATA_TIMEOUT = 15_000;
const TILE_TIMEOUT = 20_000;
const FALLBACK_ERROR = "Спутник пока недоступен. Возвращаем обычную карту.";
const ACCESS_ERROR = "Нет доступа к спутниковым снимкам. Попробуйте позже.";
const LIMIT_ERROR = "Лимит спутниковой карты исчерпан. Попробуйте позже.";
const TIMEOUT_ERROR = "Спутниковая карта загружается слишком долго. Попробуйте ещё раз.";

type SatelliteStatus = "off" | "unavailable" | "zoom-required" | "paused" | "offline" | "loading" | "ready" | "error";
export type EarthSatelliteState = Readonly<{
  enabled: boolean;
  imageryVisible: boolean;
  status: SatelliteStatus;
  error: string | null;
  /** Bounded provider text; render as text or safe React links, never raw HTML. */
  attribution: string | null;
  minZoom: number;
}>;
export const DEFAULT_EARTH_SATELLITE_STATE: EarthSatelliteState = Object.freeze({
  enabled: false, imageryVisible: false, status: "off", error: null, attribution: null, minZoom: EARTH_SATELLITE_MIN_ZOOM,
});
export const EARTH_SATELLITE_INITIAL_STATE = DEFAULT_EARTH_SATELLITE_STATE;

type SatelliteMap = Pick<LibreMap, "on" | "off" | "getZoom" | "isMoving" | "getLayer" | "getSource"
  | "addSource" | "removeSource" | "addLayer" | "removeLayer" | "isSourceLoaded"
  | "getPaintProperty" | "setPaintProperty" | "getLayoutProperty" | "setLayoutProperty">;
type SatelliteOptions = {
  apiKey: string | undefined;
  onChange: (state: EarthSatelliteState) => void;
  beforeLayerId?: () => string | undefined;
  environment?: {
    fetch?: typeof fetch;
    setTimeout?: (callback: () => void, delay: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  };
};
type Metadata = RasterSourceSpecification & { attribution: string; minzoom: number; maxzoom: number; tileSize: number };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
function providerUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.maptiler.com" && !url.port && !url.username
      && !url.password && !url.hash && url.pathname.startsWith("/tiles/satellite-v2/") ? url : null;
  } catch { return null; }
}
function errorMessage(value: unknown): string {
  const status = record(value)?.status;
  return status === 401 || status === 403 ? ACCESS_ERROR : status === 429 ? LIMIT_ERROR : FALLBACK_ERROR;
}
function metadataFrom(value: unknown, apiKey: string): Metadata {
  const data = record(value);
  if (!data || !Array.isArray(data.tiles) || data.tiles.length < 1 || data.tiles.length > 8
    || typeof data.attribution !== "string" || !data.attribution.trim() || data.attribution.length > 4096
    || data.attribution.includes(apiKey) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(data.attribution)) throw new Error();
  const declaredTileSize = data.tileSize !== undefined ? data.tileSize : data.tile_size;
  // Raw satellite-v2 currently omits its size from TileJSON. Its actual JPEG
  // response was verified as 512×512 (2026-10-21); rendered /maps tiles are a
  // different API. Explicit provider metadata always takes precedence.
  const tileSize = declaredTileSize === undefined && data.format === "jpg" ? 512 : declaredTileSize;
  const minzoom = data.minzoom, maxzoom = data.maxzoom;
  if ((tileSize !== 256 && tileSize !== 512 && tileSize !== 1024)
    || typeof minzoom !== "number" || !Number.isInteger(minzoom) || minzoom < 0
    || typeof maxzoom !== "number" || !Number.isInteger(maxzoom) || maxzoom < minzoom || maxzoom > 24
    || maxzoom < EARTH_SATELLITE_MIN_ZOOM || (data.scheme !== undefined && data.scheme !== "xyz" && data.scheme !== "tms")) throw new Error();
  const tiles = data.tiles.map(value => {
    const url = providerUrl(value);
    const path = url?.pathname.replace(/%7B([zxy])%7D/gi, "{$1}");
    if (!url || !path || !/^\/tiles\/satellite-v2\/\{z\}\/\{x\}\/\{y\}(?:@2x)?(?:\.(?:jpg|jpeg|png|webp|avif))?$/.test(path)
      || [...url.searchParams.keys()].some(key => key !== "key") || url.searchParams.getAll("key").length > 1) throw new Error();
    url.searchParams.set("key", apiKey);
    return url.toString().replace(/%7B([zxy])%7D/gi, "{$1}");
  });
  let bounds: [number, number, number, number] | undefined;
  if (data.bounds !== undefined) {
    if (!Array.isArray(data.bounds) || data.bounds.length !== 4 || !data.bounds.every(item => typeof item === "number" && Number.isFinite(item))) throw new Error();
    bounds = data.bounds as [number, number, number, number];
    if (bounds[0] < -180 || bounds[2] > 180 || bounds[0] >= bounds[2] || bounds[1] < -90 || bounds[3] > 90 || bounds[1] >= bounds[3]) throw new Error();
  }
  return { type: "raster", tiles, minzoom, maxzoom, tileSize, attribution: data.attribution,
    ...(bounds ? { bounds } : {}), ...(data.scheme ? { scheme: data.scheme } : {}) };
}
async function limitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > METADATA_LIMIT) throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    for (;;) {
      const result = await reader.read();
      if (signal.aborted) throw new Error();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > METADATA_LIMIT) throw new Error();
      chunks.push(result.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error();
  } finally { signal.removeEventListener("abort", aborted); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Optional online imagery, added to the existing style only after an explicit choice.
 * No application cache/proxy is used. Removing the source cancels SDK tile requests.
 * The owning map must call ownsError before its general error/recovery handler.
 */
export function createEarthSatellite(map: SatelliteMap, options: SatelliteOptions) {
  const request = options.environment?.fetch ?? globalThis.fetch;
  const schedule = options.environment?.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.environment?.clearTimeout ?? (handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const apiKey = options.apiKey?.trim() ?? "";
  const hasKey = /^[A-Za-z0-9_-]{1,200}$/.test(apiKey);
  let state = DEFAULT_EARTH_SATELLITE_STATE;
  let enabled = false, visible = false, online = true, disposed = false, generation = 0;
  let metadata: Metadata | null = null, pending: AbortController | null = null;
  let metadataTimer: unknown = null, tileTimer: unknown = null;
  const visuals = createEarthSatelliteVisuals(map, EARTH_SATELLITE_LAYER);

  function publish(status: SatelliteStatus, error: string | null = null, attribution: string | null = null) {
    const imageryVisible = enabled && visible && online && !!map.getLayer(EARTH_SATELLITE_LAYER);
    if (disposed || (state.enabled === enabled && state.imageryVisible === imageryVisible && state.status === status && state.error === error && state.attribution === attribution)) return;
    state = Object.freeze({ enabled, imageryVisible, status, error, attribution, minZoom: Math.max(EARTH_SATELLITE_MIN_ZOOM, metadata?.minzoom ?? 0) });
    options.onChange(state);
  }
  function clearTileTimer() {
    if (tileTimer !== null) cancel(tileTimer);
    tileTimer = null;
  }
  function abortMetadata() {
    generation++;
    pending?.abort(); pending = null;
    if (metadataTimer !== null) cancel(metadataTimer);
    metadataTimer = null;
  }
  function removeImagery() {
    clearTileTimer();
    // Map removal/style replacement may already have destroyed these objects.
    try {
      if (map.getLayer(EARTH_SATELLITE_LAYER)) map.removeLayer(EARTH_SATELLITE_LAYER);
      if (map.getSource(EARTH_SATELLITE_SOURCE)) map.removeSource(EARTH_SATELLITE_SOURCE);
    } catch { /* Cleanup must never make the base map fail. */ }
    visuals.setActive(false);
  }
  function fail(message: string) {
    if (disposed || !enabled) return;
    enabled = false; abortMetadata(); removeImagery(); publish("error", message);
  }
  function ownsError(event: unknown) {
    const data = record(event);
    return data?.sourceId === EARTH_SATELLITE_SOURCE || !!providerUrl(data?.url) || !!providerUrl(record(data?.error)?.url);
  }
  function sourceReady() {
    if (disposed || !enabled || !visible || !online || !map.getSource(EARTH_SATELLITE_SOURCE)) return;
    if (map.isSourceLoaded(EARTH_SATELLITE_SOURCE)) {
      clearTileTimer(); publish("ready", null, metadata?.attribution ?? null);
    } else {
      publish("loading", null, metadata?.attribution ?? null);
      if (tileTimer === null && !map.isMoving()) tileTimer = schedule(() => { tileTimer = null; fail(TIMEOUT_ERROR); }, TILE_TIMEOUT);
    }
  }
  function install() {
    if (!metadata || disposed || !enabled) return;
    try {
      const before = options.beforeLayerId?.() ?? "earth-roads-edge";
      // Never accidentally place imagery above markers if the base style is absent.
      if (!map.getLayer(before)) throw new Error();
      if (!map.getSource(EARTH_SATELLITE_SOURCE)) map.addSource(EARTH_SATELLITE_SOURCE, metadata);
      if (!enabled || disposed) return;
      if (!map.getLayer(EARTH_SATELLITE_LAYER)) {
        map.addLayer({ id: EARTH_SATELLITE_LAYER, type: "raster", source: EARTH_SATELLITE_SOURCE,
          minzoom: Math.max(EARTH_SATELLITE_MIN_ZOOM, metadata.minzoom),
          paint: { "raster-opacity": 1, "raster-fade-duration": 200 } }, before);
      }
      visuals.setActive(true);
      sourceReady();
    } catch { fail(FALLBACK_ERROR); }
  }
  async function loadMetadata() {
    const controller = new AbortController();
    pending = controller;
    const version = ++generation;
    publish("loading");
    metadataTimer = schedule(() => { metadataTimer = null; fail(TIMEOUT_ERROR); }, METADATA_TIMEOUT);
    try {
      const url = new URL(METADATA_URL); url.searchParams.set("key", apiKey);
      const response = await request(url.toString(), { signal: controller.signal, mode: "cors", credentials: "omit", redirect: "error" });
      if (version !== generation || disposed) return;
      if (!response.ok) { fail(errorMessage({ status: response.status })); return; }
      const data = metadataFrom(await limitedJson(response, controller.signal), apiKey);
      if (version !== generation || disposed) return;
      metadata = data;
      if (metadataTimer !== null) cancel(metadataTimer);
      metadataTimer = null; pending = null;
      reconcile();
    } catch {
      if (version === generation && !disposed) fail(FALLBACK_ERROR);
    }
  }
  function reconcile() {
    if (disposed) return;
    if (!enabled || !visible || !online || map.getZoom() < Math.max(EARTH_SATELLITE_MIN_ZOOM, metadata?.minzoom ?? 0)) {
      abortMetadata(); removeImagery();
      if (!enabled) {
        if (state.status !== "error" && state.status !== "unavailable") publish("off");
      } else publish(!visible ? "paused" : !online ? "offline" : "zoom-required");
      return;
    }
    if (metadata) install();
    else if (!pending) void loadMetadata();
  }
  function moved() { reconcile(); }
  function moving() { clearTileTimer(); }
  function sourceEvent(event: unknown) {
    if (record(event)?.sourceId === EARTH_SATELLITE_SOURCE) sourceReady();
  }
  function errorEvent(event: unknown) {
    // Errors from cancelled requests stay owned but cannot undo a later pause.
    if (enabled && visible && online && map.getSource(EARTH_SATELLITE_SOURCE) && ownsError(event)) fail(errorMessage(record(event)?.error));
  }
  function dispose() {
    if (disposed) return;
    disposed = true; enabled = false; abortMetadata(); removeImagery(); metadata = null;
    state = DEFAULT_EARTH_SATELLITE_STATE;
    visuals.dispose();
    map.off("zoomend", moved); map.off("moveend", moved); map.off("movestart", moving);
    map.off("style.load", moved); map.off("sourcedata", sourceEvent); map.off("sourcedataloading", sourceEvent);
    map.off("render", sourceReady); map.off("error", errorEvent); map.off("remove", dispose);
  }
  map.on("zoomend", moved); map.on("moveend", moved); map.on("movestart", moving);
  map.on("style.load", moved); map.on("sourcedata", sourceEvent); map.on("sourcedataloading", sourceEvent);
  map.on("render", sourceReady); map.on("error", errorEvent); map.on("remove", dispose);
  return {
    getSnapshot: () => state,
    ownsError,
    setEnabled(value: boolean) {
      if (disposed) return;
      if (value && !hasKey) { enabled = false; publish("unavailable", "Спутниковый режим пока не подключён."); return; }
      enabled = value;
      if (!value) { abortMetadata(); removeImagery(); publish("off"); }
      else reconcile();
    },
    setVisible(value: boolean) { if (!disposed && visible !== value) { visible = value; reconcile(); } },
    setOnline(value: boolean) { if (!disposed && online !== value) { online = value; reconcile(); } },
    dispose,
  };
}
