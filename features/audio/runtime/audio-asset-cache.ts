import type { AudioAsset } from "@/features/audio/domain/types";

export const DEFAULT_AUDIO_BUFFER_BUDGET = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
const RETRY_AFTER_MS = 30_000;

type CachedBuffer = { buffer: AudioBuffer; bytes: number; touchedAt: number };
type PendingBuffer = {
  asset: AudioAsset; promise: Promise<AudioBuffer | null>; resolve: (buffer: AudioBuffer | null) => void;
  controller: AbortController; priority: number; timer?: ReturnType<typeof setTimeout>;
};
type DecodeWaiter = { entry: PendingBuffer; ready: () => void; cancel: () => void };
export type AudioAssetCache = ReturnType<typeof createAudioAssetCache>;

/** Only short effects use decoded memory. Music is streamed by the runtime. */
export function createAudioAssetCache(options: {
  context: () => AudioContext | null;
  fetchAsset: typeof fetch;
  now: () => number;
  changed: () => void;
  isInUse: (assetId: string) => boolean;
  maxDecodedBytes?: number;
}) {
  const budget = options.maxDecodedBytes ?? DEFAULT_AUDIO_BUFFER_BUDGET;
  const loaded = new Map<string, CachedBuffer>();
  const pending = new Map<string, PendingBuffer>();
  const failures = new Map<string, number>();
  const queue: PendingBuffer[] = [];
  const decodeQueue: DecodeWaiter[] = [];
  let bytes = 0;
  let disposed = false;
  let working = 0;
  let decoding = false;

  function makeRoom(required: number) {
    const candidates = [...loaded.entries()].filter(([id]) => !options.isInUse(id))
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [id, cached] of candidates) {
      if (bytes + required <= budget) break;
      loaded.delete(id);
      bytes -= cached.bytes;
    }
    return bytes + required <= budget;
  }

  function startDeadline(entry: PendingBuffer) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!disposed) failures.set(entry.asset.id, options.now());
      entry.controller.abort();
      entry.resolve(null);
      if (!disposed) options.changed();
    }, 12_000);
  }

  function drainDecoders() {
    if (disposed || decoding) return;
    decodeQueue.sort((a, b) => b.entry.priority - a.entry.priority);
    decodeQueue.shift()?.ready();
  }

  function acquireDecoder(entry: PendingBuffer): Promise<(() => void) | null> {
    return new Promise(resolve => {
      const signal = entry.controller.signal;
      const waiter: DecodeWaiter = {
        entry,
        ready() {
          signal.removeEventListener("abort", waiter.cancel);
          if (disposed || signal.aborted) { resolve(null); drainDecoders(); return; }
          decoding = true;
          resolve(() => { decoding = false; drainDecoders(); });
        },
        cancel() {
          const index = decodeQueue.indexOf(waiter);
          if (index >= 0) decodeQueue.splice(index, 1);
          resolve(null);
        },
      };
      if (disposed || signal.aborted) { resolve(null); return; }
      signal.addEventListener("abort", waiter.cancel, { once: true });
      decodeQueue.push(waiter);
      drainDecoders();
    });
  }

  async function decode(entry: PendingBuffer): Promise<AudioBuffer | null> {
    const { asset, controller: { signal } } = entry;
    for (const url of [...new Set([asset.src, asset.fallbackSrc].filter((value): value is string => Boolean(value)))]) {
      let response: Response | undefined;
      try {
        startDeadline(entry);
        response = await options.fetchAsset(url, { signal, credentials: "same-origin" });
        if (!response.ok) throw new Error("Audio download failed");
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_BYTES) throw new Error("Audio file exceeds download budget");
        const data = await response.arrayBuffer();
        clearTimeout(entry.timer);
        if (disposed || signal.aborted) return null;
        if (data.byteLength > MAX_COMPRESSED_BYTES) throw new Error("Audio file exceeds download budget");
        const context = options.context();
        if (!context || context.state === "closed") return null;
        let buffer: AudioBuffer;
        // The prepared-byte queue is bounded by the two acquisition workers.
        // Waiting for the native decoder consumes neither network nor decode timeout.
        const release = await acquireDecoder(entry);
        if (!release) return null;
        try {
          if (disposed || signal.aborted) return null;
          startDeadline(entry);
          buffer = await context.decodeAudioData(data);
        } finally { clearTimeout(entry.timer); release(); }
        if (disposed || signal.aborted) return null;
        const size = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (!Number.isFinite(size) || size > budget || !makeRoom(size)) throw new Error("Decoded audio exceeds memory budget");
        loaded.set(asset.id, { buffer, bytes: size, touchedAt: options.now() });
        bytes += size;
        failures.delete(asset.id);
        return buffer;
      } catch {
        if (disposed || signal.aborted) return null;
      } finally {
        clearTimeout(entry.timer);
        // Rejected headers leave their body unread. Release this consumer before
        // fallback/retry so the transport cannot keep a failed shared response.
        if (response && !response.bodyUsed) void response.body?.cancel().catch(() => undefined);
      }
    }
    if (!disposed) failures.set(asset.id, options.now());
    return null;
  }

  function drain() {
    while (!disposed && working < 2 && queue.length) {
      queue.sort((a, b) => b.priority - a.priority);
      const entry = queue.shift()!;
      working++;
      void decode(entry).then(buffer => {
        clearTimeout(entry.timer);
        // This runs after native decoding really settles, never at its deadline.
        entry.controller.abort();
        if (pending.get(entry.asset.id) === entry) pending.delete(entry.asset.id);
        entry.resolve(buffer);
        working--;
        if (!disposed) options.changed();
        drain();
      });
    }
  }

  return {
    load(asset: AudioAsset, priority = 0): Promise<AudioBuffer | null> {
      if (disposed || asset.status !== "ready" || !asset.src) return Promise.resolve(null);
      const cached = loaded.get(asset.id);
      if (cached) { cached.touchedAt = options.now(); return Promise.resolve(cached.buffer); }
      const existing = pending.get(asset.id);
      if (existing) { existing.priority = Math.max(existing.priority, Number.isFinite(priority) ? priority : 0); return existing.promise; }
      const failedAt = failures.get(asset.id);
      if (failedAt !== undefined && options.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
      const controller = new AbortController();
      let resolve!: PendingBuffer["resolve"];
      const promise = new Promise<AudioBuffer | null>(done => { resolve = done; });
      const entry = { asset, controller, promise, resolve, priority: Number.isFinite(priority) ? priority : 0 };
      pending.set(asset.id, entry);
      queue.push(entry);
      options.changed();
      drain();
      return promise;
    },
    loadedCount: () => loaded.size,
    loadingCount: () => pending.size,
    decodingCount: () => Number(decoding),
    queuedDecodeCount: () => queue.length + decodeQueue.length,
    failedIds: () => [...failures.keys()],
    dispose() {
      disposed = true;
      for (const { controller, timer, resolve } of pending.values()) { clearTimeout(timer); controller.abort(); resolve(null); }
      queue.length = 0;
      pending.clear(); loaded.clear(); failures.clear(); bytes = 0;
    },
  };
}
