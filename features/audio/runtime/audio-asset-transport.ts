/** Encoded public audio survives reloads; decoded buffers stay in the runtime's bounded cache. */
export const AUDIO_ASSET_CACHE_NAME = "zhiv-audio-assets-v1";
export const DEFAULT_AUDIO_STORAGE_BUDGET = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 6 * 1024 * 1024;
const SIZE_HEADER = "x-zhiv-audio-bytes";
const STORAGE_DEADLINE_MS = 200;
const MAX_PENDING_WRITE_BYTES = 12 * 1024 * 1024;
const MAX_PENDING_WRITES = 4;
type SharedRequest = { controller: AbortController; promise: Promise<Response>; consumers: number; release: () => void };

function abortError() { return new DOMException("Audio request cancelled", "AbortError"); }

function publicAudioKey(input: RequestInfo | URL, init?: RequestInit) {
  // Do not coalesce authenticated Requests, range streams or arbitrary external URLs.
  if (typeof input !== "string" || !input.startsWith("/audio/") || input.startsWith("//")
    || (init?.method ?? "GET").toUpperCase() !== "GET" || init?.body
    || init?.credentials === "include" || init?.cache === "no-store" || init?.cache === "reload") return null;
  const headers = new Headers(init?.headers);
  if ([...headers.keys()].some(name => name !== "accept")) return null;
  const url = new URL(input, "https://local.invalid");
  if (url.origin !== "https://local.invalid" || !url.pathname.startsWith("/audio/")
    || !/\.(?:wav|mp3|ogg|opus|m4a|aac|webm|flac)$/i.test(url.pathname)
    || [...url.searchParams.keys()].some(key => !["v", "ver", "version", "hash"].includes(key))) return null;
  return `${url.pathname}${url.search}`;
}

function storable(response: Response) {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return response.status === 200 && response.type !== "opaque" && response.type !== "opaqueredirect"
    && !response.headers.has("content-range") && !response.headers.has("set-cookie")
    && !/(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get("cache-control") ?? "")
    && !/\*|authorization|cookie/i.test(response.headers.get("vary") ?? "")
    && (type.startsWith("audio/") || type === "application/octet-stream");
}

async function boundedBytes(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); return null; }
    while (true) {
      const part = await reader.read();
      if (signal.aborted) return null;
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(part.value);
    }
    if (!length) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

export function createAudioAssetTransport(options: {
  fetchAsset: typeof fetch; cacheStorage?: CacheStorage; maxStoredBytes?: number; maxEntries?: number;
}) {
  const budget = Math.max(0, options.maxStoredBytes ?? DEFAULT_AUDIO_STORAGE_BUDGET);
  const entryLimit = Math.min(MAX_ENTRY_BYTES, budget);
  const entryCount = Math.max(0, Math.floor(options.maxEntries ?? 64));
  const pending = new Map<string, SharedRequest>();
  const active = new Set<SharedRequest>();
  const writes = new Set<Promise<void>>();
  let pendingWriteBytes = 0;
  let disposed = false;
  let storageAvailable = true;
  let storage: Promise<Cache | null> | undefined;
  let storageQueue = Promise.resolve();

  function optionalStorage<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    if (disposed || !storageAvailable) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const timer = setTimeout(() => { storageAvailable = false; resolve(fallback); }, STORAGE_DEADLINE_MS);
      void Promise.resolve().then(() => disposed || !storageAvailable ? fallback : operation()).then(value => { clearTimeout(timer); resolve(value); }, () => {
        clearTimeout(timer); storageAvailable = false; resolve(fallback);
      });
    });
  }

  function openStorage() {
    storage ??= (async () => {
      if (!options.cacheStorage || !budget || !entryCount || disposed || !storageAvailable) return null;
      return optionalStorage(() => options.cacheStorage!.open(AUDIO_ASSET_CACHE_NAME), null);
    })();
    return storage;
  }

  async function readStored(key: string) {
    try {
      const cache = await openStorage();
      if (disposed || !storageAvailable) return null;
      const response = await cache?.match(key);
      if (disposed || !storageAvailable) return null;
      if (!response) return null;
      const size = Number(response.headers.get(SIZE_HEADER));
      if (!storable(response) || !Number.isFinite(size) || size <= 0 || size > entryLimit) {
        await cache?.delete(key);
        return null;
      }
      return response;
    } catch { return null; }
  }

  async function storeResponse(key: string, response: Response, signal: AbortSignal) {
    if (disposed || !storageAvailable || signal.aborted || !options.cacheStorage || !entryLimit || !entryCount || !storable(response)) return;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > entryLimit) return;
    try {
      const bytes = await boundedBytes(response.clone(), entryLimit, signal);
      if (!bytes || disposed || !storageAvailable || signal.aborted) return;
      // Reject truncated downloads. Content-Encoding changes the relation between
      // transferred length and bytes returned by fetch, so only compare identity.
      if (declared > 0 && !response.headers.has("content-encoding") && declared !== bytes.byteLength) return;
      const headers = new Headers(response.headers);
      headers.set(SIZE_HEADER, String(bytes.byteLength));
      headers.delete("content-encoding");
      headers.set("content-length", String(bytes.byteLength));
      const stored = new Response(bytes, { status: 200, headers });
      const operation = storageQueue.then(() => optionalStorage(async () => {
        if (disposed || !storageAvailable || signal.aborted) return;
        const cache = await openStorage();
        if (!cache || disposed || !storageAvailable || signal.aborted) return;
        await cache.delete(key);
        if (disposed || !storageAvailable || signal.aborted) return;
        const entries: { key: Request; bytes: number }[] = [];
        let total = 0;
        for (const request of await cache.keys()) {
          if (disposed || !storageAvailable || signal.aborted) return;
          const previous = await cache.match(request);
          if (disposed || !storageAvailable || signal.aborted) return;
          const size = Number(previous?.headers.get(SIZE_HEADER));
          if (!previous || !storable(previous) || !Number.isFinite(size) || size <= 0 || size > entryLimit) {
            await cache.delete(request);
          } else { entries.push({ key: request, bytes: size }); total += size; }
        }
        // Cache.keys preserves insertion order; evict oldest complete entries.
        while (entries.length && (total + bytes.byteLength > budget || entries.length >= entryCount)) {
          if (disposed || !storageAvailable || signal.aborted) return;
          const oldest = entries.shift()!;
          await cache.delete(oldest.key); total -= oldest.bytes;
        }
        if (!disposed && storageAvailable && !signal.aborted) await cache.put(key, stored);
      }, undefined));
      storageQueue = operation.catch(() => undefined);
      await storageQueue;
    } catch { /* CacheStorage/quota/body failures must not interrupt playback. */ }
  }

  async function acquire(key: string, init: RequestInit | undefined, signal: AbortSignal) {
    const cached = await optionalStorage(() => readStored(key), null);
    if (disposed || signal.aborted) throw abortError();
    if (cached) return cached;
    const response = await options.fetchAsset(key, { ...init, signal });
    if (disposed || signal.aborted) throw abortError();
    // Persistence is optional: audio may consume the network response immediately,
    // even if an IndexedDB-backed cache is slow or blocked in another tab.
    const declared = Number(response.headers.get("content-length"));
    const reservation = declared > 0 && Number.isFinite(declared) ? Math.min(declared, entryLimit) : entryLimit;
    if (writes.size < MAX_PENDING_WRITES && pendingWriteBytes + reservation <= MAX_PENDING_WRITE_BYTES) {
      pendingWriteBytes += reservation;
      const write = storeResponse(key, response, signal);
      writes.add(write);
      const release = () => { writes.delete(write); pendingWriteBytes -= reservation; };
      void write.then(release, release);
    }
    return response;
  }

  function subscribe(entry: SharedRequest, signal?: AbortSignal | null) {
    entry.consumers++;
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      let delivered = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let output: ReadableStreamDefaultController<Uint8Array> | undefined;
      const finish = (aborted = false) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", cancel);
        entry.controller.signal.removeEventListener("abort", cancel);
        entry.consumers--;
        if (!aborted) entry.release();
        if (!entry.consumers) {
          active.delete(entry);
          if (aborted) { entry.release(); entry.controller.abort(); }
        }
      };
      const cancel = () => {
        if (done) return;
        const error = abortError();
        if (delivered) { output?.error(error); void reader?.cancel(error).catch(() => undefined); }
        else reject(error);
        finish(true);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      entry.controller.signal.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted || entry.controller.signal.aborted) { cancel(); return; }
      entry.promise.then(response => {
        if (done) return;
        try {
          const clone = response.clone();
          if (!clone.body) { finish(); resolve(clone); return; }
          reader = clone.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            start(controller) { output = controller; },
            async pull(controller) {
              try {
                const part = await reader!.read();
                if (done) return;
                if (part.done) { finish(); controller.close(); }
                else controller.enqueue(part.value);
              } catch (error) { if (!done) { finish(); controller.error(error); } }
            },
            cancel(reason) { finish(true); void reader?.cancel(reason).catch(() => undefined); },
          });
          delivered = true;
          resolve(new Response(body, { status: clone.status, statusText: clone.statusText, headers: clone.headers }));
        } catch (error) { finish(true); reject(error); }
      }, error => { if (!done) { finish(); reject(error); } });
    });
  }

  const fetchAudio: typeof fetch = (input, init) => {
    if (disposed || init?.signal?.aborted) return Promise.reject(abortError());
    const key = publicAudioKey(input, init);
    if (!key) return options.fetchAsset(input, init);
    let entry = pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      let original: Response | undefined;
      let released = false;
      const release = () => {
        released = true;
        if (pending.get(key) === current) pending.delete(key);
        void original?.body?.cancel().catch(() => undefined);
        original = undefined;
      };
      entry = { controller, consumers: 0, promise: Promise.resolve().then(() => acquire(key, init, controller.signal)), release };
      const current = entry;
      pending.set(key, current);
      active.add(current);
      // Both handlers consume failures without creating an unhandled rejected finally promise.
      void current.promise.then(response => {
        // Keep a cloneable source only while its body is in flight, so enabling
        // sound during an encoded prefetch reuses that download too. The first
        // completed reader releases this branch; completed files live in storage.
        original = response;
        if (released) release();
      }, release);
    }
    return subscribe(entry, init?.signal);
  };

  return {
    fetch: fetchAudio,
    pendingCount: () => pending.size,
    flushStorage: async () => { await Promise.all([...writes]); },
    dispose() {
      disposed = true;
      for (const entry of active) entry.controller.abort();
      active.clear();
      pending.clear();
    },
  };
}
