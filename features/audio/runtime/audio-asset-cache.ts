import type { AudioAsset } from "@/features/audio/domain/types";

export const DEFAULT_AUDIO_BUFFER_BUDGET = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
const RETRY_AFTER_MS = 30_000;

type CachedBuffer = { buffer: AudioBuffer; bytes: number; touchedAt: number };
type PendingBuffer = { promise: Promise<AudioBuffer | null>; controller: AbortController; timer: ReturnType<typeof setTimeout> };
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
  let bytes = 0;
  let disposed = false;

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

  async function decode(asset: AudioAsset, signal: AbortSignal): Promise<AudioBuffer | null> {
    for (const url of [...new Set([asset.src, asset.fallbackSrc].filter((value): value is string => Boolean(value)))]) {
      try {
        const response = await options.fetchAsset(url, { signal, credentials: "same-origin" });
        if (!response.ok) throw new Error("Audio download failed");
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_BYTES) throw new Error("Audio file exceeds download budget");
        const data = await response.arrayBuffer();
        if (disposed || signal.aborted) return null;
        if (data.byteLength > MAX_COMPRESSED_BYTES) throw new Error("Audio file exceeds download budget");
        const context = options.context();
        if (!context || context.state === "closed") return null;
        const buffer = await context.decodeAudioData(data);
        if (disposed || signal.aborted) return null;
        const size = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (!Number.isFinite(size) || size > budget || !makeRoom(size)) throw new Error("Decoded audio exceeds memory budget");
        loaded.set(asset.id, { buffer, bytes: size, touchedAt: options.now() });
        bytes += size;
        failures.delete(asset.id);
        return buffer;
      } catch {
        if (disposed || signal.aborted) return null;
      }
    }
    if (!disposed) failures.set(asset.id, options.now());
    return null;
  }

  return {
    load(asset: AudioAsset): Promise<AudioBuffer | null> {
      if (disposed || asset.status !== "ready" || !asset.src) return Promise.resolve(null);
      const cached = loaded.get(asset.id);
      if (cached) { cached.touchedAt = options.now(); return Promise.resolve(cached.buffer); }
      const existing = pending.get(asset.id);
      if (existing) return existing.promise;
      const failedAt = failures.get(asset.id);
      if (failedAt !== undefined && options.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<null>(resolve => {
        controller.signal.addEventListener("abort", () => resolve(null), { once: true });
        timer = setTimeout(() => {
          if (!disposed) failures.set(asset.id, options.now());
          controller.abort();
        }, 12_000);
      });
      // decodeAudioData cannot be cancelled; the race releases waiters at the deadline,
      // and decode() checks the signal before it can retain a late result.
      const promise = Promise.race([Promise.resolve().then(() => decode(asset, controller.signal)), deadline]).finally(() => {
        clearTimeout(timer); pending.delete(asset.id);
        if (!disposed) options.changed();
      });
      pending.set(asset.id, { controller, promise, timer: timer! });
      options.changed();
      return promise;
    },
    loadedCount: () => loaded.size,
    loadingCount: () => pending.size,
    failedIds: () => [...failures.keys()],
    dispose() {
      disposed = true;
      for (const { controller, timer } of pending.values()) { clearTimeout(timer); controller.abort(); }
      pending.clear(); loaded.clear(); failures.clear(); bytes = 0;
    },
  };
}
