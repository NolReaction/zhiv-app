import { earthResourceCache } from "./resource-cache";

export const EARTH_RUNTIME_VERSION = "6.15.0";
export const EARTH_RUNTIME_DIRECTORY = `/vendor/maplibre-gl-${EARTH_RUNTIME_VERSION}`;
export const EARTH_RUNTIME_MANIFEST_URL = `${EARTH_RUNTIME_DIRECTORY}/manifest.json`;

type EarthRuntime = typeof import("maplibre-gl");
type RuntimeFileName = "maplibre-gl.mjs" | "maplibre-gl-worker.mjs" | "maplibre-gl-shared.mjs" | "LICENSE.txt";
type RuntimeFile = { name: RuntimeFileName; bytes: number; sha256: string };
type RuntimeManifest = { schemaVersion: 1; version: string; files: RuntimeFile[] };
type RuntimeCache = {
  readResource: (url: string, type: "json" | "arrayBuffer") => Promise<{ data: unknown }>;
  invalidate: (url: string) => Promise<void>;
};
type RuntimeDependencies = {
  cache: RuntimeCache;
  sha256: ((bytes: ArrayBuffer) => Promise<string>) | null;
  importModule: (url: string) => Promise<EarthRuntime>;
  createModuleUrl: (bytes: ArrayBuffer) => string;
  revokeModuleUrl: (url: string) => void;
};

const FILE_LIMITS: Record<RuntimeFileName, number> = {
  "maplibre-gl.mjs": 4 * 1024 * 1024,
  "maplibre-gl-worker.mjs": 2 * 1024 * 1024,
  "maplibre-gl-shared.mjs": 1024 * 1024,
  "LICENSE.txt": 256 * 1024,
};

function abortError(): DOMException { return new DOMException("Map installation cancelled", "AbortError"); }

function parseManifest(value: unknown): RuntimeManifest {
  if (!value || typeof value !== "object") throw new Error("Не удалось проверить установку карты. Повторите загрузку.");
  const manifest = value as Partial<RuntimeManifest>;
  if (manifest.schemaVersion !== 1 || manifest.version !== EARTH_RUNTIME_VERSION || !Array.isArray(manifest.files)
    || manifest.files.length !== Object.keys(FILE_LIMITS).length) throw new Error("Не удалось проверить установку карты. Повторите загрузку.");
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || !Object.hasOwn(FILE_LIMITS, file.name) || names.has(file.name)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_LIMITS[file.name]
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.bytes === 0 && file.name !== "maplibre-gl-shared.mjs") {
      throw new Error("Не удалось проверить установку карты. Повторите загрузку.");
    }
    names.add(file.name);
  }
  return manifest as RuntimeManifest;
}

function waitForRuntime(pending: Promise<EarthRuntime>, signal?: AbortSignal): Promise<EarthRuntime> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener("abort", cancelled); reject(abortError()); };
    signal.addEventListener("abort", cancelled, { once: true });
    pending.then(value => { signal.removeEventListener("abort", cancelled); resolve(value); }, error => {
      signal.removeEventListener("abort", cancelled); reject(error);
    });
  });
}

/** One installation per page; an unmounted map does not cancel another map's installation. */
export function createEarthRuntimeLoader(dependencies: RuntimeDependencies) {
  let installation: Promise<EarthRuntime> | null = null;

  async function readManifest(): Promise<RuntimeManifest> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await dependencies.cache.readResource(EARTH_RUNTIME_MANIFEST_URL, "json");
        return parseManifest(response.data);
      }
      catch (error) {
        await dependencies.cache.invalidate(EARTH_RUNTIME_MANIFEST_URL);
        if (attempt === 1) throw error;
      }
    }
    throw new Error("Не удалось проверить установку карты. Повторите загрузку.");
  }

  async function readVerifiedFile(file: RuntimeFile): Promise<ArrayBuffer> {
    const url = `${EARTH_RUNTIME_DIRECTORY}/${file.name}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data } = await dependencies.cache.readResource(url, "arrayBuffer");
      if (data instanceof ArrayBuffer && data.byteLength === file.bytes && await dependencies.sha256!(data) === file.sha256) return data;
      await dependencies.cache.invalidate(url);
    }
    throw new Error("Файлы карты повреждены. Повторите загрузку.");
  }

  async function install(): Promise<EarthRuntime> {
    // A normal same-origin import keeps LAN development usable when HTTP has no WebCrypto.
    // Only the HTTPS/localhost path promises a verified, device-cached executable runtime.
    if (!dependencies.sha256) {
      const sdk = await dependencies.importModule(`${EARTH_RUNTIME_DIRECTORY}/maplibre-gl.mjs`);
      if (sdk.getVersion() !== EARTH_RUNTIME_VERSION) throw new Error("Версия карты изменилась. Обновите страницу.");
      sdk.setWorkerUrl(`${EARTH_RUNTIME_DIRECTORY}/maplibre-gl-worker.mjs`);
      sdk.setWorkerCount(1);
      return sdk;
    }
    const manifest = await readManifest();
    const files = await Promise.all(manifest.files.map(async file => [file.name, await readVerifiedFile(file)] as const));
    const assets = new Map(files);
    let moduleUrl: string | null = null;
    let workerUrl: string | null = null;
    let installed = false;
    try {
      moduleUrl = dependencies.createModuleUrl(assets.get("maplibre-gl.mjs")!);
      workerUrl = dependencies.createModuleUrl(assets.get("maplibre-gl-worker.mjs")!);
      const sdk = await dependencies.importModule(moduleUrl);
      if (sdk.getVersion() !== EARTH_RUNTIME_VERSION) throw new Error("Версия карты изменилась. Обновите страницу.");
      sdk.setWorkerUrl(workerUrl);
      sdk.setWorkerCount(1);
      // Keep the worker URL alive: MapLibre creates a new worker after the previous map closes.
      installed = true;
      return sdk;
    } finally {
      if (moduleUrl) dependencies.revokeModuleUrl(moduleUrl);
      if (!installed && workerUrl) dependencies.revokeModuleUrl(workerUrl);
    }
  }

  return function loadEarthRuntime(options: { signal?: AbortSignal } = {}): Promise<EarthRuntime> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (!installation) {
      const pending = install();
      installation = pending;
      void pending.catch(() => { if (installation === pending) installation = null; });
    }
    return waitForRuntime(installation, options.signal);
  };
}

export const loadEarthRuntime = createEarthRuntimeLoader({
  cache: earthResourceCache,
  sha256: typeof crypto !== "undefined" && crypto.subtle ? async bytes => {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
  } : null,
  importModule: url => import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<EarthRuntime>,
  createModuleUrl: bytes => URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })),
  revokeModuleUrl: url => URL.revokeObjectURL(url),
});
