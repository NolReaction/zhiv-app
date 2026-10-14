import { createForestPainter, type CanvasFactory, type ForestOptions, type ImageLoader } from "@/apps/engine/examples/forest/rendering/renderer";
import { canPlant, compareObjects, getObjectShadowHeight, INITIAL_SEED, MAX_WIDTH, objectBounds, objectCorners, OVERSCAN_EDIT_MARGIN, pickObject, WORLD_HEIGHT, type Bounds, type ForestObject, type ObjectKind } from "@/apps/engine/examples/forest/scene/objects";
import { createSceneHistory, createSceneStorageAdapter, parseScene, serializeScene, validateScene, type SceneStorage } from "@/apps/engine/src/editor/scene/editor-scene";
import { imageObjectSize, readPngFile, validateImageAsset, type ImageAsset } from "@/packages/engine/src/assets/image-assets";
import { beginResize, findResizeHandle, MAX_OBJECT_SCALE, MIN_OBJECT_SCALE, resizedObject, type ResizeCorner, type ResizeSession } from "@/apps/engine/examples/forest/input/transform";
import { isObjectLocked, isObjectVisible, objectLayerId, stackKey, stackKeyBetween, type SceneLayer } from "@/apps/engine/examples/forest/scene/stacking";

import { folderAncestors, folderContains, isFolderLocked, isFolderVisible, MAX_SCENE_FOLDERS, objectFolderId, type SceneFolder } from "@/apps/engine/examples/forest/scene/folders";
import { applyTerrainPatch, CELL_SIZE, dirtyTerrainChunks, MAX_TERRAIN_CELLS, strokeTerrainCells, terrainAppearance, updateTerrainAppearance, type TerrainAppearance, type TerrainBrush, type TerrainMaterial, type TerrainState } from "@/apps/engine/examples/forest/terrain/terrain-data";
import { MAX_POINT_LIGHTS, validateLighting, type LightingState, type ScenePointLight } from "@/apps/engine/examples/forest/lighting/lighting-data";
import { createDeferredSave } from "./controller-autosave";

export type ToolMode = "pan" | "select" | "plant" | "erase" | "terrain" | "area";
export type ForestStatus = {
  seed: number; width: number; objects: number; zoom: number; edited: number; message: string;
  selected: ForestObject | null; canUndo: boolean; canRedo: boolean; storage: "saved" | "pending" | "unavailable"; brush: ObjectKind;
  mode: ToolMode; temporaryPan: boolean; trees: boolean; grid: boolean;
  assets: { id: string; name: string }[]; brushAssetId: string | null;
  layers: SceneLayer[]; activeLayerId: string; objectList: ForestObject[]; selectedHidden: boolean; selectedLocked: boolean;
  folders: SceneFolder[]; activeFolderId: string | null | undefined;
  selectedFolder: { folder: SceneFolder; count: number; bounds: Bounds | null; hidden: boolean; locked: boolean } | null;
  terrainBrush: TerrainBrush; terrainSize: number; terrainBaseTrails: boolean; clearVegetation: boolean;
  lighting: LightingState; terrainAppearance: Readonly<TerrainAppearance>; selectedShadowHeight: number | null;
};
export type ForestControllerOptions = {
  requestPngImport?: () => void;
  requestLayersToggle?: () => void;
  requestTerrainTools?: () => void;
  loadImage?: ImageLoader;
  createCanvas?: CanvasFactory;
  /** Undefined uses this origin's browser storage; null explicitly disables storage. */
  storage?: SceneStorage | null;
  /** Host-owned project key. Omitted keeps existing editor scenes in the same origin. */
  storageKey?: string;
};
type ObjectPatch = Partial<Pick<ForestObject, "x" | "y" | "scale" | "rotation" | "variant">>;
type Point = { x: number; y: number };
type Gesture = { start: Point; moved: boolean; pinched: boolean; pan: boolean; temporaryPan: boolean; pointerId: number;
  object?: ForestObject; grabOffset?: Point; resize?: ResizeSession; members?: ForestObject[]; terrainLast?: Point; areaStart?: Point; blocked?: boolean; shift: boolean; lockAxis?: "x" | "y" };
const names: Record<ObjectKind, string> = { tree: "дерево", shrub: "куст", rock: "камень", ruins: "руины", bridge: "мост", jetty: "причал", image: "PNG-объект" };

export function createForestController(canvas: HTMLCanvasElement, report: (status: ForestStatus) => void, controllerOptions: ForestControllerOptions = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось открыть Canvas 2D.");
  const makeCanvas: CanvasFactory = controllerOptions.createCanvas ?? ((width, height) => {
    const surface = document.createElement("canvas"); surface.width = width; surface.height = height; return surface;
  });
  const painter = createForestPainter(makeCanvas, () => invalidate(), controllerOptions.loadImage);
  const editor = canvas.closest<HTMLElement>("[data-forest-editor]") ?? canvas;
  let projectStorage: SceneStorage | null = controllerOptions.storage ?? null;
  if (controllerOptions.storage === undefined) {
    try { projectStorage = window.localStorage; } catch { /* Private browsing can deny all storage access. */ }
  }
  const persistence = createSceneStorageAdapter(projectStorage, controllerOptions.storageKey);
  const restored = persistence.read();
  const history = createSceneHistory(restored.scene);
  let scene = history.getScene();
  const options: ForestOptions = { seed: scene.seed, width: scene.width, trees: true, grid: false,
    removed: new Set(scene.removed), planted: scene.planted, modified: new Map(scene.modified.map(object => [object.id, object])), selectedId: null,
    assets: new Map(scene.assets.map(asset => [asset.id, asset])), selectionZoom: 1, interactiveCache: true, layers: scene.layers, folders: scene.folders, terrain: scene.terrain, lighting: scene.lighting };
  let settingsPreview: { lighting: LightingState; terrain: TerrainState; shadow?: ForestObject } | null = null;
  let storage: ForestStatus["storage"] = restored.available && !restored.invalid ? "saved" : "unavailable";
  let mode: ToolMode = "select", brush: ObjectKind = "tree", brushAssetId: string | null = null, selectedId: string | null = null;
  let screenWidth = 1, screenHeight = 1, zoom = .5, cameraX = 800, cameraY = 800;
  let initialized = false, disposed = false, frame = 0, nextId = 0;
  let message = restored.invalid ? "Сохранённый файл повреждён. Открыта исходная карта; можно импортировать резервную копию JSON."
    : scene.planted.length || scene.removed.length || scene.modified.length || scene.seed !== INITIAL_SEED ? "Твои правки восстановлены. Выбери любой объект и перетащи его."
    : "Выбери любой объект, чтобы переместить его и изменить параметры.";
  const pointers = new Map<number, Point>();
  let gesture: Gesture | undefined;
  let spaceHeld = false, lastPanTime: number | null = null, revision = 0, sceneImportToken = 0;
  let hoverResize: ResizeCorner | null = null;
  let activeLayerId = "world", objectListRevision = -1, cachedObjectList: ForestObject[] = [];
  let activeFolderId: string | null | undefined, selectedFolderId: string | null = null;
  let terrainBrush: TerrainBrush = "path", terrainSize = 80, clearVegetation = false;
  const previewObjects = new Map<string, ForestObject>();
  const terrainCells = new Map<string, TerrainMaterial | null>(), terrainChunks = new Map<string, number>();
  const terrainPreview = { cells: terrainCells, chunkVersions: terrainChunks };
  options.previewObjects = previewObjects; options.previewRevision = 0;
  let cachedAssets: ForestStatus["assets"] = [], previousAssets = scene.assets;
  let lastStatus: ForestStatus | undefined;
  let plantedIds = new Set<string>();
  const objectLookup = new Map<string, ForestObject>();
  const autosave = createDeferredSave(() => persistence.write(scene), value => { storage = value; invalidate(); }, callback => {
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(callback, { timeout: 800 }); return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(callback, 300); return () => window.clearTimeout?.(id);
  });

  function temporaryPan() { return spaceHeld || !!gesture?.temporaryPan; }
  function cursor() {
    canvas.dataset.tool = temporaryPan() || gesture?.pan ? "pan" : mode; canvas.dataset.dragging = gesture ? "true" : "false";
    canvas.dataset.resizing = gesture?.resize ? "true" : "false";
    const corner = gesture?.resize?.corner ?? hoverResize, object = gesture?.object ?? selected();
    let value = "";
    if (corner !== null && object && canvasEditable(object) && !temporaryPan() && !gesture?.pan && mode !== "pan") {
      const corners = objectCorners(object), opposite = corners[(corner + 2) % 4], handle = corners[corner];
      const angle = (Math.atan2(handle.y - opposite.y, handle.x - opposite.x) * 180 / Math.PI + 180) % 180;
      value = angle < 22.5 || angle >= 157.5 ? "ew-resize" : angle < 67.5 ? "nwse-resize" : angle < 112.5 ? "ns-resize" : "nesw-resize";
    }
    canvas.style.cursor = value;
    if (value) canvas.dataset.tool = "resize";
    canvas.dataset.resizeDirection = value.replace("-resize", "");
  }

  function sync() {
    options.seed = scene.seed; options.width = scene.width; options.planted = scene.planted; plantedIds = new Set(scene.planted.map(object => object.id));
    options.removed = new Set(scene.removed); options.modified = new Map(scene.modified.map(object => [object.id, object]));
    options.assets = new Map(scene.assets.map(asset => [asset.id, asset]));
    options.layers = scene.layers; options.folders = scene.folders; options.terrain = scene.terrain; options.lighting = scene.lighting; options.objectRevision = revision;
    if (previousAssets !== scene.assets || !cachedAssets.length) { cachedAssets = scene.assets.map(({ id, name }) => ({ id, name })); previousAssets = scene.assets; }
    if (activeFolderId && !scene.folders.some(folder => folder.id === activeFolderId)) activeFolderId = undefined;
    if (selectedFolderId && !scene.folders.some(folder => folder.id === selectedFolderId)) selectedFolderId = null;
    if (!scene.layers.some(layer => layer.id === activeLayerId)) activeLayerId = "world";
    if (brushAssetId && !options.assets.has(brushAssetId)) { brushAssetId = null; if (brush === "image") { brush = "tree"; mode = "select"; } }
    options.selectedId = selectedId;
    for (const object of scene.planted) {
      const number = /^planted:(\d+)$/.exec(object.id);
      const value = number ? Number(number[1]) : NaN;
      if (Number.isSafeInteger(value) && value < 1_000_000_000) nextId = Math.max(nextId, value + 1);
    }
  }
  sync(); cursor();
  function allObjects() { return objectList(); }
  function selected() {
    if (!selectedId || options.removed.has(selectedId)) return null;
    if (previewObjects.has(selectedId)) return previewObjects.get(selectedId)!;
    objectList(); return objectLookup.get(selectedId) ?? null;
  }
  function objectList() {
    if (objectListRevision !== revision) {
      cachedObjectList = painter.objects({ ...options, trees: true, includeHidden: true, previewObjects: undefined, previewRevision: 0 }).reverse();
      objectLookup.clear(); for (const object of cachedObjectList) objectLookup.set(object.id, object);
      objectListRevision = revision;
    }
    return cachedObjectList;
  }
  function objectVisible(object: ForestObject) { return isObjectVisible(object, scene.layers, scene.folders) && (options.trees || (object.kind !== "tree" && object.kind !== "shrub")); }
  function canvasEditable(object: ForestObject) { return objectVisible(object) && !isObjectLocked(object, scene.layers, scene.folders); }
  function unlocked(object: ForestObject) {
    if (!isObjectLocked(object, scene.layers, scene.folders)) return true;
    message = "Объект или его слой заблокирован. Сначала сними замок в списке слоёв."; invalidate(); return false;
  }
  function placementAllowed(kind: ObjectKind = brush) {
    const layer = scene.layers.find(entry => entry.id === activeLayerId);
    const folderId = objectFolderId({ kind, folderId: activeFolderId } as ForestObject, scene.folders);
    if (layer?.visible && !layer.locked && isFolderVisible(folderId, scene.folders) && !isFolderLocked(folderId, scene.folders)) return true;
    message = "Активный слой или папка скрыты или заблокированы. Включи его или выбери другой слой."; invalidate(); return false;
  }
  let membershipRevision = -1;
  const folderLocks = new Map<string, boolean>();
  const memberships = new Map<string, ForestObject[]>(), folderBoundsCache = new Map<string, Bounds | null>();
  function folderObjects(id: string) {
    if (membershipRevision !== revision) {
      memberships.clear(); folderBoundsCache.clear(); folderLocks.clear();
      for (const object of allObjects()) for (const ancestor of folderAncestors(objectFolderId(object, scene.folders), scene.folders) ?? []) {
        let members = memberships.get(ancestor.id); if (!members) { members = []; memberships.set(ancestor.id, members); } members.push(object);
      }
      membershipRevision = revision;
    }
    return memberships.get(id) ?? [];
  }
  function committedFolderBounds(id: string, members: ForestObject[]) {
    if (folderBoundsCache.has(id)) return folderBoundsCache.get(id)!;
    let bounds: Bounds | null = null;
    for (const member of members) {
      const box = objectBounds(member);
      if (!bounds) bounds = { ...box };
      else { const right = Math.max(bounds.x + bounds.width, box.x + box.width), bottom = Math.max(bounds.y + bounds.height, box.y + box.height);
        bounds.x = Math.min(bounds.x, box.x); bounds.y = Math.min(bounds.y, box.y); bounds.width = right - bounds.x; bounds.height = bottom - bounds.y; }
    }
    folderBoundsCache.set(id, bounds); return bounds;
  }
  let summaryCache: { key: string; value: ForestStatus["selectedFolder"] } | undefined;
  function folderSummary(): ForestStatus["selectedFolder"] {
    if (!selectedFolderId) return null;
    const key = `${revision}:${options.previewRevision}:${selectedFolderId}`;
    if (summaryCache?.key === key) return summaryCache.value;
    const folder = scene.folders.find(entry => entry.id === selectedFolderId); if (!folder) return null;
    const members = folderObjects(folder.id);
    const baseBounds = committedFolderBounds(folder.id, members);
    const first = members[0], preview = first ? previewObjects.get(first.id) : undefined;
    const bounds = baseBounds && preview ? { ...baseBounds, x: baseBounds.x + preview.x - first.x, y: baseBounds.y + preview.y - first.y } : baseBounds;
    if (!folderLocks.has(folder.id)) folderLocks.set(folder.id, isFolderLocked(folder.id, scene.folders) || members.some(object => isObjectLocked(object, scene.layers, scene.folders)));
    const value = { folder, count: members.length, bounds, hidden: !isFolderVisible(folder.id, scene.folders),
      locked: folderLocks.get(folder.id)! };
    summaryCache = { key, value }; return value;
  }
  function anchorLimits(object: ForestObject) {
    const generated = !plantedIds.has(object.id) && ["tree", "shrub", "rock"].includes(object.kind);
    const margin = generated ? OVERSCAN_EDIT_MARGIN : 0;
    return { x0: -margin, x1: scene.width + margin, y0: -margin, y1: WORLD_HEIGHT + margin };
  }
  function withinObject(candidate: ForestObject, original?: ForestObject) {
    if (original && candidate.x === original.x && candidate.y === original.y) return true;
    const limits = anchorLimits(candidate);
    return Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && candidate.x >= limits.x0 && candidate.x <= limits.x1 && candidate.y >= limits.y0 && candidate.y <= limits.y1;
  }
  function previewObject(object: ForestObject) { previewObjects.set(object.id, object); options.previewRevision = (options.previewRevision ?? 0) + 1; }
  function translatedObjects(members: ForestObject[], dx: number, dy: number) {
    let x0 = -Infinity, x1 = Infinity, y0 = -Infinity, y1 = Infinity;
    for (const object of members) { const limits = anchorLimits(object); x0 = Math.max(x0, limits.x0 - object.x); x1 = Math.min(x1, limits.x1 - object.x); y0 = Math.max(y0, limits.y0 - object.y); y1 = Math.min(y1, limits.y1 - object.y); }
    dx = Math.max(x0, Math.min(x1, dx)); dy = Math.max(y0, Math.min(y1, dy));
    return members.map(object => ({ ...object, x: object.x + dx, y: object.y + dy }));
  }
  function previewTranslation(members: ForestObject[], dx: number, dy: number) {
    for (const object of translatedObjects(members, dx, dy)) previewObjects.set(object.id, object);
    options.previewRevision = (options.previewRevision ?? 0) + 1;
  }
  function membersUnlocked(members: ForestObject[]) {
    const locked = members.find(object => isObjectLocked(object, scene.layers, scene.folders));
    if (locked) return unlocked(locked);
    return true;
  }
  function paintTerrain(position: Point) {
    if (!gesture || !gesture.terrainLast) return;
    const patch = strokeTerrainCells(gesture.terrainLast, position, terrainSize, terrainBrush, scene.width), changed: string[] = [];
    for (const [key, material] of patch) if (!terrainCells.has(key) || terrainCells.get(key) !== material) { terrainCells.set(key, material); changed.push(key); }
    for (const key of dirtyTerrainChunks(changed)) terrainChunks.set(key, (terrainChunks.get(key) ?? 0) + 1);
    gesture.terrainLast = position; options.terrainPreview = terrainPreview;
    options.brushCursor = { ...position, diameter: terrainSize }; invalidate();
  }
  function commitGesture() {
    if (gesture?.terrainLast) {
      const terrain = applyTerrainPatch(scene.terrain, terrainCells);
      if (Object.keys(terrain.cells).length > MAX_TERRAIN_CELLS) { rollbackDrag(); message = "Достигнут предел правок земли. Уменьши мазок или восстанови часть карты."; invalidate(); return; }
      if (clearVegetation && terrainBrush !== "restore") {
        const objects = allObjects().filter(object => (object.kind === "tree" || object.kind === "shrub")
          && objectVisible(object) && !isObjectLocked(object, scene.layers, scene.folders) && terrainCells.has(`${Math.floor(object.x / CELL_SIZE)}:${Math.floor(object.y / CELL_SIZE)}`));
        for (const object of objects) removeObjectRecord(object);
      }
      scene.terrain = terrain; rollbackDrag(); commit("Земля изменена. Весь мазок можно отменить одним действием.");
    } else {
      objectList();
      for (const object of previewObjects.values()) {
        const original = objectLookup.get(object.id);
        if (original && (object.x !== original.x || object.y !== original.y || object.scale !== original.scale || object.rotation !== original.rotation)) replaceObject(object);
      }
      rollbackDrag(); commit(gesture?.members ? "Папка перемещена." : gesture?.resize ? "Размер объекта изменён." : "Объект перемещён.");
    }
  }
  function fit() { zoom = Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .94; cameraX = options.width / 2; cameraY = WORLD_HEIGHT / 2; invalidate(); }
  function clamp() {
    zoom = Math.max(Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .65, Math.min(2.5, zoom));
    cameraX = Math.max(0, Math.min(options.width, cameraX)); cameraY = Math.max(0, Math.min(WORLD_HEIGHT, cameraY));
  }
  function draw(now = performance.now()) {
    frame = 0; if (disposed || !ctx) return;
    clamp(); const autoPanning = edgePan(now); const current = selected();
    options.selectedId = current && objectVisible(current) ? selectedId : null; options.selectedFolderId = selectedFolderId; options.selectionZoom = zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); options.renderScale = zoom * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#11251e"; ctx.fillRect(0, 0, screenWidth, screenHeight);
    ctx.translate(screenWidth / 2, screenHeight / 2); ctx.scale(zoom, zoom); ctx.translate(-cameraX, -cameraY);
    const stats = painter.paint(ctx, { x: cameraX - screenWidth / zoom / 2, y: cameraY - screenHeight / zoom / 2, width: screenWidth / zoom, height: screenHeight / zoom }, options);
    const object = selected();
    const status: ForestStatus = { seed: options.seed, width: options.width, objects: stats.objects, zoom,
      edited: scene.removed.length + scene.planted.length + scene.modified.length, message,
      selected: object, canUndo: history.canUndo, canRedo: history.canRedo, storage, brush, mode, temporaryPan: temporaryPan(), trees: options.trees, grid: options.grid,
      assets: cachedAssets, brushAssetId, layers: scene.layers, folders: scene.folders, activeLayerId, activeFolderId, objectList: objectList(),
      selectedHidden: !!object && !objectVisible(object), selectedLocked: !!object && isObjectLocked(object, scene.layers, scene.folders),
      selectedFolder: folderSummary(), terrainBrush, terrainSize, terrainBaseTrails: scene.terrain.baseTrails, clearVegetation, lighting: options.lighting ?? scene.lighting,
      terrainAppearance: terrainAppearance(options.terrain ?? scene.terrain), selectedShadowHeight: object ? getObjectShadowHeight(object) / object.scale : null };
    if (!lastStatus || Object.keys(status).some(key => status[key as keyof ForestStatus] !== lastStatus![key as keyof ForestStatus])) { lastStatus = status; report(status); }
    if (autoPanning) invalidate();
  }
  function invalidate() { if (!disposed && !frame) frame = requestAnimationFrame(draw); }
  function resize() {
    const rect = canvas.getBoundingClientRect(); screenWidth = Math.max(1, rect.width); screenHeight = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(screenWidth * dpr); canvas.height = Math.round(screenHeight * dpr);
    if (!initialized) { fit(); initialized = true; } else invalidate();
  }
  function point(clientX: number, clientY: number) { const rect = canvas.getBoundingClientRect(); return { x: clientX - rect.left, y: clientY - rect.top }; }
  function world(point: Point) { return { x: cameraX + (point.x - screenWidth / 2) / zoom, y: cameraY + (point.y - screenHeight / 2) / zoom }; }
  function zoomAt(factor: number, point = { x: screenWidth / 2, y: screenHeight / 2 }) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const before = world(point); zoom *= factor; clamp();
    const after = world(point); cameraX += before.x - after.x; cameraY += before.y - after.y; clamp(); updateDrag(); invalidate();
  }
  function save() { autosave.request(); }
  function commit(text: string) { if (history.commit(scene)) { revision++; sync(); save(); } else sync(); message = text; invalidate(); }
  function replaceObject(object: ForestObject) {
    const index = scene.planted.findIndex(entry => entry.id === object.id);
    if (index >= 0) {
      scene.planted[index] = { ...object };
      scene.modified = scene.modified.filter(entry => entry.id !== object.id);
    }
    else {
      const modified = scene.modified.findIndex(entry => entry.id === object.id);
      if (modified >= 0) scene.modified[modified] = { ...object }; else scene.modified.push({ ...object });
    }
  }
  function rollbackDrag() {
    if (previewObjects.size) { previewObjects.clear(); options.previewRevision = (options.previewRevision ?? 0) + 1; }
    if (terrainCells.size) { terrainCells.clear(); for (const [key, version] of terrainChunks) terrainChunks.set(key, version + 1); }
    options.terrainPreview = undefined; options.selectionArea = undefined; invalidate();
  }
  function cancelPointerGesture() {
    rollbackDrag(); gesture = undefined; hoverResize = null; lastPanTime = null; cursor();
    for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    pointers.clear();
  }
  function cancelGesture() { cancelSettingsEdit(); cancelPointerGesture(); }
  function updateDrag(p = gesture ? pointers.get(gesture.pointerId) : undefined) {
    if (!p || !gesture?.object || !gesture.moved || gesture.pinched || gesture.pan) return;
    const position = world(p);
    if (gesture.resize) {
      const object = resizedObject(gesture.resize, position, options.width, WORLD_HEIGHT);
      const initial = gesture.object;
      if (!withinObject(object) || !Number.isFinite(object.scale) || object.scale < MIN_OBJECT_SCALE || object.scale > MAX_OBJECT_SCALE) return;
      if (Math.abs(object.x - initial.x) < 1e-10 && Math.abs(object.y - initial.y) < 1e-10 && Math.abs(object.scale - initial.scale) < 1e-10) {
        previewObjects.delete(object.id); options.previewRevision = (options.previewRevision ?? 0) + 1;
      } else previewObject(object);
      return;
    }
    if (!gesture.grabOffset) return;
    let x = position.x + gesture.grabOffset.x, y = position.y + gesture.grabOffset.y;
    if (gesture.shift) {
      gesture.lockAxis ??= Math.abs(x - gesture.object.x) >= Math.abs(y - gesture.object.y) ? "x" : "y";
      if (gesture.lockAxis === "x") y = gesture.object.y; else x = gesture.object.x;
    } else gesture.lockAxis = undefined;
    if (gesture.members) previewTranslation(gesture.members, x - gesture.object.x, y - gesture.object.y);
    else previewObject({ ...gesture.object, x: Math.max(0, Math.min(scene.width, x)), y: Math.max(0, Math.min(WORLD_HEIGHT, y)) });
  }
  function edgePan(now: number) {
    const p = gesture ? pointers.get(gesture.pointerId) : undefined;
    if (!p || !gesture?.object || !gesture.moved || gesture.pinched || gesture.pan || pointers.size !== 1) { lastPanTime = null; return false; }
    const speed = (position: number, size: number) => {
      const margin = Math.min(72, size * .12);
      return position < margin ? -480 * Math.min(1, (margin - position) / margin)
        : position > size - margin ? 480 * Math.min(1, (position - size + margin) / margin) : 0;
    };
    const dx = gesture.shift && gesture.lockAxis === "y" ? 0 : speed(p.x, screenWidth);
    const dy = gesture.shift && gesture.lockAxis === "x" ? 0 : speed(p.y, screenHeight);
    if (!dx && !dy) { lastPanTime = null; return false; }
    const elapsed = lastPanTime === null ? 1 / 60 : Math.max(0, Math.min(.05, (now - lastPanTime) / 1000)); lastPanTime = now;
    const previousX = cameraX, previousY = cameraY;
    cameraX += dx * elapsed / zoom; cameraY += dy * elapsed / zoom; clamp(); updateDrag(p);
    return cameraX !== previousX || cameraY !== previousY;
  }
  function within(position: Point) { return Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0 && position.x <= options.width && position.y <= WORLD_HEIGHT; }
  function newId() {
    const ids = new Set(scene.planted.map(object => object.id));
    let id: string;
    do { if (nextId >= 1_000_000_000) nextId = 0; id = `planted:${nextId++}`; } while (ids.has(id));
    return id;
  }
  function plant(position: Point) {
    if (!within(position) || !placementAllowed()) return;
    if ((brush === "tree" || brush === "shrub") && !canPlant(position.x, position.y, options.width, scene.terrain)) {
      message = "Деревья и кусты можно добавить на свободную землю, вдали от воды и тропинок."; invalidate(); return;
    }
    if (scene.planted.length >= 5_000) { message = "Достигнут предел 5000 добавленных объектов."; invalidate(); return; }
    const asset = brush === "image" ? scene.assets.find(entry => entry.id === brushAssetId) : null;
    if (brush === "image" && !asset) { message = "Сначала добавь PNG через кнопку «Импорт PNG»."; invalidate(); return; }
    const object: ForestObject = { id: newId(), ...position, layerId: activeLayerId, folderId: activeFolderId, scale: brush === "tree" ? .92 : 1, variant: asset ? 0 : nextId % 24, kind: brush, rotation: 0,
      ...(asset ? { assetId: asset.id, ...imageObjectSize(asset) } : {}) };
    scene.planted.push(object); selectedId = object.id; selectedFolderId = null;
    commit(`Добавлен объект: ${names[brush]}. Его можно выбрать и переместить.`);
  }
  function removeObjectRecord(object: ForestObject) {
    const index = scene.planted.findIndex(entry => entry.id === object.id);
    if (index >= 0) scene.planted.splice(index, 1);
    else if (!scene.removed.includes(object.id)) scene.removed.push(object.id);
    scene.modified = scene.modified.filter(entry => entry.id !== object.id);
    if (selectedId === object.id) selectedId = null;
  }
  function removeObject(object: ForestObject) {
    if (!unlocked(object)) return; removeObjectRecord(object); commit("Объект удалён. Можно вернуть его кнопкой «Отменить».");
  }
  function edit(p: Point) {
    const position = world(p);
    if (mode === "plant") plant(position);
    else if (mode === "erase") {
      const object = pickObject(painter.objects(options), position.x, position.y, scene.layers, scene.folders);
      if (object) removeObject(object); else { message = "Нажми на объект, чтобы удалить его."; invalidate(); }
    }
  }
  function updateSelected(patch: ObjectPatch) {
    cancelGesture();
    const object = selected(); if (!object || !unlocked(object)) return;
    const candidate = { ...object, ...patch };
    if (!withinObject(candidate, object) || !Number.isFinite(candidate.scale) || candidate.scale < MIN_OBJECT_SCALE || candidate.scale > MAX_OBJECT_SCALE
      || !Number.isInteger(candidate.variant) || candidate.variant < 0 || candidate.variant > 23
      || !Number.isFinite(candidate.rotation ?? 0) || (candidate.rotation ?? 0) < -180 || (candidate.rotation ?? 0) > 180) {
      message = "Параметры вне диапазона: координаты внутри карты, масштаб 0,1–8, поворот −180°…180°, вариант 0–23."; invalidate(); return;
    }
    if (["x", "y", "scale", "rotation", "variant"].every(key => candidate[key as keyof ObjectPatch] === object[key as keyof ObjectPatch])) return;
    replaceObject(candidate); commit("Параметры объекта изменены.");
  }
  function sameLighting(a: LightingState, b: LightingState) {
    return Object.keys(a).every(key => key === "points" || a[key as keyof LightingState] === b[key as keyof LightingState])
      && a.points.length === b.points.length && a.points.every((point, index) => Object.keys(point).every(key => point[key as keyof ScenePointLight] === b.points[index][key as keyof ScenePointLight]));
  }
  function beginSettingsEdit() {
    if (disposed || settingsPreview) return;
    cancelPointerGesture(); settingsPreview = { lighting: scene.lighting, terrain: scene.terrain };
  }
  function cancelSettingsEdit() {
    if (!settingsPreview) return;
    if (settingsPreview.shadow) { previewObjects.delete(settingsPreview.shadow.id); options.previewRevision = (options.previewRevision ?? 0) + 1; }
    settingsPreview = null; options.lighting = scene.lighting; options.terrain = scene.terrain; invalidate();
  }
  function commitSettingsEdit() {
    if (!settingsPreview || disposed) return;
    const staged = settingsPreview; let changed = false;
    if (staged.shadow) {
      objectList(); const original = objectLookup.get(staged.shadow.id);
      if (original && !isObjectLocked(original, scene.layers, scene.folders) && original.shadowHeight !== staged.shadow.shadowHeight) { replaceObject(staged.shadow); changed = true; }
    }
    if (!sameLighting(scene.lighting, staged.lighting)) { scene.lighting = staged.lighting; changed = true; }
    const before = terrainAppearance(scene.terrain), after = terrainAppearance(staged.terrain);
    if (Object.keys(before).some(key => before[key as keyof TerrainAppearance] !== after[key as keyof TerrainAppearance])) { scene.terrain = staged.terrain; changed = true; }
    cancelSettingsEdit(); if (changed) commit("Настройки карты изменены. Их можно отменить одним действием.");
  }
  function applyLighting(value: LightingState, text: string) {
    const lighting = validateLighting(value, scene.width);
    if (!lighting) { message = "Проверь параметры света: координаты внутри карты, допустимые яркость и радиус, цвет в формате #RRGGBB."; invalidate(); return false; }
    if (settingsPreview) { if (!sameLighting(settingsPreview.lighting, lighting)) { settingsPreview.lighting = lighting; options.lighting = lighting; invalidate(); } }
    else { cancelPointerGesture(); if (!sameLighting(scene.lighting, lighting)) { scene.lighting = lighting; commit(text); } }
    return true;
  }
  function setLighting(patch: Partial<Omit<LightingState, "points">>) {
    if (disposed || !patch || Object.hasOwn(patch, "points")) return false;
    return applyLighting({ ...(settingsPreview?.lighting ?? scene.lighting), ...patch }, "Освещение изменено.");
  }
  function addPointLight() {
    if (disposed) return null;
    cancelGesture(); if (scene.lighting.points.length >= MAX_POINT_LIGHTS) { message = "В сцене может быть до 32 источников света."; invalidate(); return null; }
    let number = 1; while (scene.lighting.points.some(point => point.id === `light:${number}`)) number++;
    const object = selected(), id = `light:${number}`;
    const point: ScenePointLight = { id, name: `Свет ${number}`, x: Math.max(0, Math.min(scene.width, object?.x ?? cameraX)),
      y: Math.max(0, Math.min(WORLD_HEIGHT, object?.y ?? cameraY)), radius: 240, intensity: 1, color: "#ffe5ad", enabled: true };
    return applyLighting({ ...scene.lighting, enabled: true, points: [...scene.lighting.points, point] }, "Добавлен источник света.") ? id : null;
  }
  function updatePointLight(id: string, patch: Partial<Omit<ScenePointLight, "id">>) {
    if (disposed || !patch || Object.hasOwn(patch, "id")) return false;
    const lighting = settingsPreview?.lighting ?? scene.lighting;
    if (!lighting.points.some(point => point.id === id)) return false;
    const changes = { ...patch }; if (typeof changes.name === "string") changes.name = cleanName(changes.name);
    return applyLighting({ ...lighting, points: lighting.points.map(point => point.id === id ? { ...point, ...changes } : point) }, "Источник света изменён.");
  }
  function deletePointLight(id: string) {
    if (disposed) return false;
    cancelGesture(); if (!scene.lighting.points.some(point => point.id === id)) return false;
    return applyLighting({ ...scene.lighting, points: scene.lighting.points.filter(point => point.id !== id) }, "Источник света удалён.");
  }
  function setSelectedShadowHeight(value: number | undefined) {
    if (disposed || (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 480))) return false;
    if (!settingsPreview) cancelPointerGesture();
    const object = selected(); if (!object || !unlocked(object)) return false;
    const candidate = { ...object }; if (value === undefined) delete candidate.shadowHeight; else candidate.shadowHeight = value;
    if (candidate.shadowHeight === object.shadowHeight) return true;
    if (settingsPreview) { settingsPreview.shadow = candidate; previewObject(candidate); invalidate(); }
    else { replaceObject(candidate); commit("Высота тени предмета изменена."); }
    return true;
  }
  function setTerrainAppearance(patch: Partial<TerrainAppearance>) {
    if (disposed || !patch) return false;
    const current = settingsPreview?.terrain ?? scene.terrain, terrain = updateTerrainAppearance(current, patch);
    if (terrain === current) return false;
    if (settingsPreview) { settingsPreview.terrain = terrain; options.terrain = terrain; invalidate(); }
    else { cancelPointerGesture(); scene.terrain = terrain; commit("Вид земли и берегов изменён."); }
    return true;
  }
  function undo() {
    cancelGesture(); const previous = history.undo(); if (!previous) return;
    scene = previous; revision++; sync(); if (!selected()) selectedId = null; save(); message = "Последнее изменение отменено."; prepareCurrentAssets(); cursor(); invalidate();
  }
  function redo() {
    cancelGesture(); const next = history.redo(); if (!next) return;
    scene = next; revision++; sync(); if (!selected()) selectedId = null; save(); message = "Изменение повторено."; prepareCurrentAssets(); cursor(); invalidate();
  }
  function setMode(value: ToolMode) {
    cancelGesture(); mode = value; if (value !== "terrain") options.brushCursor = undefined; if (value === "plant" && (brush === "tree" || brush === "shrub")) options.trees = true; cursor();
    message = value === "pan" ? "Перетаскивай карту или используй стрелки."
      : value === "select" ? "Нажми на любой объект, затем перетащи его или измени параметры."
      : value === "plant" ? `Нажми на карту, чтобы добавить объект: ${names[brush]}.` : value === "area" ? "Обведи область, чтобы собрать предметы в новую папку." : value === "terrain" ? "Рисуй землю кистью. Отмена вернёт весь мазок." : "Нажми на любой объект, чтобы удалить его.";
    invalidate();
  }
  function setBrush(value: ObjectKind) {
    if (!Object.hasOwn(names, value)) return;
    if (value === "image" && !scene.assets.some(asset => asset.id === brushAssetId)) { controllerOptions.requestPngImport?.(); return; }
    brush = value; if (value !== "image") brushAssetId = null;
    if (value === "tree" || value === "shrub") options.trees = true;
    message = `Выбран объект для добавления: ${names[value]}.`; invalidate();
  }
  function setImageBrush(id: string) {
    const asset = scene.assets.find(entry => entry.id === id); if (!asset) return false;
    brushAssetId = id; brush = "image"; setMode("plant"); message = `Нажми на карту, чтобы добавить PNG: ${asset.name}.`; invalidate(); return true;
  }
  function assetError(error: unknown) { return error instanceof Error ? error.message : "Не удалось прочитать изображение."; }
  function prepareCurrentAssets() {
    const before = revision, token = sceneImportToken;
    void painter.prepareAssets(scene.assets).then(() => { if (!disposed) invalidate(); }).catch(error => {
      if (!disposed && before === revision && token === sceneImportToken) { message = `Не удалось открыть PNG: ${assetError(error)}`; invalidate(); }
    });
  }
  async function addPngAsset(value: ImageAsset): Promise<boolean> {
    const before = revision, token = sceneImportToken;
    if (disposed || !placementAllowed("image")) return false;
    const asset = validateImageAsset(value);
    if (!asset) { if (!disposed) { message = "Не удалось добавить PNG: неверный файл или параметры изображения."; invalidate(); } return false; }
    const mergeAssets = () => {
      const existing = scene.assets.find(entry => entry.id === asset.id);
      return existing && existing.dataUrl !== asset.dataUrl ? null : existing ? scene.assets : [...scene.assets, asset];
    };
    const staged = mergeAssets();
    if (!staged || !validateScene({ ...scene, assets: staged })) { message = "Не удалось добавить PNG: превышен размер сцены или лимит изображений."; invalidate(); return false; }
    try { await painter.prepareAssets(staged); } catch (error) {
      if (!disposed && before === revision && token === sceneImportToken) { message = `Не удалось открыть PNG: ${assetError(error)}`; invalidate(); } return false;
    }
    if (disposed || !placementAllowed("image")) return false;
    cancelGesture();
    const assets = mergeAssets();
    if (!assets || scene.planted.length >= 5_000) { message = "Не удалось добавить PNG: достигнут лимит объектов или изображений."; invalidate(); return false; }
    const size = imageObjectSize(asset);
    const object: ForestObject = { id: newId(), kind: "image", assetId: asset.id, ...size, layerId: activeLayerId, folderId: activeFolderId,
      x: Math.max(0, Math.min(scene.width, cameraX)), y: Math.max(0, Math.min(WORLD_HEIGHT, cameraY + size.imageHeight / 2)), scale: 1, rotation: 0, variant: 0 };
    const appended = validateScene({ ...scene, assets, planted: [...scene.planted, object] });
    if (!appended) { message = "Не удалось добавить PNG: превышен размер сцены или лимит изображений."; invalidate(); return false; }
    scene = appended; selectedId = object.id; selectedFolderId = null; brush = "image"; brushAssetId = asset.id; mode = "select"; cursor();
    commit(`Добавлен PNG: ${asset.name}. Перетаскивай картинку или тяни за угол.`); return true;
  }
  async function importPng(file: File): Promise<boolean> {
    const before = revision, token = sceneImportToken;
    if (disposed || !placementAllowed("image")) return false;
    try { return await addPngAsset(await readPngFile(file)); } catch (error) {
      if (!disposed && before === revision && token === sceneImportToken) { message = `Не удалось добавить PNG: ${assetError(error)}`; invalidate(); } return false;
    }
  }
  function duplicateSelected() {
    cancelGesture(); const object = selected(); if (!object || !unlocked(object) || scene.planted.length >= 5_000) return;
    if (!isObjectVisible({ ...object, hidden: false }, scene.layers, scene.folders)) { message = "Сначала покажи слой, чтобы добавить на него копию."; invalidate(); return; }
    let position: Point | undefined;
    for (const offset of [40, -40, 80, -80, 120, -120]) {
      const candidate = { x: Math.max(0, Math.min(options.width, object.x + offset)), y: Math.max(0, Math.min(WORLD_HEIGHT, object.y + 30)) };
      if ((object.kind !== "tree" && object.kind !== "shrub") || canPlant(candidate.x, candidate.y, options.width, scene.terrain)) { position = candidate; break; }
    }
    if (!position) { message = "Рядом нет свободной земли для копии. Добавь объект в другом месте."; invalidate(); return; }
    const copy = { ...object, ...position, id: newId(), hidden: false, locked: false }; delete copy.stackOrder;
    scene.planted.push(copy); selectedId = copy.id; activeLayerId = objectLayerId(copy); commit("Копия добавлена и выбрана.");
  }
  function layerObjects(id: string, excluded?: string) { return allObjects().filter(object => objectLayerId(object) === id && object.id !== excluded).sort((a, b) => compareObjects(a, b, scene.layers)); }
  function orderAt(object: ForestObject, layerId: string, index: number, siblings: ForestObject[]) {
    const placed = { ...object, layerId };
    try {
      placed.stackOrder = stackKeyBetween(siblings[index - 1] ? stackKey(siblings[index - 1]) : undefined, siblings[index] ? stackKey(siblings[index]) : undefined);
      replaceObject(placed);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const ordered = [...siblings]; ordered.splice(index, 0, placed);
      ordered.forEach((entry, rank) => replaceObject({ ...entry, stackOrder: [rank] }));
    }
  }
  function selectById(id: string) {
    cancelGesture(); const object = allObjects().find(entry => entry.id === id); selectedId = object?.id ?? null;
    selectedFolderId = null; if (object) { mode = "select"; options.brushCursor = undefined; activeLayerId = objectLayerId(object); activeFolderId = objectFolderId(object, scene.folders); message = "Объект выбран. Перетащи его или измени параметры справа."; } cursor(); invalidate(); return !!object;
  }
  function setActiveLayer(id: string) {
    if (!scene.layers.some(layer => layer.id === id)) return false;
    cancelGesture(); activeLayerId = id; invalidate(); return true;
  }
  function addLayer() {
    cancelGesture(); if (scene.layers.length >= 32) { message = "В сцене может быть до 32 слоёв."; invalidate(); return null; }
    let number = 1; while (scene.layers.some(layer => layer.id === `layer:${number}`)) number++;
    const id = `layer:${number}`;
    scene.layers = [...scene.layers, { id, name: `Слой ${number}`, visible: true, locked: false }]; activeLayerId = id;
    commit("Добавлен новый слой. Новые объекты появятся на нём."); return id;
  }
  function cleanName(value: string) { return value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100).trim(); }
  function renameLayer(id: string, value: string) {
    cancelGesture(); const name = cleanName(value), layer = scene.layers.find(entry => entry.id === id);
    if (!name || !layer || name === layer.name) return;
    scene.layers = scene.layers.map(entry => entry.id === id ? { ...entry, name } : entry); commit("Название слоя изменено.");
  }
  function moveLayer(id: string, direction: "forward" | "backward") {
    cancelGesture(); const index = scene.layers.findIndex(entry => entry.id === id), target = index + (direction === "forward" ? 1 : -1);
    if (index < 0 || target < 0 || target >= scene.layers.length) return;
    const layers = [...scene.layers]; [layers[index], layers[target]] = [layers[target], layers[index]]; scene.layers = layers;
    commit("Порядок слоёв изменён.");
  }
  function deleteLayer(id: string) {
    cancelGesture(); const layer = scene.layers.find(entry => entry.id === id); if (id === "world" || !layer) return;
    const incoming = layerObjects(id), existing = layerObjects("world");
    if (!membersUnlocked(incoming)) return;
    if (layer.locked || (incoming.length > 0 && scene.layers.find(entry => entry.id === "world")?.locked)) {
      message = layer.locked ? "Сначала сними замок удаляемого слоя." : "Сначала сними замок слоя «Мир», чтобы перенести в него объекты."; invalidate(); return;
    }
    if (!existing.length) incoming.forEach(object => replaceObject({ ...object, layerId: "world" }));
    else if (incoming.length) {
      const behind = scene.layers.findIndex(layer => layer.id === id) < scene.layers.findIndex(layer => layer.id === "world");
      const merged = behind ? [...incoming, ...existing] : [...existing, ...incoming];
      try {
        let lower = behind ? undefined : stackKey(existing.at(-1)!);
        const upper = behind ? stackKey(existing[0]) : undefined;
        const reassignments = incoming.map(object => { const key = stackKeyBetween(lower, upper); lower = key; return { ...object, layerId: "world", stackOrder: key }; });
        reassignments.forEach(replaceObject);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        merged.forEach((object, index) => replaceObject({ ...object, layerId: "world", stackOrder: [index] }));
      }
    }
    scene.layers = scene.layers.filter(layer => layer.id !== id); if (activeLayerId === id) activeLayerId = "world";
    commit("Слой удалён. Все его объекты перенесены в слой «Мир».");
  }
  function setLayerVisibility(id: string, visible: boolean) {
    cancelGesture(); const layer = scene.layers.find(entry => entry.id === id); if (!layer || layer.visible === visible) return;
    scene.layers = scene.layers.map(entry => entry.id === id ? { ...entry, visible } : entry); commit(visible ? "Слой показан." : "Слой скрыт."); cursor();
  }
  function setLayerLocked(id: string, locked: boolean) {
    cancelGesture(); const layer = scene.layers.find(entry => entry.id === id); if (!layer || layer.locked === locked) return;
    scene.layers = scene.layers.map(entry => entry.id === id ? { ...entry, locked } : entry); commit(locked ? "Слой заблокирован." : "Замок слоя снят."); cursor();
  }
  function renameSelected(value: string) {
    cancelGesture(); const object = selected(); if (!object) return;
    const name = cleanName(value); if ((object.name ?? "") === name) return;
    const renamed = { ...object }; if (name) renamed.name = name; else delete renamed.name;
    replaceObject(renamed); commit("Название объекта изменено.");
  }
  function setObjectHidden(id: string, hidden: boolean) {
    cancelGesture(); const object = allObjects().find(entry => entry.id === id); if (!object || !!object.hidden === hidden) return;
    replaceObject({ ...object, hidden }); commit(hidden ? "Объект скрыт." : "Объект показан."); cursor();
  }
  function setObjectLocked(id: string, locked: boolean) {
    cancelGesture(); const object = allObjects().find(entry => entry.id === id); if (!object || !!object.locked === locked) return;
    replaceObject({ ...object, locked }); commit(locked ? "Объект заблокирован." : "Замок объекта снят."); cursor();
  }
  function setSelectedLayer(id: string) {
    cancelGesture(); const object = selected(), target = scene.layers.find(layer => layer.id === id);
    if (!object || !target || objectLayerId(object) === id || !unlocked(object)) return;
    if (target.locked) { message = "Сначала сними замок целевого слоя."; invalidate(); return; }
    const siblings = layerObjects(id, object.id); orderAt(object, id, siblings.length, siblings); activeLayerId = id; commit("Объект перенесён на другой слой.");
  }
  function setSelectedOrder(action: "front" | "back" | "forward" | "backward" | "auto") {
    cancelGesture(); const object = selected(); if (!object || !unlocked(object)) return;
    if (action === "auto") {
      if (!object.stackOrder) return; const automatic = { ...object }; delete automatic.stackOrder; replaceObject(automatic); commit("Автоматический порядок по положению восстановлен."); return;
    }
    const id = objectLayerId(object), ordered = layerObjects(id), index = ordered.findIndex(entry => entry.id === object.id);
    const next = action === "front" ? ordered.length - 1 : action === "back" ? 0 : action === "forward" ? Math.min(ordered.length - 1, index + 1) : Math.max(0, index - 1);
    if (index === next && (object.stackOrder || (action !== "front" && action !== "back"))) return;
    orderAt(object, id, next, ordered.filter(entry => entry.id !== object.id)); commit("Порядок объекта изменён.");
  }
  function reorderObject(id: string, targetId: string, position: "before" | "after") {
    cancelGesture(); if (id === targetId) return;
    const objects = allObjects(), object = objects.find(entry => entry.id === id), target = objects.find(entry => entry.id === targetId);
    if (!object || !target || !unlocked(object)) return;
    const layerId = objectLayerId(target); if (isObjectLocked(target, scene.layers, scene.folders)) { message = "Сначала сними замок целевого слоя."; invalidate(); return; }
    const siblings = layerObjects(layerId, id), targetIndex = siblings.findIndex(entry => entry.id === targetId), index = targetIndex + (position === "before" ? 1 : 0);
    const folderId = objectFolderId(target, scene.folders);
    if (objectLayerId(object) === layerId && objectFolderId(object, scene.folders) === folderId && layerObjects(layerId).findIndex(entry => entry.id === id) === index) return;
    orderAt({ ...object, folderId }, layerId, index, siblings); selectedId = id; activeLayerId = layerId; commit("Объект перемещён в списке.");
  }
  function areaBounds(from: Point, to: Point): Bounds { return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(from.x - to.x), height: Math.abs(from.y - to.y) }; }
  function createFolderFromArea(bounds: Bounds) {
    cancelGesture();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
    const objects = allObjects().filter(object => canvasEditable(object) && object.x >= bounds.x && object.x <= bounds.x + bounds.width && object.y >= bounds.y && object.y <= bounds.y + bounds.height);
    if (!objects.length || scene.folders.length >= MAX_SCENE_FOLDERS) { message = "В области нет доступных предметов или достигнут предел папок."; invalidate(); return null; }
    const parentId = activeFolderId && isFolderVisible(activeFolderId, scene.folders) && !isFolderLocked(activeFolderId, scene.folders) ? activeFolderId : null;
    let number = 1; while (scene.folders.some(folder => folder.id === `folder:${number}`)) number++;
    const id = `folder:${number}`;
    scene.folders = [...scene.folders, { id, name: `Группа ${number}`, parentId, visible: true, locked: false }];
    for (const object of objects) replaceObject({ ...object, folderId: id });
    selectedId = null; selectedFolderId = id; activeFolderId = id; mode = "select"; commit("Предметы области собраны в папку."); cursor(); return id;
  }
  function folderDestinationAllowed(id: string | null) {
    if (id !== null && !scene.folders.some(folder => folder.id === id)) return false;
    if (isFolderLocked(id, scene.folders)) { message = "Сначала сними замок целевой папки."; invalidate(); return false; }
    return true;
  }
  function setActiveFolder(id: string | null | undefined) {
    if (id !== undefined && id !== null && !scene.folders.some(folder => folder.id === id)) return false;
    cancelGesture(); activeFolderId = id; invalidate(); return true;
  }
  function selectFolder(id: string | null) {
    if (id !== null && !scene.folders.some(folder => folder.id === id)) return false;
    cancelGesture(); selectedFolderId = id; selectedId = null; if (id) { mode = "select"; options.brushCursor = undefined; activeFolderId = id; message = "Папка выбрана. Её предметами можно управлять справа."; } cursor(); invalidate(); return true;
  }
  function addFolder(parentId: string | null = null) {
    cancelGesture(); if (scene.folders.length >= MAX_SCENE_FOLDERS || !folderDestinationAllowed(parentId)) return null;
    let number = 1; while (scene.folders.some(folder => folder.id === `folder:${number}`)) number++;
    const id = `folder:${number}`;
    scene.folders = [...scene.folders, { id, name: `Папка ${number}`, parentId, visible: true, locked: false }];
    selectedFolderId = id; selectedId = null; activeFolderId = id; mode = "select"; options.brushCursor = undefined; commit("Добавлена папка. Новые предметы появятся в ней."); cursor(); return id;
  }
  function renameFolder(id: string, value: string) {
    cancelGesture(); const folder = scene.folders.find(entry => entry.id === id), name = cleanName(value);
    if (!folder || !name || folder.name === name) return;
    scene.folders = scene.folders.map(entry => entry.id === id ? { ...entry, name } : entry); commit("Название папки изменено.");
  }
  function setFolderVisibility(id: string, visible: boolean) {
    cancelGesture(); const folder = scene.folders.find(entry => entry.id === id); if (!folder || folder.visible === visible) return;
    scene.folders = scene.folders.map(entry => entry.id === id ? { ...entry, visible } : entry); commit(visible ? "Папка показана." : "Папка скрыта."); cursor();
  }
  function setFolderLocked(id: string, locked: boolean) {
    cancelGesture(); const folder = scene.folders.find(entry => entry.id === id); if (!folder || folder.locked === locked) return;
    scene.folders = scene.folders.map(entry => entry.id === id ? { ...entry, locked } : entry); commit(locked ? "Папка заблокирована." : "Замок папки снят."); cursor();
  }
  function subtreeLocked(id: string) { return scene.folders.some(folder => folder.locked && folderContains(id, folder.id, scene.folders)); }
  function reparentFolder(id: string, parentId: string | null) {
    cancelGesture(); const folder = scene.folders.find(entry => entry.id === id); if (!folder || folder.parentId === parentId || folderContains(id, parentId, scene.folders)) return;
    if (isFolderLocked(id, scene.folders) || subtreeLocked(id) || !folderDestinationAllowed(parentId) || !membersUnlocked(folderObjects(id))) { message = "Сначала сними замки папки и её предметов."; invalidate(); return; }
    scene.folders = scene.folders.map(entry => entry.id === id ? { ...entry, parentId } : entry); commit("Папка перенесена.");
  }
  function deleteFolder(id: string) {
    cancelGesture(); const folder = scene.folders.find(entry => entry.id === id); if (!folder) return;
    if (isFolderLocked(id, scene.folders) || subtreeLocked(id) || !folderDestinationAllowed(folder.parentId) || !membersUnlocked(folderObjects(id))) { message = "Сначала сними замки папки и её предметов."; invalidate(); return; }
    for (const object of allObjects()) if (objectFolderId(object, scene.folders) === id) replaceObject({ ...object, folderId: folder.parentId });
    scene.folders = scene.folders.filter(entry => entry.id !== id).map(entry => entry.parentId === id ? { ...entry, parentId: folder.parentId } : entry);
    if (activeFolderId === id) activeFolderId = folder.parentId; if (selectedFolderId === id) selectedFolderId = null;
    commit("Папка удалена. Её предметы и вложенные папки сохранены.");
  }
  function moveObjectToFolder(id: string, folderId: string | null | undefined) {
    cancelGesture(); const object = allObjects().find(entry => entry.id === id); if (!object || !unlocked(object)) return;
    const moved = { ...object }; if (folderId === undefined) delete moved.folderId; else moved.folderId = folderId;
    if (!folderDestinationAllowed(objectFolderId(moved, scene.folders)) || object.folderId === moved.folderId) return;
    replaceObject(moved); if (selectedId === id) activeFolderId = folderId; commit("Предмет перенесён в папку.");
  }
  function translateSelectedFolder(dx: number, dy: number) {
    cancelGesture(); if (!selectedFolderId || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const members = folderObjects(selectedFolderId); if (isFolderLocked(selectedFolderId, scene.folders) || !membersUnlocked(members)) return;
    for (const object of translatedObjects(members, dx, dy)) { const original = objectLookup.get(object.id); if (original && (original.x !== object.x || original.y !== object.y)) replaceObject(object); } commit("Папка перемещена.");
  }
  function deleteFolderObjects(id: string) {
    cancelGesture(); const members = folderObjects(id);
    if (!scene.folders.some(folder => folder.id === id) || isFolderLocked(id, scene.folders) || !membersUnlocked(members)) return;
    for (const object of members) removeObjectRecord(object); commit("Предметы папки удалены. Их можно вернуть кнопкой «Отменить».");
  }
  function setTerrainBrush(value: TerrainBrush) {
    if (!["grass", "path", "sand", "water", "restore"].includes(value)) return;
    cancelGesture(); terrainBrush = value; invalidate();
  }
  function setTerrainSize(value: number) { if (!Number.isFinite(value)) return; cancelGesture(); terrainSize = Math.max(24, Math.min(320, value)); if (options.brushCursor) options.brushCursor = { ...options.brushCursor, diameter: terrainSize }; invalidate(); }
  function setClearVegetation(value: boolean) { cancelGesture(); clearVegetation = value; invalidate(); }
  function setBaseTrails(value: boolean) { cancelGesture(); if (scene.terrain.baseTrails === value) return; scene.terrain = { ...scene.terrain, baseTrails: value }; commit(value ? "Исходные тропы показаны." : "Исходные тропы скрыты."); }
  function focusSelected() {
    cancelGesture(); const object = selected();
    const bounds = selectedFolderId ? folderSummary()?.bounds : object ? objectBounds(object) : null; if (!bounds) return; cameraX = bounds.x + bounds.width / 2; cameraY = bounds.y + bounds.height / 2;
    zoom = Math.min(2.5, screenWidth * .72 / Math.max(1, bounds.width), screenHeight * .72 / Math.max(1, bounds.height)); clamp(); invalidate();
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    cancelSettingsEdit();
    if (event.button === 1) event.preventDefault();
    canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    const p = point(event.clientX, event.clientY); pointers.set(event.pointerId, p);
    if (pointers.size === 1) {
      const transient = spaceHeld || event.button === 1;
      gesture = { start: p, moved: false, pinched: false, pan: mode === "pan" || transient, temporaryPan: transient, pointerId: event.pointerId, shift: event.shiftKey };
      const position = world(p), current = selected();
      const corner = current && canvasEditable(current) && !gesture.pan && mode !== "terrain" && mode !== "area" ? findResizeHandle(current, position, zoom, event.pointerType === "touch" ? 22 : 14) : null;
      if (mode === "terrain" && !gesture.pan) {
        gesture.terrainLast = position; paintTerrain(position);
      } else if (mode === "area" && !gesture.pan) {
        gesture.areaStart = position; options.selectionArea = { ...position, width: 0, height: 0 };
      } else if (current && corner !== null) {
        activeLayerId = objectLayerId(current);
        gesture.object = { ...current }; gesture.resize = beginResize(current, corner, position); hoverResize = corner; mode = "select";
        message = "Тяни за угол, чтобы изменить размер. Пропорции картинки сохраняются.";
      } else if (mode === "select" && !gesture.pan) {
        const object = pickObject(painter.objects(options), position.x, position.y, scene.layers, scene.folders);
        if (object && selectedFolderId && folderContains(selectedFolderId, objectFolderId(object, scene.folders), scene.folders)) {
          const members = folderObjects(selectedFolderId);
          if (membersUnlocked(members)) { gesture.object = { ...object }; gesture.members = members; gesture.grabOffset = { x: object.x - position.x, y: object.y - position.y }; message = "Перетаскивай папку целиком."; } else gesture.blocked = true;
        } else {
          selectedFolderId = null; selectedId = object?.id ?? null; options.selectedId = selectedId;
          if (object) { activeLayerId = objectLayerId(object); activeFolderId = objectFolderId(object, scene.folders); gesture.object = { ...object }; gesture.grabOffset = { x: object.x - position.x, y: object.y - position.y }; message = "Объект выбран. Перетащи его или измени параметры справа."; }
          else { gesture.pan = true; message = "Перетаскивай пустое место для перемещения карты."; }
        }
      }
    } else if (gesture) {
      rollbackDrag(); gesture.object = undefined; gesture.grabOffset = undefined; gesture.resize = undefined; gesture.members = undefined; gesture.terrainLast = undefined; gesture.areaStart = undefined; gesture.pinched = true; hoverResize = null; lastPanTime = null;
    }
    cursor(); invalidate();
  };
  const move = (event: PointerEvent) => {
    const p = point(event.clientX, event.clientY);
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      const current = selected(), object = current && canvasEditable(current) && !temporaryPan() && mode !== "pan" && mode !== "terrain" && mode !== "area" ? current : null;
      hoverResize = object ? findResizeHandle(object, world(p), zoom, event.pointerType === "touch" ? 22 : 14) : null;
      if (mode === "terrain") { options.brushCursor = { ...world(p), diameter: terrainSize }; invalidate(); } cursor(); return;
    }
    if (gesture) gesture.shift = event.shiftKey;
    if (gesture && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 3) gesture.moved = true;
    if (pointers.size >= 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const distance = Math.hypot(previous.x - other.x, previous.y - other.y), next = Math.hypot(p.x - other.x, p.y - other.y);
        if (distance > 5 && next > 5) {
          zoomAt(next / distance, { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 });
          cameraX -= (p.x - previous.x) / (2 * zoom); cameraY -= (p.y - previous.y) / (2 * zoom); invalidate();
        }
      }
    } else if (gesture?.terrainLast && !gesture.pinched && !gesture.pan) {
      paintTerrain(world(p));
    } else if (gesture?.areaStart && !gesture.pinched && !gesture.pan) {
      options.selectionArea = areaBounds(gesture.areaStart, world(p)); invalidate();
    } else if (gesture?.object && !gesture.pinched && !gesture.pan) {
      updateDrag(p); invalidate();
    } else if (!gesture?.blocked) { cameraX -= (p.x - previous.x) / zoom; cameraY -= (p.y - previous.y) / zoom; invalidate(); }
    pointers.set(event.pointerId, p);
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const finishing = pointers.size === 1;
    if (event.type !== "pointerup") {
      rollbackDrag(); if (gesture) { gesture.pinched = true; gesture.object = undefined; gesture.resize = undefined; gesture.members = undefined; gesture.terrainLast = undefined; gesture.areaStart = undefined; } hoverResize = null;
    } else if (finishing && gesture && !gesture.pinched) {
      if (gesture.terrainLast) { paintTerrain(world(point(event.clientX, event.clientY))); commitGesture(); }
      else if (gesture.areaStart) { const bounds = areaBounds(gesture.areaStart, world(point(event.clientX, event.clientY))); rollbackDrag(); createFolderFromArea(bounds); }
      else if (gesture.object && gesture.moved) { updateDrag(point(event.clientX, event.clientY)); commitGesture(); }
      else if (!gesture.moved && !gesture.pan && mode !== "pan" && mode !== "select") edit(point(event.clientX, event.clientY));
    }
    pointers.delete(event.pointerId); if (!pointers.size) { gesture = undefined; hoverResize = null; lastPanTime = null; }
    cursor(); invalidate();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const wheel = (event: WheelEvent) => { event.preventDefault(); zoomAt(Math.exp(-event.deltaY * .0015), point(event.clientX, event.clientY)); };
  function textInput(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    return !!element && (!!element.closest?.("input, textarea, select") || element.isContentEditable);
  }
  function physicalCode(event: KeyboardEvent) {
    if (event.code) return event.code;
    if (event.key === " ") return "Space";
    if (event.key === "[" || event.key === "]") return event.key === "[" ? "BracketLeft" : "BracketRight";
    if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
    if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
    return event.key;
  }
  const key = (event: KeyboardEvent) => {
    if (!event.target || !editor.contains(event.target as Node) || textInput(event.target) || event.altKey) return;
    const command = event.ctrlKey || event.metaKey, code = physicalCode(event);
    if (command && code === "KeyZ") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (command && code === "KeyY") { event.preventDefault(); redo(); return; }
    if (command && code === "KeyD") { event.preventDefault(); if (!event.repeat) duplicateSelected(); return; }
    if (command && (code === "BracketLeft" || code === "BracketRight")) {
      event.preventDefault(); if (!event.repeat) setSelectedOrder(code === "BracketRight" ? event.shiftKey ? "front" : "forward" : event.shiftKey ? "back" : "backward"); return;
    }
    if (command) return;
    if (code === "KeyF") { event.preventDefault(); if (!event.repeat) focusSelected(); return; }
    if (code === "KeyL") { event.preventDefault(); if (!event.repeat) controllerOptions.requestLayersToggle?.(); return; }
    if (event.key === "Shift") { if (gesture) { gesture.shift = true; updateDrag(); invalidate(); } return; }
    if (code === "Space") {
      event.preventDefault();
      if (!spaceHeld) {
        cancelSettingsEdit(); rollbackDrag(); spaceHeld = true;
        if (gesture) { gesture.object = undefined; gesture.grabOffset = undefined; gesture.resize = undefined; gesture.members = undefined; gesture.terrainLast = undefined; gesture.areaStart = undefined; gesture.pan = true; gesture.temporaryPan = true; lastPanTime = null; }
        hoverResize = null;
        cursor(); invalidate();
      }
      return;
    }
    const tools: Partial<Record<string, ToolMode>> = { KeyV: "select", KeyH: "pan", KeyB: "plant", KeyE: "erase", KeyT: "terrain", KeyR: "area" };
    if (tools[code]) { event.preventDefault(); if (!event.repeat) { setMode(tools[code]); if (code === "KeyT") controllerOptions.requestTerrainTools?.(); } return; }
    if (code === "Digit7" || code === "Numpad7") { event.preventDefault(); if (!event.repeat) controllerOptions.requestPngImport?.(); return; }
    const digit = /^(?:Digit|Numpad)([1-6])$/.exec(code);
    if (digit) {
      event.preventDefault();
      if (!event.repeat) { setBrush((["tree", "shrub", "rock", "ruins", "bridge", "jetty"] as const)[Number(digit[1]) - 1]); setMode("plant"); }
      return;
    }
    if (event.key === "Enter" && event.target !== canvas) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Enter", "Delete", "Backspace", "Escape"].includes(event.key)) event.preventDefault();
    if (event.key === "Delete" || event.key === "Backspace") { cancelGesture(); const object = selected(); if (object) removeObject(object); return; }
    if (event.key === "Escape") { cancelGesture(); selectedId = null; selectedFolderId = null; invalidate(); return; }
    const object = mode === "select" && !temporaryPan() ? selected() : null;
    const delta = event.shiftKey ? 10 : 1;
    if (selectedFolderId && mode === "select" && !temporaryPan() && event.key.startsWith("Arrow")) {
      translateSelectedFolder(event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0, event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0); return;
    }
    if (object && event.key.startsWith("Arrow")) {
      updateSelected({ x: Math.max(0, Math.min(options.width, object.x + (event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0))),
        y: Math.max(0, Math.min(WORLD_HEIGHT, object.y + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0))) }); return;
    }
    if (event.key === "ArrowLeft") cameraX -= 80 / zoom;
    if (event.key === "ArrowRight") cameraX += 80 / zoom;
    if (event.key === "ArrowUp") cameraY -= 80 / zoom;
    if (event.key === "ArrowDown") cameraY += 80 / zoom;
    if (event.key === "+" || event.key === "=") zoomAt(1.2);
    if (event.key === "-") zoomAt(1 / 1.2);
    if (event.key === "0") { cancelGesture(); fit(); }
    if (event.key === "Enter" && !temporaryPan() && (mode === "plant" || mode === "erase")) edit({ x: screenWidth / 2, y: screenHeight / 2 });
    invalidate();
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.key === "Shift") { if (gesture) { gesture.shift = false; gesture.lockAxis = undefined; updateDrag(); invalidate(); } return; }
    if (physicalCode(event) !== "Space" || !spaceHeld) return;
    spaceHeld = false; cursor(); invalidate();
  };
  const blur = () => { spaceHeld = false; cancelGesture(); cursor(); invalidate(); };
  const auxiliary = (event: MouseEvent) => { if (event.button === 1) event.preventDefault(); };
  const leave = () => { if (!pointers.size) { hoverResize = null; options.brushCursor = undefined; cursor(); invalidate(); } };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up); canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("auxclick", auxiliary); editor.addEventListener("keydown", key);
  window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
  const flushSave = () => { autosave.flush(); };
  const visibility = () => { if (document.visibilityState === "hidden") flushSave(); };
  window.addEventListener("pagehide", flushSave); window.addEventListener("beforeunload", flushSave); document.addEventListener?.("visibilitychange", visibility);
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  if (document.body && document.activeElement === document.body) editor.focus({ preventScroll: true });
  prepareCurrentAssets();

  function download(blob: Blob, filename: string) {
    if (disposed) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    fit, zoom: zoomAt, updateSelected, undo, redo, setMode, setBrush, setImageBrush, duplicateSelected, importPng, addPngAsset,
    selectById, setActiveLayer, addLayer, renameLayer, moveLayer, deleteLayer, setLayerVisibility, setLayerLocked,
    renameSelected, setSelectedLayer, setObjectHidden, setObjectLocked, setSelectedOrder, reorderObject, focusSelected,
    setActiveFolder, selectFolder, addFolder, renameFolder, reparentFolder, deleteFolder, moveObjectToFolder,
    setFolderVisibility, setFolderLocked, translateSelectedFolder, deleteFolderObjects, createFolderFromArea,
    setTerrainBrush, setTerrainSize, setClearVegetation, setBaseTrails,
    setLighting, addPointLight, updatePointLight, deletePointLight, setSelectedShadowHeight, setTerrainAppearance,
    beginSettingsEdit, commitSettingsEdit, cancelSettingsEdit, flushPendingSave: autosave.flush,
    clearSelection() { cancelGesture(); selectedId = null; selectedFolderId = null; invalidate(); },
    deleteSelected() { cancelGesture(); const object = selected(); if (object) removeObject(object); },
    setLayer(layer: "trees" | "grid", value: boolean) {
      cancelGesture(); options[layer] = value;
      invalidate();
    },
    expand() { cancelGesture(); if (scene.width >= MAX_WIDTH) return; scene.width += 800; commit("Добавлено 800 единиц справа. Все твои объекты сохранились."); fit(); },
    regenerate() {
      cancelGesture(); scene = { version: 5, seed: (scene.seed + 137) % 2_147_483_648, width: scene.width, planted: [], removed: [], modified: [], assets: scene.assets, layers: scene.layers, folders: scene.folders, terrain: scene.terrain, lighting: scene.lighting };
      selectedId = null; selectedFolderId = null; commit("Создан новый лес. Прежний вариант можно вернуть кнопкой «Отменить».");
    },
    resetEdits() { cancelGesture(); scene.planted = []; scene.removed = []; scene.modified = []; selectedId = null; selectedFolderId = null; commit("Все объекты возвращены к исходному состоянию. Действие можно отменить."); },
    getSceneJson() { return serializeScene(scene); },
    exportScene() { autosave.flush(); download(new Blob([serializeScene(history.getScene())], { type: "application/json" }), `forest-scene-${scene.seed}-${scene.width}.json`); },
    async importScene(json: string): Promise<boolean> {
      if (disposed) return false;
      const imported = parseScene(json);
      if (!imported) { message = "Не удалось открыть JSON: неверный формат сцены или параметры объектов. Текущая карта сохранена."; invalidate(); return false; }
      cancelGesture(); const token = ++sceneImportToken, before = revision;
      try { await painter.prepareAssets(imported.assets); } catch (error) {
        if (!disposed && token === sceneImportToken && revision === before && !gesture && !settingsPreview) { message = `Не удалось открыть PNG из JSON: ${assetError(error)}. Текущая карта сохранена.`; invalidate(); } return false;
      }
      if (disposed || token !== sceneImportToken) return false;
      if (revision !== before || gesture || settingsPreview) { message = "Во время загрузки сцена изменилась. Импорт отменён; попробуй открыть JSON ещё раз."; invalidate(); return false; }
      scene = imported; selectedId = null; selectedFolderId = null; hoverResize = null; commit("Сцена открыта из JSON. Импорт можно отменить."); cursor(); fit(); return true;
    },
    async exportPng(): Promise<void> {
      autosave.flush(); const committed = history.getScene(), trees = options.trees;
      try { await painter.prepareAssets(committed.assets); } catch (error) { if (!disposed) { message = `Не удалось экспортировать PNG: ${assetError(error)}`; invalidate(); } return; }
      if (disposed) return;
      const image = makeCanvas(committed.width, WORLD_HEIGHT), exportCtx = image.getContext("2d"); if (!exportCtx) return;
      painter.paint(exportCtx, { x: 0, y: 0, width: committed.width, height: WORLD_HEIGHT }, { ...options, seed: committed.seed, width: committed.width,
        trees, assets: new Map(committed.assets.map(asset => [asset.id, asset])), planted: committed.planted, removed: new Set(committed.removed),
        modified: new Map(committed.modified.map(object => [object.id, object])), layers: committed.layers, folders: committed.folders, terrain: committed.terrain, lighting: committed.lighting, grid: false, selectedId: null, selectedFolderId: null, selectionArea: undefined, brushCursor: undefined, previewObjects: undefined, terrainPreview: undefined, previewRevision: 0, interactiveCache: false, renderScale: 1, selectionZoom: 1 });
      const blob = await new Promise<Blob | null>(resolve => image.toBlob(resolve, "image/png"));
      if (blob) download(blob, `forest-${committed.seed}-${committed.width}.png`);
    },
    dispose() {
      cancelGesture(); autosave.flush(); disposed = true; cancelAnimationFrame(frame); observer.disconnect(); painter.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("auxclick", auxiliary); editor.removeEventListener("keydown", key);
      window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", flushSave); window.removeEventListener("beforeunload", flushSave); document.removeEventListener?.("visibilitychange", visibility); pointers.clear();
    },
  };
}
