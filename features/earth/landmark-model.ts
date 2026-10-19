import { decodeEarthModel, validateEarthModelAssets, EARTH_MODEL_MAX_BYTES, type EarthModelAssets, type EarthModelLod, type EarthIndexedModel, type EarthModelEncodedTexture } from "./landmark-model-format";
export { decodeEarthModel, validateEarthModelAssets, EARTH_MODEL_MAX_BYTES, EARTH_MODEL_MAX_VERTICES, EARTH_MODEL_MAX_INDICES } from "./landmark-model-format";
export type { EarthModelLod, EarthModelAsset, EarthModelAssets, EarthIndexedModel, EarthModelTexture, EarthModelTextureAsset, EarthModelEncodedTexture, EarthModelMaterial } from "./landmark-model-format";
export type EarthModelStatus = "idle" | "loading" | "ready" | "error";
const DEADLINE_MS = 8_000;
const LODS: readonly EarthModelLod[] = ["overview", "detail"];

export type EarthModelEnvironment = {
  fetch: typeof fetch;
  sha256: ((buffer: ArrayBuffer) => Promise<string>) | null;
  decodeTexture?: (texture: EarthModelEncodedTexture) => Promise<ImageBitmap>;
  acquire?: (signal: AbortSignal) => Promise<() => void>;
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
    decodeTexture: typeof view.createImageBitmap === "function" ? texture => view.createImageBitmap(
      new Blob([texture.bytes.slice().buffer as ArrayBuffer], { type: "image/webp" }),
      { imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" }) : undefined,
    schedule: (callback, delay) => view.setTimeout(callback, delay), cancel: handle => view.clearTimeout(handle as number),
  };
}
type Flight = { lod: EarthModelLod; abort: AbortController; timer: unknown; reader: ReadableStreamDefaultReader<Uint8Array> | null;
  images: ImageBitmap[]; permit: (() => void) | null };
const closeImages = (images: ImageBitmap[]) => { for (const image of images.splice(0)) image.close(); };
function releasePermit(work: Flight) { const permit = work.permit; work.permit = null; permit?.(); }
function releaseModel(model: EarthIndexedModel | undefined) {
  for (const texture of model?.textureMaterial?.textures ?? []) texture.image.close();
}

/** Two fixed LODs of one registered model, one foreground request and no background retry loop. */
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
    closeImages(previous.images);
    void previous.reader?.cancel().catch(() => undefined);
    status[previous.lod] = models[previous.lod] ? "ready" : "idle";
  }
  async function load(work: Flight) {
    const asset = assets[work.lod];
    try {
      if (environment?.acquire) work.permit = await environment.acquire(work.abort.signal);
      if (!current(work)) return;
      // Queueing behind another visible model does not consume the HTTP/image
      // deadline. A cancelled queue entry never starts a transfer.
      work.timer = environment!.schedule(() => {
        if (flight !== work) return;
        cancelFlight(); status[work.lod] = "error"; failures[work.lod]++; onChange();
      }, DEADLINE_MS);
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
      const model = decodeEarthModel(bytes.buffer, asset);
      if (model.encodedMaterial) {
        if (!environment!.decodeTexture) throw new Error("Earth texture decoding unavailable");
        const textures = [];
        for (const texture of model.encodedMaterial.textures) {
          const image = await environment!.decodeTexture(texture);
          if (!current(work)) { image.close(); return; }
          work.images.push(image);
          if (image.width !== texture.width || image.height !== texture.height) throw new Error("Earth texture dimensions mismatch");
          textures.push({ kind: texture.kind, width: texture.width, height: texture.height, wrapS: texture.wrapS, wrapT: texture.wrapT, image });
          model.bytes += texture.width * texture.height * 4;
        }
        const { metallicFactor, roughnessFactor, normalScale } = model.encodedMaterial;
        model.textureMaterial = { metallicFactor, roughnessFactor, normalScale, textures };
        delete model.encodedMaterial;
      }
      if (!current(work)) return;
      releaseModel(models[work.lod]);
      models[work.lod] = model; work.images.length = 0; status[work.lod] = "ready";
    } catch {
      if (current(work)) { status[work.lod] = "error"; failures[work.lod]++; work.abort.abort(); }
    } finally {
      closeImages(work.images);
      environment?.cancel(work.timer); void work.reader?.cancel().catch(() => undefined);
      releasePermit(work);
      if (flight === work) {
        flight = null;
        if (!disposed) { onChange(); pump(); }
      }
    }
  }
  function pump() {
    if (disposed || !environment || !desired || flight || models[desired] || status[desired] === "error" || failures[desired] >= 2) return;
    const work: Flight = { lod: desired, abort: new AbortController(), timer: null, reader: null, images: [], permit: null };
    flight = work; status[work.lod] = "loading"; fetchCount++;
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
    release(lod?: EarthModelLod) {
      for (const level of lod ? [lod] : LODS) {
        if (flight?.lod === level) cancelFlight();
        releaseModel(models[level]); delete models[level];
        if (status[level] === "ready") status[level] = "idle";
      }
    },
    getSnapshot() { return { overview: status.overview, detail: status.detail, fetchCount,
      bytes: LODS.reduce((sum, lod) => sum + (models[lod]?.bytes ?? 0), 0) }; },
    dispose() { if (disposed) return; disposed = true; desired = null; cancelFlight();
      for (const lod of LODS) { releaseModel(models[lod]); delete models[lod]; } },
  };
}
