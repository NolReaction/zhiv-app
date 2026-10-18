import type { AddProtocolAction, RequestParameters } from "maplibre-gl";

export const EARTH_CACHE_PROTOCOL = "earth-cache";
export const EARTH_CACHE_NAME = "zhiv-earth-openfreemap-v1";
export type EarthResourceType = "arrayBuffer" | "json" | "string" | "image";

export type EarthCacheSnapshot = {
  storage: "checking" | "device" | "session";
  persistence: "unknown" | "granted" | "best-effort";
  storageIssue: "unavailable" | "quota" | "write-failed" | "resource-too-large" | null;
  pending: number;
  completed: number;
  failed: number;
  cacheHits: number;
  networkBytes: number;
  storedBytes: number;
  storedEntries: number;
  quotaBytes: number | null;
  usageBytes: number | null;
};

export type EarthCacheOptions = {
  cacheStorage?: Pick<CacheStorage, "open"> | null;
  storageManager?: Pick<StorageManager, "persist" | "persisted" | "estimate"> | null;
  fetcher?: typeof fetch;
  origin?: string;
  maxBytes?: number;
  maxEntries?: number;
  concurrency?: number;
  timeoutMs?: number;
  storageTimeoutMs?: number;
  attempts?: number;
  mutableMaxAgeMs?: number;
};

type StoredResource = { bytes: ArrayBuffer; contentType: string; cacheControl: string | null; expires: string | null; savedAt: number };
type InventoryEntry = { url: string; size: number; saved: number };
type PendingResource = { controller: AbortController; consumers: number; promise: Promise<StoredResource> };
const MARKER = "x-zhiv-earth-cache";
const SIZE = "x-zhiv-earth-size";
const SAVED = "x-zhiv-earth-saved";
const VENDOR_PATH = /^\/vendor\/maplibre-gl-\d+\.\d+\.\d+\/(?:maplibre-gl(?:-worker|-shared)?\.mjs|manifest\.json|LICENSE\.txt)$/;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
class StorageTimeoutError extends Error {}

function abortError(): DOMException { return new DOMException("Map request cancelled", "AbortError"); }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }

/** Public map data only: never account API calls, location fixes, or arbitrary URLs. */
export function createEarthResourceCache(options: EarthCacheOptions = {}) {
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 512;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const storageTimeoutMs = options.storageTimeoutMs ?? 3000;
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const mutableMaxAgeMs = options.mutableMaxAgeMs ?? 24 * 60 * 60 * 1000;
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const listeners = new Set<() => void>();
  const inFlight = new Map<string, PendingResource>();
  const session = new Map<string, StoredResource>();
  const invalidated = new Set<string>();
  const queue: Array<() => void> = [];
  let running = 0;
  let memoryBytes = 0;
  let cache: Cache | null = null;
  let writable = true;
  let initialization: Promise<void> | null = null;
  let mutations: Promise<unknown> = Promise.resolve();
  let inventory = new Map<string, InventoryEntry>();
  let protectedVendor: string | null = null;
  let snapshot: EarthCacheSnapshot = {
    storage: "checking", persistence: "unknown", storageIssue: null,
    pending: 0, completed: 0, failed: 0, cacheHits: 0, networkBytes: 0,
    storedBytes: 0, storedEntries: 0, quotaBytes: null, usageBytes: null,
  };

  function update(values: Partial<EarthCacheSnapshot>) {
    snapshot = { ...snapshot, ...values };
    for (const listener of listeners) listener();
  }
  function inventoryChanged() {
    update({ storedEntries: inventory.size, storedBytes: [...inventory.values()].reduce((sum, item) => sum + item.size, 0) });
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation, operation);
    mutations = result.catch(() => undefined);
    return result;
  }
  async function storageDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageTimeoutError("Map storage timed out")), storageTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function cacheOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await storageDeadline(operation); }
    catch (error) {
      // Cache Storage has no AbortSignal. Stop issuing disk work after a stalled
      // operation; queued writes can still serve their already downloaded bytes.
      if (error instanceof StorageTimeoutError) { cache = null; unavailable("unavailable"); }
      throw error;
    }
  }
  function platformStorage(): EarthCacheOptions["storageManager"] {
    if (options.storageManager !== undefined) return options.storageManager;
    try { return typeof navigator === "undefined" ? null : navigator.storage; } catch { return null; }
  }
  function originalUrl(value: string): string {
    const prefix = `${EARTH_CACHE_PROTOCOL}://resource?url=`;
    if (value.startsWith(prefix)) value = decodeURIComponent(value.slice(prefix.length));
    const origin = options.origin ?? (typeof location === "undefined" ? undefined : location.origin);
    const url = new URL(value, origin);
    if (url.username || url.password || url.hash) throw new Error("Unsupported map resource URL");
    if (url.protocol === "https:" && url.hostname === "tiles.openfreemap.org" && !url.port) return url.href;
    if (origin && url.origin === origin && !url.search && VENDOR_PATH.test(url.pathname)) return url.href;
    throw new Error("Map resource is outside the public cache allowlist");
  }
  function vendorVersion(url: string): string | null {
    return new URL(url).pathname.match(/^\/vendor\/maplibre-gl-(\d+\.\d+\.\d+)\//)?.[1] ?? null;
  }
  function transformRequest(url: string): RequestParameters {
    try { return { url: `${EARTH_CACHE_PROTOCOL}://resource?url=${encodeURIComponent(originalUrl(url))}` }; }
    catch { return { url }; }
  }
  async function refreshEstimate() {
    try {
      const estimate = await storageDeadline(async () => platformStorage()?.estimate());
      if (estimate) update({ quotaBytes: estimate.quota ?? null, usageBytes: estimate.usage ?? null });
    } catch { /* Storage estimates are optional, unlike cached response validation. */ }
  }
  function unavailable(issue: EarthCacheSnapshot["storageIssue"]) {
    writable = false;
    update({ storage: "session", storageIssue: issue });
  }
  async function initialize() {
    if (!initialization) initialization = (async () => {
      try {
        const storage = options.cacheStorage !== undefined ? options.cacheStorage : globalThis.caches;
        if (!storage) throw new Error("Cache Storage unavailable");
        cache = await cacheOperation(() => storage.open(EARTH_CACHE_NAME));
        const records = new Map<string, InventoryEntry>();
        const disk = cache;
        const keys = await cacheOperation(() => disk.keys());
        // Read metadata in small batches instead of a disk round-trip per tile.
        for (let offset = 0; offset < keys.length; offset += 16) {
          const batch = keys.slice(offset, offset + 16);
          const responses = await Promise.all(batch.map(key => cacheOperation(() => disk.match(key))));
          for (const [index, key] of batch.entries()) {
            const response = responses[index];
            const size = Number(response?.headers.get(SIZE));
            const saved = Number(response?.headers.get(SAVED));
            let allowed = false;
            try { allowed = originalUrl(key.url) === key.url; } catch { /* Remove obsolete/unrecognized records. */ }
            if (allowed && response?.headers.get(MARKER) === EARTH_CACHE_NAME && Number.isSafeInteger(size) && size >= 0 && size <= MAX_RESOURCE_BYTES && Number.isFinite(saved) && saved > 0) {
              records.set(key.url, { url: key.url, size, saved });
            } else await cacheOperation(() => disk.delete(key));
          }
        }
        inventory = records;
        if (!protectedVendor) {
          const versions = [...new Set([...records.keys()].map(vendorVersion).filter((value): value is string => value !== null))];
          versions.sort((left, right) => {
            const a = left.split(".").map(Number), b = right.split(".").map(Number);
            return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
          });
          protectedVendor = versions[0] ?? null;
        }
        const protectedEntries = [...records.values()].filter(item => vendorVersion(item.url) === protectedVendor);
        if (protectedEntries.length > maxEntries || protectedEntries.reduce((sum, item) => sum + item.size, 0) > maxBytes) protectedVendor = null;
        await trim();
        inventoryChanged();
        update({ storage: "device" });
        try { if (await storageDeadline(async () => platformStorage()?.persisted())) update({ persistence: "granted" }); } catch { /* Optional API. */ }
      } catch { cache = null; unavailable("unavailable"); }
      await refreshEstimate();
    })();
    return initialization;
  }
  async function trim(incomingBytes = 0, incomingEntries = 0) {
    let bytes = [...inventory.values()].reduce((sum, item) => sum + item.size, 0);
    for (const item of [...inventory.values()].sort((a, b) => a.saved - b.saved)) {
      if (bytes + incomingBytes <= maxBytes && inventory.size + incomingEntries <= maxEntries) break;
      if (protectedVendor && vendorVersion(item.url) === protectedVendor) continue;
      if (!cache) return false;
      const disk = cache;
      await cacheOperation(() => disk.delete(item.url));
      inventory.delete(item.url);
      bytes -= item.size;
    }
    return bytes + incomingBytes <= maxBytes && inventory.size + incomingEntries <= maxEntries;
  }
  function remember(url: string, resource: StoredResource) {
    memoryBytes -= session.get(url)?.bytes.byteLength ?? 0;
    session.delete(url);
    session.set(url, resource);
    memoryBytes += resource.bytes.byteLength;
    const memoryLimit = Math.min(maxBytes, 32 * 1024 * 1024);
    while (memoryBytes > memoryLimit || session.size > Math.min(maxEntries, 128)) {
      const oldest = session.keys().next().value as string | undefined;
      if (!oldest) break;
      memoryBytes -= session.get(oldest)!.bytes.byteLength;
      session.delete(oldest);
    }
  }
  async function invalidate(value: string) {
    const url = originalUrl(value);
    // A failed physical deletion must not make the poisoned entry readable again.
    invalidated.add(url);
    memoryBytes -= session.get(url)?.bytes.byteLength ?? 0;
    session.delete(url);
    await initialize();
    await serialize(async () => {
      try { if (cache) { const disk = cache; await cacheOperation(() => disk.delete(url)); } }
      catch (error) { if (!(error instanceof StorageTimeoutError)) unavailable("write-failed"); }
      inventory.delete(url);
      inventoryChanged();
    });
  }
  function validate(resource: StoredResource, url: string, type: EarthResourceType) {
    const bytes = new Uint8Array(resource.bytes);
    if (bytes.length > MAX_RESOURCE_BYTES) throw new Error("Map resource exceeds the size limit");
    const pathname = new URL(url).pathname;
    if (type === "json" || pathname.endsWith(".json")) {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (!data || typeof data !== "object") throw new Error("Invalid map JSON");
      if (new URL(url).hostname === "tiles.openfreemap.org") {
        if (pathname.startsWith("/styles/") && (data.version !== 8 || !data.sources || typeof data.sources !== "object" || Array.isArray(data.sources) || !Array.isArray(data.layers))) throw new Error("Invalid map style");
        if (/^\/planet\/?$/.test(pathname) && (!Array.isArray(data.tiles) || !data.tiles.length || data.tiles.some((tile: unknown) => typeof tile !== "string"))) throw new Error("Invalid map tile index");
      }
    } else if (pathname.endsWith(".png")) {
      if (bytes.length < 8 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)) throw new Error("Invalid map image");
    } else if (resource.contentType.includes("text/html")) throw new Error("Unexpected map HTML response");
    // Empty protobuf messages are legal for tiles without features.
    if (pathname.endsWith(".pbf")) {
      let offset = 0;
      function varint() {
        let value = 0;
        for (let shift = 0; shift < 70; shift += 7) {
          if (offset >= bytes.length) throw new Error("Truncated map protobuf");
          const byte = bytes[offset++];
          value += (byte & 127) * 2 ** shift;
          if (!(byte & 128)) return value;
        }
        throw new Error("Invalid map protobuf");
      }
      while (offset < bytes.length) {
        const tag = varint();
        if (tag < 8) throw new Error("Invalid map protobuf field");
        switch (tag % 8) {
          case 0: varint(); break;
          case 1: offset += 8; break;
          case 2: { const length = varint(); offset += length; break; }
          case 5: offset += 4; break;
          default: throw new Error("Unsupported map protobuf field");
        }
        if (!Number.isSafeInteger(offset) || offset > bytes.length) throw new Error("Truncated map protobuf");
      }
    }
  }
  async function stored(url: string, type: EarthResourceType): Promise<StoredResource | null> {
    const memory = session.get(url);
    if (memory) { remember(url, memory); return memory; }
    if (invalidated.has(url)) return null;
    if (!cache) return null;
    try {
      const disk = cache;
      const response = await cacheOperation(() => disk.match(url));
      if (!response) return null;
      const resource = { bytes: await cacheOperation(() => response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "", cacheControl: response.headers.get("cache-control"), expires: response.headers.get("expires"), savedAt: Number(response.headers.get(SAVED)) };
      if (!response.ok || response.headers.get(MARKER) !== EARTH_CACHE_NAME || Number(response.headers.get(SIZE)) !== resource.bytes.byteLength) throw new Error("Damaged map cache");
      validate(resource, url, type);
      remember(url, resource);
      return resource;
    } catch {
      invalidated.add(url);
      await serialize(async () => {
        try { if (cache) { const disk = cache; await cacheOperation(() => disk.delete(url)); } }
        catch (error) { if (!(error instanceof StorageTimeoutError)) unavailable("write-failed"); }
        inventory.delete(url);
        inventoryChanged();
      });
      return null;
    }
  }
  async function save(url: string, resource: StoredResource) {
    if (resource.cacheControl && /\bno-store\b/i.test(resource.cacheControl)) return;
    remember(url, resource);
    if (!writable || !cache) return;
    if (resource.bytes.byteLength > maxBytes) {
      update({ storageIssue: "resource-too-large" }); remember(url, resource); return;
    }
    await serialize(async () => {
      if (!writable || !cache) { remember(url, resource); return; }
      try {
        const disk = cache;
        const previous = inventory.get(url);
        if (previous) { await cacheOperation(() => disk.delete(url)); inventory.delete(url); }
        const room = await trim(resource.bytes.byteLength, 1);
        if (!writable || cache !== disk) return;
        if (!room) {
          update({ storageIssue: "resource-too-large" });
          remember(url, resource);
          inventoryChanged();
          return;
        }
        const saved = resource.savedAt;
        const headers = new Headers({ [MARKER]: EARTH_CACHE_NAME, [SIZE]: String(resource.bytes.byteLength), [SAVED]: String(saved), "content-type": resource.contentType });
        if (resource.cacheControl) headers.set("cache-control", resource.cacheControl);
        if (resource.expires) headers.set("expires", resource.expires);
        await cacheOperation(() => disk.put(url, new Response(resource.bytes.slice(0), { headers })));
        if (!writable || cache !== disk) return;
        invalidated.delete(url);
        inventory.set(url, { url, size: resource.bytes.byteLength, saved });
      } catch (error) {
        if (!(error instanceof StorageTimeoutError)) unavailable(error instanceof Error && error.name === "QuotaExceededError" ? "quota" : "write-failed");
        remember(url, resource);
      }
      inventoryChanged();
    });
  }
  async function slot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw abortError();
    const waited = running >= concurrency;
    function release() {
      const next = queue.shift();
      if (next) next();
      else running -= 1;
    }
    if (waited) await new Promise<void>((resolve, reject) => {
      function ready() { signal.removeEventListener("abort", aborted); resolve(); }
      function aborted() { const index = queue.indexOf(ready); if (index >= 0) queue.splice(index, 1); reject(abortError()); }
      queue.push(ready);
      signal.addEventListener("abort", aborted, { once: true });
    });
    if (signal.aborted) { if (waited) release(); throw abortError(); }
    if (!waited) running += 1;
    return release;
  }
  async function download(url: string, type: EarthResourceType, signal: AbortSignal, revalidate = false): Promise<StoredResource> {
    const attemptLimit = revalidate ? 1 : attempts;
    const deadlineMs = revalidate ? Math.min(timeoutMs, 5000) : timeoutMs;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      // A timed-out tile rejoins the queue, so its retry cannot hold a network
      // slot while all the newly visible tiles wait behind it.
      const release = await slot(signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal.aborted) throw abortError();
        signal.addEventListener("abort", abort, { once: true });
        return await Promise.race([
          (async () => {
            const response = await fetcher(url, { signal: controller.signal, mode: "cors", credentials: "omit", cache: revalidate ? "no-cache" : "default" });
            if (!response.ok || response.type === "opaque" || response.type === "opaqueredirect") throw new Error(`Map resource HTTP ${response.status}`);
            if (response.url) originalUrl(response.url);
            if (Number(response.headers.get("content-length")) > MAX_RESOURCE_BYTES) throw new Error("Map resource exceeds the size limit");
            const resource = { bytes: await response.arrayBuffer(), contentType: response.headers.get("content-type") ?? "", cacheControl: response.headers.get("cache-control"), expires: response.headers.get("expires"), savedAt: Date.now() };
            if (controller.signal.aborted) throw signal.aborted ? abortError() : new Error("Map request timed out");
            update({ networkBytes: snapshot.networkBytes + resource.bytes.byteLength });
            validate(resource, url, type);
            return resource;
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("Map request timed out")); }, deadlineMs);
            controller.signal.addEventListener("abort", () => reject(signal.aborted ? abortError() : new Error("Map request timed out")), { once: true });
          }),
        ]);
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (attempt + 1 === attemptLimit) throw isAbort(error) ? new Error("Map request interrupted") : error;
      }
      finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); release(); }
    }
    throw new Error("Map request failed");
  }
  async function load(url: string, type: EarthResourceType, signal: AbortSignal) {
    await initialize();
    if (signal.aborted) throw abortError();
    const found = await stored(url, type);
    if (signal.aborted) throw abortError();
    const parsed = new URL(url);
    const mutable = parsed.hostname === "tiles.openfreemap.org" && (parsed.pathname.startsWith("/styles/") || /^\/planet\/?$/.test(parsed.pathname));
    const stale = found && mutable && Date.now() - found.savedAt >= mutableMaxAgeMs;
    if (found && !stale) { update({ cacheHits: snapshot.cacheHits + 1 }); return found; }
    let resource: StoredResource;
    try { resource = await download(url, type, signal, Boolean(stale)); }
    catch (error) {
      if (signal.aborted) throw abortError();
      // A usable saved index is more useful offline than a failed refresh.
      if (found) { update({ cacheHits: snapshot.cacheHits + 1 }); return found; }
      throw error;
    }
    if (signal.aborted) throw abortError();
    // Bound the queue wait too: many individually slow writes must not freeze
    // decoded tiles behind disk work. The validated session copy already exists.
    try { await cacheOperation(() => save(url, resource)); }
    catch (error) { if (!(error instanceof StorageTimeoutError)) throw error; }
    if (signal.aborted) throw abortError();
    return resource;
  }
  async function readResource(value: string, type: EarthResourceType = "arrayBuffer", signal?: AbortSignal) {
    const url = originalUrl(value);
    if (signal?.aborted) throw abortError();
    const version = vendorVersion(url);
    if (version) protectedVendor = version;
    let entry = inFlight.get(url);
    if (!entry) {
      const controller = new AbortController();
      update({ pending: snapshot.pending + 1 });
      entry = { controller, consumers: 0, promise: Promise.resolve(null as unknown as StoredResource) };
      const current = entry;
      current.promise = load(url, type, controller.signal).then(resource => {
        update({ completed: snapshot.completed + 1 }); return resource;
      }, error => { if (!controller.signal.aborted && !isAbort(error)) update({ failed: snapshot.failed + 1 }); throw error; }).finally(() => {
        if (inFlight.get(url) === current) inFlight.delete(url);
        update({ pending: snapshot.pending - 1 });
      });
      inFlight.set(url, current);
    }
    entry.consumers += 1;
    const current = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.consumers -= 1;
      if (!current.consumers && inFlight.get(url) === current) { inFlight.delete(url); current.controller.abort(); }
    };
    let abort: (() => void) | undefined;
    try {
      const resource = await (signal ? Promise.race([current.promise, new Promise<never>((_, reject) => {
        abort = () => { release(); reject(abortError()); };
        signal.addEventListener("abort", abort, { once: true });
        // A progress subscriber can synchronously cancel while a job is created.
        if (signal.aborted) abort();
      })]) : current.promise);
      if (signal?.aborted) throw abortError();
      const data = type === "json" ? JSON.parse(new TextDecoder().decode(resource.bytes)) : type === "string" ? new TextDecoder().decode(resource.bytes) : resource.bytes.slice(0);
      return { data, cacheControl: resource.cacheControl, expires: resource.expires };
    } finally { if (abort) signal?.removeEventListener("abort", abort); release(); }
  }
  const protocol: AddProtocolAction = (parameters, controller) => readResource(parameters.url, parameters.type ?? "arrayBuffer", controller.signal);
  async function requestPersistence() {
    // Call directly from a user's action; browsers decide whether to grant it.
    try { update({ persistence: await storageDeadline(async () => platformStorage()?.persist()) ? "granted" : "best-effort" }); }
    catch { update({ persistence: "best-effort" }); }
    await initialize();
    await refreshEstimate();
  }
  return {
    initialize, readResource, protocol, transformRequest, invalidate, requestPersistence,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    resetProgress() { update({ completed: 0, failed: 0, cacheHits: 0, networkBytes: 0 }); },
  };
}

export const earthResourceCache = createEarthResourceCache();
