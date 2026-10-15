import { createTerrainComposer } from "../terrain/terrain.ts";
import { objectBounds as boundsOf, objectCorners as cornersOf, objectLocalBounds as localBoundsOf, compareObjects as compare } from "../scene/objects.ts";
import { getObjectShadowHeight } from "../scene/objects.ts";
import { assertPngDataUrl, type ImageAsset } from "../assets/image-assets.ts";
import { DEFAULT_LAYERS, isObjectLocked, isObjectVisible, type SceneLayer } from "../scene/stacking.ts";
import { DEFAULT_FOLDERS, folderContains, objectFolderId, type SceneFolder } from "../scene/folders.ts";
import { dirtyTerrainChunks, terrainAppearance, type TerrainPreview, type TerrainState } from "../terrain/terrain-data.ts";
import { createLightingRenderer, type CasterSource } from "../lighting/lighting-renderer.ts";
import { initialLighting, type LightingState } from "../lighting/lighting-data.ts";
import { validateSceneSize, type Bounds, type EngineObject, type EnginePreset } from "../scene/contracts.ts";
import { canvasMemoryResources, estimateCacheMemory, mergeCacheMemory, type CacheMemoryResource } from "./cache-memory.ts";

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;
export type ImageLoader = (dataUrl: string) => Promise<CanvasImageSource>;
export type SceneRenderOptions = {
  seed: number; width: number; height: number; grid?: boolean; objectFilter?: (object: EngineObject) => boolean;
  removed: ReadonlySet<string>; planted: readonly EngineObject[];
  modified?: ReadonlyMap<string, EngineObject>; selectedId?: string | null;
  assets?: ReadonlyMap<string, ImageAsset>; selectionZoom?: number;
  layers?: readonly SceneLayer[]; includeHidden?: boolean;
  folders?: readonly SceneFolder[]; terrain?: TerrainState; terrainPreview?: TerrainPreview;
  objectRevision?: number; previewObjects?: ReadonlyMap<string, EngineObject>; previewRevision?: number;
  selectedFolderId?: string | null; brushCursor?: { x: number; y: number; diameter: number };
  selectionArea?: Bounds;
  interactiveCache?: boolean; renderScale?: number;
  lighting?: LightingState;
};
const TILE = 512;
const SOURCE_PIXEL_BUDGET = 64_000_000;
const BUCKET = 256;
const EMPTY_TERRAIN: TerrainState = { baseTrails: true, cells: Object.freeze({}) };
const DISABLED_LIGHTING = initialLighting();

async function decodeImage(dataUrl: string): Promise<CanvasImageSource> {
  await assertPngDataUrl(dataUrl);
  const image = new Image();
  image.src = dataUrl;
  try { await image.decode(); }
  catch { throw new Error("Не удалось прочитать PNG. Проверьте, что файл не повреждён."); }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("PNG не содержит изображения.");
  return image;
}

/** Ground chunks and a small sprite atlas are disposable caches, never map data. */
export function createScenePainter(makeCanvas: CanvasFactory, preset: EnginePreset, onAssetsChanged?: () => void, loadImage: ImageLoader = decodeImage) {
  const catalog = preset.catalog;
  const objectBounds = (object: EngineObject) => boundsOf(object, catalog);
  const objectCorners = (object: EngineObject) => cornersOf(object, catalog);
  const objectLocalBounds = (object: EngineObject) => localBoundsOf(object, catalog);
  const compareObjects = (a: EngineObject, b: EngineObject, layers: readonly SceneLayer[]) => compare(a, b, layers, catalog);
  const resolveFolder = (kind: string) => catalog[kind]?.folderId ?? kind;
  let sceneHeight = 1, generatedHeight = 0;
  let terrainComposer: ReturnType<typeof createTerrainComposer> | undefined, terrainExtentKey = "";
  const ground = new Map<string, HTMLCanvasElement>();
  const materialGround = new Map<string, HTMLCanvasElement>();
  const editedGround = new Map<string, { canvas: HTMLCanvasElement; baseTrails: boolean; previewCells: TerrainPreview["cells"] | undefined; previewVersion: number }>();
  let lastTerrainCells: TerrainState["cells"] | undefined;
  let lastTerrainAppearanceRef: TerrainState["appearance"] | null = null, lastTerrainAppearanceKey = "";
  let terrainComposites = 0, baseTerrainBuilds = 0;
  const sprites = new Map<string, HTMLCanvasElement>();
  const shadows = new Map<string, HTMLCanvasElement>();
  const casterArt = new Map<string, CasterSource>();
  const lightingRenderer = createLightingRenderer(makeCanvas, casterSource, object => getObjectShadowHeight(object, catalog));
  type Source = { promise: Promise<CanvasImageSource>; image?: CanvasImageSource; pixels: number; used: number; failed?: boolean };
  // Current scene and freshly prepared imports stay decoded; older undo entries use LRU.
  const sources = new Map<string, Map<string, Source>>();
  let currentSources = new Set<Source>(), preparedSources = new Set<Source>();
  const preparingSources = new Map<Source, number>();
  let sourceClock = 0;
  let disposed = false;
  let lastSeed = -1;
  let generated: EngineObject[] = [];
  let generatedWidth = 0;
  let lastPaintAssets: ReadonlyMap<string, ImageAsset> | undefined;
  let activeAssets: ReadonlyMap<string, ImageAsset> | undefined;
  let boundsCache = new WeakMap<EngineObject, Bounds>();
  let sceneBuilds = 0, boundsComputed = 0, shadowBuilds = 0;
  type PreparedScene = { key: unknown[]; all: EngineObject[]; visible: EngineObject[]; byId: Map<string, EngineObject>;
    bounds: Bounds[]; buckets: Map<string, number[]>; oversized: number[] };
  let prepared: PreparedScene | undefined;
  let previewCache: { scene: PreparedScene; map: SceneRenderOptions["previewObjects"]; revision: number | undefined;
    all: EngineObject[]; visible: EngineObject[]; count: number } | undefined;
  let folderFrameCache: { scene: PreparedScene; preview: typeof previewCache; folderId: string; bounds: Bounds | null } | undefined;
  let staticWorld: HTMLCanvasElement | undefined, staticScratch: HTMLCanvasElement | undefined;
  let staticScene: PreparedScene | undefined, staticExcluded = new Set<string>();
  const staticReady = new Set<string>();
  let staticTileBuilds = 0;
  const intersects = (bounds: Bounds, view: Bounds) => bounds.x + bounds.width > view.x && bounds.x < view.x + view.width
    && bounds.y + bounds.height > view.y && bounds.y < view.y + view.height;

  function boundsFor(object: EngineObject) {
    let bounds = boundsCache.get(object);
    if (!bounds) { bounds = objectBounds(object); boundsCache.set(object, bounds); boundsComputed++; }
    return bounds;
  }

  function objectVisible(object: EngineObject, options: SceneRenderOptions) {
    return isObjectVisible(object, options.layers ?? DEFAULT_LAYERS, options.folders ?? DEFAULT_FOLDERS, resolveFolder)
      && (options.objectFilter?.(object) ?? true);
  }

  function pruneSources() {
    let pixels = 0;
    const candidates: { id: string; dataUrl: string; source: Source }[] = [];
    for (const [id, versions] of sources) for (const [dataUrl, source] of versions) {
      if (source.failed && !currentSources.has(source) && !preparingSources.has(source)) {
        versions.delete(dataUrl);
        if (!versions.size) sources.delete(id);
        continue;
      }
      if (!source.image) continue;
      pixels += source.pixels;
      if (!currentSources.has(source) && !preparedSources.has(source) && !preparingSources.has(source)) candidates.push({ id, dataUrl, source });
    }
    candidates.sort((a, b) => a.source.used - b.source.used);
    for (const { id, dataUrl, source } of candidates) {
      if (pixels <= SOURCE_PIXEL_BUDGET) break;
      pixels -= source.pixels;
      const versions = sources.get(id);
      versions?.delete(dataUrl);
      if (!versions?.size) sources.delete(id);
    }
  }

  function prepareAsset(asset: ImageAsset, retry = false) {
    let versions = sources.get(asset.id);
    if (!versions) { versions = new Map(); sources.set(asset.id, versions); }
    const existing = versions.get(asset.dataUrl);
    if (existing && !(existing.failed && retry)) { existing.used = ++sourceClock; return existing; }
    const bucket = versions;
    const source: Source = { pixels: asset.width * asset.height, used: ++sourceClock,
      promise: Promise.resolve().then(() => loadImage(asset.dataUrl)).then(image => {
        if (!disposed) {
          source.image = image;
          // A restored source may have been represented by a loading placeholder in the bitmap.
          for (const object of staticScene?.visible ?? []) if (object.kind === "image" && object.assetId === asset.id) invalidateStatic(boundsFor(object));
          lightingRenderer.invalidateAsset(asset.id);
          lastPaintAssets = undefined; pruneSources(); onAssetsChanged?.();
        }
        return image;
      }).catch(error => {
        // Remember a lazy failure to avoid retrying every camera frame; explicit import retries it.
        source.failed = true;
        throw error instanceof Error ? error : new Error("Не удалось подготовить PNG.");
      }) };
    bucket.set(asset.dataUrl, source);
    return source;
  }

  async function prepareAssets(assets: readonly ImageAsset[]) {
    if (disposed) throw new Error("Редактор уже закрыт.");
    const pending = assets.map(asset => prepareAsset(asset, true));
    for (const source of pending) preparingSources.set(source, (preparingSources.get(source) ?? 0) + 1);
    try {
      await Promise.all(pending.map(source => source.promise));
      if (disposed) throw new Error("Редактор уже закрыт.");
      preparedSources = new Set(pending);
    } finally {
      for (const source of pending) {
        const count = (preparingSources.get(source) ?? 1) - 1;
        if (count) preparingSources.set(source, count); else preparingSources.delete(source);
      }
      pruneSources();
    }
  }

  function prepareScene(options: SceneRenderOptions): PreparedScene {
    if (!validateSceneSize(options)) throw new RangeError("Invalid scene dimensions.");
    sceneHeight = options.height;
    const key = [options.seed, options.width, options.objectFilter, options.objectRevision, options.planted,
      options.modified, options.removed, options.layers, options.folders, options.height];
    if (prepared && key.every((value, index) => value === prepared!.key[index])) return prepared;
    if (lastSeed !== options.seed || generatedWidth !== options.width || generatedHeight !== options.height) {
      if (lastSeed !== options.seed) { ground.clear(); materialGround.clear(); editedGround.clear(); lastTerrainCells = undefined; }
      lastSeed = options.seed; generatedWidth = options.width; generatedHeight = options.height;
      generated = preset.generateObjects?.(options.seed, { x: 0, y: 0, width: options.width, height: sceneHeight }) ?? [];
    }
    const scene = new Map([...generated, ...(preset.initialObjects?.() ?? []), ...options.planted].map(object => [object.id, object]));
    for (const [id, object] of options.modified ?? []) scene.set(id, object);
    const layers = options.layers ?? DEFAULT_LAYERS;
    const all = [...scene.values()].filter(object => !options.removed.has(object.id)).sort((a, b) => compareObjects(a, b, layers));
    const visible = all.filter(object => objectVisible(object, options)), bounds = visible.map(boundsFor);
    const buckets = new Map<string, number[]>(), oversized: number[] = [];
    bounds.forEach((bounds, index) => {
      const minX = Math.floor(bounds.x / BUCKET), minY = Math.floor(bounds.y / BUCKET);
      const maxX = Math.floor((bounds.x + bounds.width) / BUCKET), maxY = Math.floor((bounds.y + bounds.height) / BUCKET);
      if ((maxX - minX + 1) * (maxY - minY + 1) > 64) { oversized.push(index); return; }
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const bucketKey = `${x}:${y}`, bucket = buckets.get(bucketKey);
        if (bucket) bucket.push(index); else buckets.set(bucketKey, [index]);
      }
    });
    prepared = { key, all, visible, byId: new Map(all.map(object => [object.id, object])), bounds, buckets, oversized };
    previewCache = undefined; folderFrameCache = undefined; sceneBuilds++;
    return prepared;
  }

  function previews(options: SceneRenderOptions, scene: PreparedScene) {
    if (previewCache?.scene === scene && previewCache.map === options.previewObjects && previewCache.revision === options.previewRevision) return previewCache;
    const all = [...options.previewObjects?.values() ?? []].filter(object => scene.byId.has(object.id) && !options.removed.has(object.id));
    all.sort((a, b) => compareObjects(a, b, options.layers ?? DEFAULT_LAYERS));
    const visible = all.filter(object => objectVisible(object, options), options.height);
    let count = scene.visible.length;
    for (const object of all) {
      const original = scene.byId.get(object.id)!;
      count += Number(objectVisible(object, options)) - Number(objectVisible(original, options));
      boundsFor(object);
    }
    previewCache = { scene, map: options.previewObjects, revision: options.previewRevision, all, visible, count };
    return previewCache;
  }

  function visibleObjects(options: SceneRenderOptions, view: Bounds, scene: PreparedScene) {
    const overlay = previews(options, scene), indices = new Set(scene.oversized);
    const minX = Math.floor(view.x / BUCKET), minY = Math.floor(view.y / BUCKET);
    const maxX = Math.floor((view.x + view.width) / BUCKET), maxY = Math.floor((view.y + view.height) / BUCKET);
    // Fit-to-map and PNG export can skip bucket deduplication while retaining cached bounds.
    if ((maxX - minX + 1) * (maxY - minY + 1) > scene.buckets.size) {
      for (let index = 0; index < scene.visible.length; index++) indices.add(index);
    } else {
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) for (const index of scene.buckets.get(`${x}:${y}`) ?? []) indices.add(index);
    }
    const result = [...indices].sort((a, b) => a - b).filter(index => !options.previewObjects?.has(scene.visible[index].id)
      && intersects(scene.bounds[index], view)).map(index => scene.visible[index]);
    for (const object of overlay.visible) {
      if (!intersects(boundsFor(object), view)) continue;
      let low = 0, high = result.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compareObjects(result[middle], object, options.layers ?? DEFAULT_LAYERS) < 0) low = middle + 1; else high = middle; }
      result.splice(low, 0, object);
    }
    return { visible: result, count: overlay.count };
  }

  function invalidateStatic(bounds: Bounds) {
    if (!staticWorld) return;
    const minX = Math.max(0, Math.floor((bounds.x - 2) / TILE)), minY = Math.max(0, Math.floor((bounds.y - 2) / TILE));
    const maxX = Math.min(Math.ceil(staticWorld.width / TILE) - 1, Math.floor((bounds.x + bounds.width + 2) / TILE));
    const maxY = Math.min(Math.ceil(sceneHeight / TILE) - 1, Math.floor((bounds.y + bounds.height + 2) / TILE));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) staticReady.delete(`${x}:${y}`);
  }

  function sameDrawing(a: EngineObject, b: EngineObject) {
    return a.kind === b.kind && a.x === b.x && a.y === b.y && a.scale === b.scale && a.variant === b.variant
      && (a.rotation ?? 0) === (b.rotation ?? 0) && a.assetId === b.assetId && a.imageWidth === b.imageWidth && a.imageHeight === b.imageHeight
      && (a.layerId ?? "world") === (b.layerId ?? "world") && !!a.stackOrder === !!b.stackOrder
      && (a.stackOrder?.length ?? 0) === (b.stackOrder?.length ?? 0) && (a.stackOrder?.every((value, index) => value === b.stackOrder![index]) ?? true);
  }

  function syncStatic(scene: PreparedScene, options: SceneRenderOptions) {
    if (!staticWorld || (staticWorld.width !== options.width || staticWorld.height !== options.height)) {
      const previous = staticWorld; staticWorld = makeCanvas(options.width, sceneHeight);
      const ctx = staticWorld.getContext("2d"); if (!ctx) throw new Error("Не удалось подготовить кэш предметов.");
      if (previous) {
        ctx.drawImage(previous, 0, 0);
        if (previous.height !== options.height) staticReady.clear();
        const edge = Math.floor((Math.min(previous.width, options.width) - 1) / TILE);
        for (let y = 0; y < Math.ceil(sceneHeight / TILE); y++) staticReady.delete(`${edge}:${y}`);
        for (const key of staticReady) if (Number(key.split(":")[0]) * TILE >= options.width) staticReady.delete(key);
      } else staticReady.clear();
    }
    if (staticScene && staticScene !== scene) {
      const oldLayers = (staticScene.key[7] as SceneRenderOptions["layers"]) ?? DEFAULT_LAYERS;
      const newLayers = (scene.key[7] as SceneRenderOptions["layers"]) ?? DEFAULT_LAYERS;
      if (oldLayers.length !== newLayers.length || oldLayers.some((layer, index) => layer.id !== newLayers[index].id)) staticReady.clear();
      const old = new Map(staticScene.visible.map(object => [object.id, object]));
      for (const object of scene.visible) {
        const previous = old.get(object.id); old.delete(object.id);
        if (!previous || !sameDrawing(previous, object)) { if (previous) invalidateStatic(boundsFor(previous)); invalidateStatic(boundsFor(object)); }
      }
      for (const object of old.values()) invalidateStatic(boundsFor(object));
    }
    const preview = options.previewObjects;
    let changed = staticExcluded.size !== (preview?.size ?? 0);
    if (!changed) for (const id of preview?.keys() ?? []) if (!staticExcluded.has(id)) { changed = true; break; }
    if (changed) {
      for (const id of staticExcluded) if (!preview?.has(id)) { const object = scene.byId.get(id) ?? staticScene?.byId.get(id); if (object) invalidateStatic(boundsFor(object)); }
      for (const id of preview?.keys() ?? []) if (!staticExcluded.has(id)) { const object = scene.byId.get(id); if (object) invalidateStatic(boundsFor(object)); }
      staticExcluded = new Set(preview?.keys());
    }
    staticScene = scene;
  }

  function objects(options: SceneRenderOptions) {
    const scene = prepareScene(options), overlay = previews(options, scene);
    const original = options.includeHidden ? scene.all : scene.visible;
    if (!overlay.all.length) return [...original];
    const result = original.filter(object => !options.previewObjects?.has(object.id));
    return [...result, ...(options.includeHidden ? overlay.all : overlay.visible)].sort((a, b) => compareObjects(a, b, options.layers ?? DEFAULT_LAYERS));
  }

  function folderBounds(options: SceneRenderOptions, scene: PreparedScene): Bounds | null {
    const folderId = options.selectedFolderId;
    if (!folderId) return null;
    const overlay = previews(options, scene);
    if (folderFrameCache?.scene === scene && folderFrameCache.preview === overlay && folderFrameCache.folderId === folderId) return folderFrameCache.bounds;
    const folders = options.folders ?? DEFAULT_FOLDERS;
    const members = [...scene.visible.filter(object => !options.previewObjects?.has(object.id)), ...overlay.visible]
      .filter(object => folderContains(folderId, objectFolderId(object, folders, resolveFolder), folders));
    let bounds: Bounds | null = null;
    for (const object of members) {
      const box = boundsFor(object);
      if (!bounds) bounds = { ...box };
      else {
        const maxX = Math.max(bounds.x + bounds.width, box.x + box.width), maxY = Math.max(bounds.y + bounds.height, box.y + box.height);
        bounds.x = Math.min(bounds.x, box.x); bounds.y = Math.min(bounds.y, box.y); bounds.width = maxX - bounds.x; bounds.height = maxY - bounds.y;
      }
    }
    folderFrameCache = { scene, preview: overlay, folderId, bounds }; return bounds;
  }

  function shadowSprite(kind: string) {
    const definition = catalog[kind]?.contactShadow;
    if (!definition) return undefined;
    let canvas = shadows.get(kind);
    if (!canvas) {
      const { bounds, scale } = definition;
      canvas = makeCanvas(Math.ceil(bounds.width * scale), Math.ceil(bounds.height * scale));
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas 2D unavailable.");
      ctx.scale(scale, scale); ctx.translate(-bounds.x, -bounds.y); definition.draw(ctx);
      shadows.set(kind, canvas); shadowBuilds++;
    }
    return canvas;
  }

  function syncTerrain(state: TerrainState) {
    if (lastTerrainAppearanceRef !== state.appearance) {
      const key = JSON.stringify(terrainAppearance(state));
      if (key !== lastTerrainAppearanceKey) editedGround.clear();
      lastTerrainAppearanceRef = state.appearance; lastTerrainAppearanceKey = key;
    }
    if (lastTerrainCells === state.cells) return;
    const changed = new Set<string>();
    for (const [key, material] of Object.entries(lastTerrainCells ?? {})) if (state.cells[key] !== material) changed.add(key);
    for (const [key, material] of Object.entries(state.cells)) if (lastTerrainCells?.[key] !== material) changed.add(key);
    for (const key of dirtyTerrainChunks(changed)) editedGround.delete(key);
    lastTerrainCells = state.cells;
  }

  function terrainTile(tx: number, ty: number, options: SceneRenderOptions) {
    const state = options.terrain ?? EMPTY_TERRAIN, key = `${tx}:${ty}`, baseKey = `${state.baseTrails ? 1 : 0}:${key}`;
    const bounds = { x: tx * TILE - 1, y: ty * TILE - 1, width: TILE + 2, height: TILE + 2 };
    let base = ground.get(baseKey);
    if (!base) {
      // One-pixel bleed avoids interpolation cracks at fractional camera scales.
      base = makeCanvas(TILE + 2, TILE + 2);
      const ctx = base.getContext("2d"); if (!ctx) throw new Error("Не удалось подготовить землю.");
      ctx.translate(1 - tx * TILE, 1 - ty * TILE); preset.terrainPainter.drawBase(ctx, options.seed, bounds, state.baseTrails);
      ground.set(baseKey, base); baseTerrainBuilds++;
    }
    const previewVersion = options.terrainPreview?.chunkVersions.get(key) ?? 0;
    const previewCells = previewVersion ? options.terrainPreview?.cells : undefined;
    const cached = editedGround.get(key);
    if (cached && cached.baseTrails === state.baseTrails && cached.previewVersion === previewVersion && cached.previewCells === previewCells) return cached.canvas;
    const canvas = terrainComposer!.compose(base, bounds, state, options.terrainPreview, material => {
      const materialKey = `${state.baseTrails ? 1 : 0}:${material}:${key}`;
      let tile = materialGround.get(materialKey);
      if (!tile) {
        tile = makeCanvas(TILE + 2, TILE + 2);
        const ctx = tile.getContext("2d"); if (!ctx) throw new Error("Не удалось подготовить материал местности.");
        ctx.translate(1 - tx * TILE, 1 - ty * TILE); preset.terrainPainter.drawMaterial(ctx, options.seed, bounds, material, state.baseTrails);
        materialGround.set(materialKey, tile);
      }
      return tile;
    }, cached?.canvas, options.seed, options.width);
    if (canvas !== base) terrainComposites++;
    editedGround.set(key, { canvas, baseTrails: state.baseTrails, previewCells, previewVersion }); return canvas;
  }

  function sprite(object: EngineObject) {
    const key = `${object.kind}:${object.variant}`, definition = catalog[object.kind];
    const shape = definition?.sprite;
    if (!shape) return undefined;
    let canvas = sprites.get(key);
    if (!canvas) {
      const { bounds, scale } = shape;
      canvas = makeCanvas(Math.ceil(bounds.width * scale), Math.ceil(bounds.height * scale));
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas 2D unavailable.");
      ctx.scale(scale, scale); ctx.translate(-bounds.x, -bounds.y); definition.draw?.(ctx, object);
      sprites.set(key, canvas);
    }
    return canvas;
  }

  function casterSource(object: EngineObject): CasterSource {
    if (object.kind === "image") {
      const asset = object.assetId ? activeAssets?.get(object.assetId) : undefined;
      return { image: asset && sources.get(asset.id)?.get(asset.dataUrl)?.image, bounds: objectLocalBounds(object) };
    }
    const definition = catalog[object.kind];
    if (definition?.sprite) return { image: sprite(object), bounds: definition.sprite.bounds };
    const key = `${object.kind}:${object.variant}`;
    let art = casterArt.get(key);
    if (!art) {
      const bounds = objectBounds({ ...object, x: 0, y: 0, scale: 1, rotation: 0 });
      const image = makeCanvas(Math.ceil(bounds.width * 2) + 8, Math.ceil(bounds.height * 2) + 8), ctx = image.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable.");
      const padded = { x: bounds.x - 2, y: bounds.y - 2, width: image.width / 2, height: image.height / 2 };
      ctx.scale(2, 2); ctx.translate(-padded.x, -padded.y); definition?.draw?.(ctx, object);
      art = { image, bounds: padded }; casterArt.set(key, art);
    }
    return art;
  }

  function drawShadows(ctx: CanvasRenderingContext2D, items: readonly EngineObject[]) {
    for (const object of items) {
      const image = shadowSprite(object.kind), definition = catalog[object.kind]?.contactShadow;
      if (!image || !definition) continue;
      ctx.save(); ctx.translate(object.x, object.y); ctx.rotate((object.rotation ?? 0) * Math.PI / 180); ctx.scale(object.scale, object.scale);
      const bounds = definition.bounds; ctx.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height); ctx.restore();
    }
  }

  function drawObjects(ctx: CanvasRenderingContext2D, items: readonly EngineObject[], options: SceneRenderOptions) {
    for (const object of items) {
      ctx.save(); ctx.translate(object.x, object.y); ctx.rotate((object.rotation ?? 0) * Math.PI / 180); ctx.scale(object.scale, object.scale);
      if (object.kind === "image") {
        const asset = object.assetId ? options.assets?.get(object.assetId) : undefined;
        const image = asset && sources.get(asset.id)?.get(asset.dataUrl)?.image;
        const bounds = objectLocalBounds(object);
        if (image) ctx.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height);
        else {
          ctx.fillStyle = "#233d3455"; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
          ctx.strokeStyle = "#e5d5a9"; ctx.lineWidth = 1 / (object.scale * (options.selectionZoom ?? 1));
          ctx.setLineDash([5, 4]); ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height); ctx.setLineDash([]);
          ctx.fillStyle = "#fff3cf"; ctx.font = "14px sans-serif"; ctx.textAlign = "center"; ctx.fillText("Загрузка PNG…", 0, bounds.y + bounds.height / 2);
        }
      } else {
        const definition = catalog[object.kind], image = sprite(object);
        if (image && definition?.sprite) { const bounds = definition.sprite.bounds; ctx.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height); }
        else definition?.draw?.(ctx, object);
      }
      ctx.restore();
    }
  }

  function drawGroundChunks(ctx: CanvasRenderingContext2D, view: Bounds, options: SceneRenderOptions) {
    const minX = Math.max(0, Math.floor(view.x / TILE)), maxX = Math.min(Math.ceil(options.width / TILE) - 1, Math.floor((view.x + view.width) / TILE));
    const minY = Math.max(0, Math.floor(view.y / TILE)), maxY = Math.min(Math.ceil(sceneHeight / TILE) - 1, Math.floor((view.y + view.height) / TILE));
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) ctx.drawImage(terrainTile(tx, ty, options), tx * TILE - 1, ty * TILE - 1);
  }

  function staticTile(tx: number, ty: number, scene: PreparedScene, options: SceneRenderOptions) {
    const key = `${tx}:${ty}`;
    if (staticReady.has(key)) return;
    staticScratch ??= makeCanvas(TILE + 2, TILE + 2);
    const ctx = staticScratch.getContext("2d"), worldCtx = staticWorld!.getContext("2d");
    if (!ctx || !worldCtx) throw new Error("Не удалось обновить кэш предметов.");
    const bounds = { x: tx * TILE - 1, y: ty * TILE - 1, width: TILE + 2, height: TILE + 2 };
    const items = visibleObjects({ ...options, previewObjects: undefined, previewRevision: 0 }, bounds, scene).visible.filter(object => !staticExcluded.has(object.id));
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, TILE + 2, TILE + 2); ctx.translate(1 - tx * TILE, 1 - ty * TILE);
    drawShadows(ctx, items); drawObjects(ctx, items, options); ctx.restore();
    const width = Math.min(TILE, options.width - tx * TILE), height = Math.min(TILE, sceneHeight - ty * TILE);
    // Integer copies stitch transparent cores once; camera scaling never doubles alpha at seams.
    worldCtx.save(); worldCtx.setTransform(1, 0, 0, 1, 0, 0); worldCtx.imageSmoothingEnabled = false;
    worldCtx.clearRect(tx * TILE, ty * TILE, width, height);
    worldCtx.drawImage(staticScratch, 1, 1, width, height, tx * TILE, ty * TILE, width, height); worldCtx.restore();
    staticReady.add(key); staticTileBuilds++;
  }

  function drawStatic(ctx: CanvasRenderingContext2D, view: Bounds, scene: PreparedScene, options: SceneRenderOptions) {
    syncStatic(scene, options);
    const minX = Math.max(0, Math.floor(view.x / TILE)), maxX = Math.min(Math.ceil(options.width / TILE) - 1, Math.floor((view.x + view.width) / TILE));
    const minY = Math.max(0, Math.floor(view.y / TILE)), maxY = Math.min(Math.ceil(sceneHeight / TILE) - 1, Math.floor((view.y + view.height) / TILE));
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) staticTile(tx, ty, scene, options);
    ctx.drawImage(staticWorld!, 0, 0);
    const overlay = previews(options, scene);
    let repair: Bounds | undefined;
    for (const object of overlay.visible) {
      const box = boundsFor(object);
      if (!repair) repair = { ...box };
      else {
        const right = Math.max(repair.x + repair.width, box.x + box.width), bottom = Math.max(repair.y + repair.height, box.y + box.height);
        repair.x = Math.min(repair.x, box.x); repair.y = Math.min(repair.y, box.y); repair.width = right - repair.x; repair.height = bottom - repair.y;
      }
    }
    if (!repair) return;
    repair = { x: repair.x - 2, y: repair.y - 2, width: repair.width + 4, height: repair.height + 4 };
    if (!intersects(repair, view)) return;
    const items = visibleObjects(options, repair, scene).visible;
    // Opaque ground erases the cached composite in this patch before rebuilding every alpha layer.
    ctx.save(); ctx.beginPath(); ctx.rect(repair.x, repair.y, repair.width, repair.height); ctx.clip();
    drawGroundChunks(ctx, repair, options);
    if (options.lighting?.enabled) lightingRenderer.paintGroundShadows(ctx, repair);
    drawShadows(ctx, items); drawObjects(ctx, items, options); ctx.restore();
  }

  function paint(ctx: CanvasRenderingContext2D, view: Bounds, options: SceneRenderOptions) {
    if (disposed) return { objects: 0, chunks: 0 };
    if (activeAssets !== options.assets) {
      const previous = activeAssets; activeAssets = options.assets;
      // Imports can replace a source before the first paint of the new scene. Refresh its alpha
      // only after the lookup points at that scene, even if its object geometry did not change.
      const changed = new Set<string>();
      for (const [id, asset] of activeAssets ?? []) if (previous?.get(id)?.dataUrl !== asset.dataUrl) changed.add(id);
      for (const id of previous?.keys() ?? []) if (!activeAssets?.has(id)) changed.add(id);
      for (const id of changed) lightingRenderer.invalidateAsset(id);
      for (const object of staticScene?.visible ?? []) if (object.kind === "image" && object.assetId && changed.has(object.assetId)) invalidateStatic(boundsFor(object));
    }
    if (lastPaintAssets !== options.assets) {
      currentSources = new Set(); lastPaintAssets = options.assets;
      for (const asset of options.assets?.values() ?? []) {
        const source = prepareAsset(asset); currentSources.add(source);
        // Loading a source evicted from undo is asynchronous; imports/exports await preparation.
        void source.promise.catch(() => {});
      }
      preparedSources.clear(); pruneSources();
    } else if (preparedSources.size) {
      preparedSources.clear(); pruneSources();
    }
    // The object list may include hidden records; drawing and image export always honor visibility.
    const extent = preset.terrainBounds ?? { width: options.width, height: options.height }, key = `${extent.width}:${extent.height}`;
    if (!terrainComposer || key !== terrainExtentKey) {
      terrainComposer?.dispose(); terrainComposer = createTerrainComposer(makeCanvas, preset.terrain, preset.terrainPainter, extent); terrainExtentKey = key;
      ground.clear(); materialGround.clear(); editedGround.clear();
    }
    const scene = prepareScene(options), { visible, count } = visibleObjects(options, view, scene);
    lightingRenderer.sync(options.width, options.lighting ?? DISABLED_LIGHTING, scene.visible, options.previewObjects, options.previewRevision, object => objectVisible(object, options), options.height);
    syncTerrain(options.terrain ?? EMPTY_TERRAIN);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, options.width, sceneHeight); ctx.clip();
    drawGroundChunks(ctx, view, options);
    if (options.lighting?.enabled) lightingRenderer.paintGroundShadows(ctx, view);
    if (options.interactiveCache && (options.renderScale ?? Infinity) <= 1 && count >= 500) drawStatic(ctx, view, scene, options);
    else { drawShadows(ctx, visible); drawObjects(ctx, visible, options); }
    if (options.lighting?.enabled) lightingRenderer.paintIllumination(ctx, view);
    if (options.grid) {
      ctx.strokeStyle = "#f3edb67a"; ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]); ctx.beginPath();
      for (let x = TILE; x < options.width; x += TILE) { ctx.moveTo(x, 0); ctx.lineTo(x, sceneHeight); }
      for (let y = TILE; y < sceneHeight; y += TILE) { ctx.moveTo(0, y); ctx.lineTo(options.width, y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    const selected = options.selectedId ? options.previewObjects?.get(options.selectedId) ?? scene.byId.get(options.selectedId) : undefined;
    if (selected && !options.removed.has(selected.id) && objectVisible(selected, options)) {
      const zoom = Math.max(.01, options.selectionZoom ?? 1), corners = objectCorners(selected);
      ctx.strokeStyle = "#ffe4a0"; ctx.lineWidth = 2 / zoom; ctx.setLineDash([5 / zoom, 4 / zoom]);
      ctx.beginPath(); ctx.moveTo(corners[0].x, corners[0].y);
      for (const corner of corners.slice(1)) ctx.lineTo(corner.x, corner.y);
      ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      if (!isObjectLocked(selected, options.layers ?? DEFAULT_LAYERS, options.folders ?? DEFAULT_FOLDERS, resolveFolder)) {
        for (const corner of corners) {
          ctx.fillStyle = "#fff5dc"; ctx.strokeStyle = "#315c50"; ctx.lineWidth = 2 / zoom;
          ctx.beginPath(); ctx.arc(corner.x, corner.y, 7 / zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      ctx.fillStyle = "#ffe4a0"; ctx.beginPath();
      ctx.arc(selected.x, selected.y, 3 / zoom, 0, Math.PI * 2); ctx.fill();
    }
    const group = folderBounds(options, scene);
    if (group) {
      const zoom = Math.max(.01, options.selectionZoom ?? 1);
      ctx.strokeStyle = "#83d8ca"; ctx.lineWidth = 2 / zoom; ctx.setLineDash([8 / zoom, 5 / zoom]);
      ctx.strokeRect(group.x, group.y, group.width, group.height); ctx.setLineDash([]);
    }
    if (options.brushCursor) {
      const { x, y, diameter } = options.brushCursor, zoom = Math.max(.01, options.selectionZoom ?? 1);
      ctx.strokeStyle = "#123b34"; ctx.lineWidth = 3 / zoom; ctx.beginPath(); ctx.arc(x, y, diameter / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "#fff0be"; ctx.lineWidth = 1.5 / zoom; ctx.stroke();
    }
    if (options.selectionArea) {
      const area = options.selectionArea, zoom = Math.max(.01, options.selectionZoom ?? 1);
      ctx.fillStyle = "#83d8ca22"; ctx.fillRect(area.x, area.y, area.width, area.height);
      ctx.strokeStyle = "#83d8ca"; ctx.lineWidth = 2 / zoom; ctx.setLineDash([8 / zoom, 5 / zoom]);
      ctx.strokeRect(area.x, area.y, area.width, area.height); ctx.setLineDash([]);
    }
    ctx.restore();
    return { objects: count, chunks: ground.size };
  }

  function diagnostics() {
    const seen = new Set<object>(), decodedImages: CacheMemoryResource[] = [];
    let sourceEntries = 0, pendingSources = 0, failedSources = 0;
    for (const versions of sources.values()) for (const source of versions.values()) {
      sourceEntries++;
      if (source.image) decodedImages.push({ value: source.image, pixels: source.pixels, kind: "decoded-image" });
      else if (source.failed) failedSources++;
      else pendingSources++;
    }
    const ownMemory = estimateCacheMemory({
      terrainBase: canvasMemoryResources(ground.values()),
      terrainMaterials: canvasMemoryResources(materialGround.values()),
      terrainComposites: canvasMemoryResources(Array.from(editedGround.values(), entry => entry.canvas)),
      sprites: canvasMemoryResources(sprites.values()),
      contactShadows: canvasMemoryResources(shadows.values()),
      casterArt: canvasMemoryResources(Array.from(casterArt.values(), source => source.image as HTMLCanvasElement)),
      staticWorld: canvasMemoryResources([staticWorld]),
      staticWorkspace: canvasMemoryResources([staticScratch]),
      decodedImages,
    }, 0, seen);
    const lighting = lightingRenderer.diagnostics(seen), terrain = terrainComposer?.diagnostics(seen);
    return { sceneBuilds, boundsComputed, shadowBuilds, terrainComposites, baseTerrainBuilds, staticTileBuilds,
      staticPixels: staticWorld ? staticWorld.width * staticWorld.height + (TILE + 2) ** 2 : 0,
      lighting, terrain,
      sourceCache: { entries: sourceEntries, pending: pendingSources, failed: failedSources, pixelBudget: SOURCE_PIXEL_BUDGET },
      memory: mergeCacheMemory(ownMemory, lighting.memory, ...(terrain ? [terrain.memory] : [])),
    };
  }

  return { paint, objects, prepareAssets, diagnostics,
    dispose() { disposed = true; ground.clear(); materialGround.clear(); editedGround.clear(); terrainComposer?.dispose(); sprites.clear(); shadows.clear(); casterArt.clear(); lightingRenderer.dispose(); sources.clear(); currentSources.clear(); preparedSources.clear(); preparingSources.clear(); activeAssets = undefined; lastPaintAssets = undefined; generated = []; prepared = undefined; previewCache = undefined; folderFrameCache = undefined; boundsCache = new WeakMap(); lastTerrainCells = undefined; staticWorld = undefined; staticScratch = undefined; staticScene = undefined; staticReady.clear(); staticExcluded.clear(); } };
}
