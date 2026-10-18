export type EarthModelLod = "overview" | "detail";
export type EarthModelAsset = { url: string; bytes: number; sha256: string; vertexCount: number; indexCount: number };
export type EarthModelAssets = { version: number; overview: EarthModelAsset; detail: EarthModelAsset };
export type EarthIndexedModel = { vertices: Float32Array; indices: Uint32Array; bytes: number };
export type EarthModelStatus = "idle" | "loading" | "ready" | "error";
export const EARTH_MODEL_MAX_BYTES = 4 * 1024 * 1024;
export const EARTH_MODEL_MAX_VERTICES = 100_000;
export const EARTH_MODEL_MAX_INDICES = 180_000;
const HEADER_BYTES = 16;
const DEADLINE_MS = 8_000;
const LODS: readonly EarthModelLod[] = ["overview", "detail"];

/** Only our two prepared, self-contained meshes are accepted; this is not a GLB loader. */
export function validateEarthModelAssets(value: EarthModelAssets): EarthModelAssets {
  if (value.version !== 1) throw new Error("Unsupported Earth model manifest");
  for (const lod of LODS) {
    const asset = value[lod];
    if (!asset || asset.url !== `/earth/models/eiffel-tower/${lod}.elm` || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isInteger(asset.vertexCount) || asset.vertexCount < 3 || asset.vertexCount > EARTH_MODEL_MAX_VERTICES
      || !Number.isInteger(asset.indexCount) || asset.indexCount < 3 || asset.indexCount % 3 !== 0 || asset.indexCount > EARTH_MODEL_MAX_INDICES
      || !Number.isInteger(asset.bytes) || asset.bytes !== HEADER_BYTES + asset.vertexCount * 24 + asset.indexCount * 4
      || asset.bytes > EARTH_MODEL_MAX_BYTES) throw new Error("Invalid Earth model manifest");
  }
  return value;
}

/** Validated views share one bounded ArrayBuffer; decoding makes no geometry copy. */
export function decodeEarthModel(buffer: ArrayBuffer, asset: EarthModelAsset): EarthIndexedModel {
  if (buffer.byteLength !== asset.bytes || buffer.byteLength < HEADER_BYTES || buffer.byteLength > EARTH_MODEL_MAX_BYTES) throw new Error("Invalid Earth model size");
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x314d4c45 || header.getUint32(4, true) !== 1
    || header.getUint32(8, true) !== asset.vertexCount || header.getUint32(12, true) !== asset.indexCount
    || asset.vertexCount < 3 || asset.vertexCount > EARTH_MODEL_MAX_VERTICES
    || asset.indexCount < 3 || asset.indexCount % 3 !== 0 || asset.indexCount > EARTH_MODEL_MAX_INDICES
    || HEADER_BYTES + asset.vertexCount * 24 + asset.indexCount * 4 !== buffer.byteLength) throw new Error("Invalid Earth model header");
  const vertices = new Float32Array(buffer, HEADER_BYTES, asset.vertexCount * 6);
  const indices = new Uint32Array(buffer, HEADER_BYTES + asset.vertexCount * 24, asset.indexCount);
  let minimumZ = Infinity, maximumZ = -Infinity;
  for (let offset = 0; offset < vertices.length; offset += 6) {
    for (let component = 0; component < 6; component++) {
      const value = vertices[offset + component];
      if (!Number.isFinite(value) || component < 2 && Math.abs(value) > 1.5
        || component === 2 && (value < -0.00001 || value > 1.00001)
        || component >= 3 && (value < 0 || value > 1)) throw new Error("Invalid Earth model vertex");
    }
    minimumZ = Math.min(minimumZ, vertices[offset + 2]); maximumZ = Math.max(maximumZ, vertices[offset + 2]);
  }
  if (Math.abs(minimumZ) > 0.00001 || Math.abs(maximumZ - 1) > 0.00001 || indices.some(index => index >= asset.vertexCount)) throw new Error("Invalid Earth model bounds");
  return { vertices, indices, bytes: buffer.byteLength };
}

export type EarthModelEnvironment = {
  fetch: typeof fetch;
  sha256: ((buffer: ArrayBuffer) => Promise<string>) | null;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
};
export function browserEarthModelEnvironment(view: Window | null = typeof window === "undefined" ? null : window): EarthModelEnvironment | null {
  if (!view || typeof view.fetch !== "function") return null;
  return {
    fetch: (url, init) => view.fetch(url, init),
    sha256: view.crypto?.subtle ? async buffer => {
      const digest = await view.crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    } : null,
    schedule: (callback, delay) => view.setTimeout(callback, delay), cancel: handle => view.clearTimeout(handle as number),
  };
}
type Flight = { lod: EarthModelLod; abort: AbortController; timer: unknown; reader: ReadableStreamDefaultReader<Uint8Array> | null };

/** One Eiffel object, two fixed LODs, one foreground request and no retry/background loop. */
export function createEarthModelLoader(assets: EarthModelAssets, onChange: () => void,
  environment: EarthModelEnvironment | null = browserEarthModelEnvironment()) {
  validateEarthModelAssets(assets);
  const models: Partial<Record<EarthModelLod, EarthIndexedModel>> = {};
  const status: Record<EarthModelLod, EarthModelStatus> = { overview: "idle", detail: "idle" };
  const failures: Record<EarthModelLod, number> = { overview: 0, detail: 0 };
  let desired: EarthModelLod | null = null, flight: Flight | null = null, disposed = false, fetchCount = 0;
  const current = (work: Flight) => !disposed && desired !== null && flight === work && !work.abort.signal.aborted;
  function cancelFlight() {
    const previous = flight;
    if (!previous) return;
    flight = null; previous.abort.abort(); environment?.cancel(previous.timer);
    void previous.reader?.cancel().catch(() => undefined);
    status[previous.lod] = models[previous.lod] ? "ready" : "idle";
  }
  async function load(work: Flight) {
    const asset = assets[work.lod];
    try {
      if (!current(work)) return;
      const response = await environment!.fetch(`${asset.url}?v=${asset.sha256}`, {
        signal: work.abort.signal, cache: "force-cache", credentials: "omit", redirect: "error",
      });
      if (!current(work)) { void response.body?.cancel().catch(() => undefined); return; }
      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      const encoded = !!encoding && encoding !== "identity";
      // Fetch exposes decoded body bytes while Content-Length may describe a
      // gzip/zstd transfer. The streamed decoded length below is authoritative.
      if (!response.ok || !response.body || length !== null && (!Number.isSafeInteger(Number(length))
        || Number(length) < 0 || Number(length) > EARTH_MODEL_MAX_BYTES || !encoded && Number(length) !== asset.bytes)) throw new Error("Earth model response rejected");
      const bytes = new Uint8Array(asset.bytes);
      const reader = response.body.getReader(); work.reader = reader;
      let offset = 0;
      while (true) {
        const result = await reader.read();
        if (!current(work)) return;
        if (result.done) break;
        if (offset + result.value.byteLength > bytes.byteLength) throw new Error("Earth model response exceeds budget");
        bytes.set(result.value, offset); offset += result.value.byteLength;
      }
      if (offset !== asset.bytes) throw new Error("Earth model response truncated");
      // On HTTP LAN without WebCrypto numeric/header bounds still apply. HTTPS
      // additionally verifies the versioned preparation digest before upload.
      if (environment!.sha256 && await environment!.sha256(bytes.buffer) !== asset.sha256) throw new Error("Earth model integrity mismatch");
      if (!current(work)) return;
      models[work.lod] = decodeEarthModel(bytes.buffer, asset); status[work.lod] = "ready";
    } catch {
      if (current(work)) { status[work.lod] = "error"; failures[work.lod]++; work.abort.abort(); }
    } finally {
      environment?.cancel(work.timer); void work.reader?.cancel().catch(() => undefined);
      if (flight === work) {
        flight = null;
        if (!disposed) { onChange(); pump(); }
      }
    }
  }
  function pump() {
    if (disposed || !environment || !desired || flight || models[desired] || status[desired] === "error" || failures[desired] >= 2) return;
    const work: Flight = { lod: desired, abort: new AbortController(), timer: null, reader: null };
    flight = work; status[work.lod] = "loading"; fetchCount++;
    work.timer = environment.schedule(() => {
      if (flight !== work) return;
      cancelFlight(); status[work.lod] = "error"; failures[work.lod]++; onChange();
    }, DEADLINE_MS);
    onChange(); void load(work);
  }
  return {
    request(lod: EarthModelLod | null) {
      if (disposed) return;
      if (desired === lod) { pump(); return; }
      desired = lod;
      if (lod === null) {
        cancelFlight();
        for (const level of LODS) if (status[level] === "error" && failures[level] < 2) status[level] = "idle";
      } else pump();
    },
    get(lod: EarthModelLod) { return models[lod] ?? null; },
    getSnapshot() { return { overview: status.overview, detail: status.detail, fetchCount,
      bytes: LODS.reduce((sum, lod) => sum + (models[lod]?.bytes ?? 0), 0) }; },
    dispose() { if (disposed) return; disposed = true; desired = null; cancelFlight(); delete models.overview; delete models.detail; },
  };
}
