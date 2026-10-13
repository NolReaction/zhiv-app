import { createForestPainter, type ForestOptions, type ImageLoader } from "./renderer";
import { canPlant, INITIAL_SEED, MAX_WIDTH, objectCorners, pickObject, WORLD_HEIGHT, type ForestObject, type ObjectKind } from "./objects";
import { createSceneHistory, parseScene, readStoredScene, serializeScene, validateScene, writeStoredScene, type SceneStorage } from "./editor-scene";
import { imageObjectSize, readPngFile, validateImageAsset, type ImageAsset } from "./image-assets";
import { beginResize, findResizeHandle, MAX_OBJECT_SCALE, MIN_OBJECT_SCALE, resizedObject, type ResizeCorner, type ResizeSession } from "./transform";

export type ToolMode = "pan" | "select" | "plant" | "erase";
export type ForestStatus = {
  seed: number; width: number; objects: number; zoom: number; edited: number; message: string;
  selected: ForestObject | null; canUndo: boolean; canRedo: boolean; storage: "saved" | "unavailable"; brush: ObjectKind;
  mode: ToolMode; temporaryPan: boolean; trees: boolean; grid: boolean;
  assets: { id: string; name: string }[]; brushAssetId: string | null;
};
export type ForestControllerOptions = { requestPngImport?: () => void; loadImage?: ImageLoader };
type ObjectPatch = Partial<Pick<ForestObject, "x" | "y" | "scale" | "rotation" | "variant">>;
type Point = { x: number; y: number };
type Gesture = { start: Point; moved: boolean; pinched: boolean; pan: boolean; temporaryPan: boolean; pointerId: number;
  object?: ForestObject; grabOffset?: Point; resize?: ResizeSession; shift: boolean; lockAxis?: "x" | "y" };
const names: Record<ObjectKind, string> = { tree: "дерево", shrub: "куст", rock: "камень", ruins: "руины", bridge: "мост", jetty: "причал", image: "PNG-объект" };

export function createForestController(canvas: HTMLCanvasElement, report: (status: ForestStatus) => void, controllerOptions: ForestControllerOptions = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось открыть Canvas 2D.");
  const makeCanvas = (width: number, height: number) => {
    const surface = document.createElement("canvas"); surface.width = width; surface.height = height; return surface;
  };
  const painter = createForestPainter(makeCanvas, () => invalidate(), controllerOptions.loadImage);
  const editor = canvas.closest<HTMLElement>("[data-forest-editor]") ?? canvas;
  let localStorage: SceneStorage | null = null;
  try { localStorage = window.localStorage; } catch { /* Private browsing can deny all storage access. */ }
  const restored = readStoredScene(localStorage);
  const history = createSceneHistory(restored.scene);
  let scene = history.getScene();
  const options: ForestOptions = { seed: scene.seed, width: scene.width, trees: true, grid: false,
    removed: new Set(scene.removed), planted: scene.planted, modified: new Map(scene.modified.map(object => [object.id, object])), selectedId: null,
    assets: new Map(scene.assets.map(asset => [asset.id, asset])), selectionZoom: 1 };
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

  function temporaryPan() { return spaceHeld || !!gesture?.temporaryPan; }
  function cursor() {
    canvas.dataset.tool = temporaryPan() || gesture?.pan ? "pan" : mode; canvas.dataset.dragging = gesture ? "true" : "false";
    canvas.dataset.resizing = gesture?.resize ? "true" : "false";
    const corner = gesture?.resize?.corner ?? hoverResize, object = gesture?.object ?? selected();
    let value = "";
    if (corner !== null && object && !temporaryPan() && !gesture?.pan && mode !== "pan") {
      const corners = objectCorners(object), opposite = corners[(corner + 2) % 4], handle = corners[corner];
      const angle = (Math.atan2(handle.y - opposite.y, handle.x - opposite.x) * 180 / Math.PI + 180) % 180;
      value = angle < 22.5 || angle >= 157.5 ? "ew-resize" : angle < 67.5 ? "nwse-resize" : angle < 112.5 ? "ns-resize" : "nesw-resize";
    }
    canvas.style.cursor = value;
    if (value) canvas.dataset.tool = "resize";
    canvas.dataset.resizeDirection = value.replace("-resize", "");
  }

  function sync() {
    options.seed = scene.seed; options.width = scene.width; options.planted = scene.planted;
    options.removed = new Set(scene.removed); options.modified = new Map(scene.modified.map(object => [object.id, object]));
    options.assets = new Map(scene.assets.map(asset => [asset.id, asset]));
    if (brushAssetId && !options.assets.has(brushAssetId)) { brushAssetId = null; if (brush === "image") { brush = "tree"; mode = "select"; } }
    options.selectedId = selectedId;
    for (const object of scene.planted) {
      const number = /^planted:(\d+)$/.exec(object.id);
      const value = number ? Number(number[1]) : NaN;
      if (Number.isSafeInteger(value) && value < 1_000_000_000) nextId = Math.max(nextId, value + 1);
    }
  }
  sync(); cursor();
  function selected() { return selectedId ? painter.objects({ ...options, trees: true }).find(object => object.id === selectedId) ?? null : null; }
  function fit() { zoom = Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .94; cameraX = options.width / 2; cameraY = WORLD_HEIGHT / 2; invalidate(); }
  function clamp() {
    zoom = Math.max(Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .65, Math.min(2.5, zoom));
    cameraX = Math.max(0, Math.min(options.width, cameraX)); cameraY = Math.max(0, Math.min(WORLD_HEIGHT, cameraY));
  }
  function draw(now = performance.now()) {
    frame = 0; if (disposed || !ctx) return;
    clamp(); const autoPanning = edgePan(now); options.selectedId = selectedId; options.selectionZoom = zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#11251e"; ctx.fillRect(0, 0, screenWidth, screenHeight);
    ctx.translate(screenWidth / 2, screenHeight / 2); ctx.scale(zoom, zoom); ctx.translate(-cameraX, -cameraY);
    const stats = painter.paint(ctx, { x: cameraX - screenWidth / zoom / 2, y: cameraY - screenHeight / zoom / 2, width: screenWidth / zoom, height: screenHeight / zoom }, options);
    const object = selected();
    report({ seed: options.seed, width: options.width, objects: stats.objects, zoom,
      edited: scene.removed.length + scene.planted.length + scene.modified.length, message,
      selected: object ? { ...object } : null, canUndo: history.canUndo, canRedo: history.canRedo, storage, brush, mode, temporaryPan: temporaryPan(), trees: options.trees, grid: options.grid,
      assets: scene.assets.map(({ id, name }) => ({ id, name })), brushAssetId });
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
  function save() { storage = writeStoredScene(localStorage, scene) ? "saved" : "unavailable"; }
  function commit(text: string) { sync(); if (history.commit(scene)) { revision++; save(); } message = text; invalidate(); }
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
    sync();
  }
  function rollbackDrag() {
    if (gesture?.object && gesture.moved) { scene = history.getScene(); sync(); invalidate(); }
  }
  function cancelGesture() {
    rollbackDrag(); gesture = undefined; hoverResize = null; lastPanTime = null; cursor();
    for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    pointers.clear();
  }
  function updateDrag(p = gesture ? pointers.get(gesture.pointerId) : undefined) {
    if (!p || !gesture?.object || !gesture.moved || gesture.pinched || gesture.pan) return;
    const position = world(p);
    if (gesture.resize) {
      const object = resizedObject(gesture.resize, position, options.width, WORLD_HEIGHT);
      const initial = gesture.object;
      if (!within(object) || !Number.isFinite(object.scale) || object.scale < MIN_OBJECT_SCALE || object.scale > MAX_OBJECT_SCALE) return;
      if (Math.abs(object.x - initial.x) < 1e-10 && Math.abs(object.y - initial.y) < 1e-10 && Math.abs(object.scale - initial.scale) < 1e-10) {
        scene = history.getScene(); sync();
      } else replaceObject(object);
      return;
    }
    if (!gesture.grabOffset) return;
    let x = position.x + gesture.grabOffset.x, y = position.y + gesture.grabOffset.y;
    if (gesture.shift) {
      gesture.lockAxis ??= Math.abs(x - gesture.object.x) >= Math.abs(y - gesture.object.y) ? "x" : "y";
      if (gesture.lockAxis === "x") y = gesture.object.y; else x = gesture.object.x;
    } else gesture.lockAxis = undefined;
    replaceObject({ ...gesture.object, x: Math.max(0, Math.min(options.width, x)), y: Math.max(0, Math.min(WORLD_HEIGHT, y)) });
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
    if (!within(position)) return;
    if ((brush === "tree" || brush === "shrub") && !canPlant(position.x, position.y, options.width)) {
      message = "Деревья и кусты можно добавить на свободную землю, вдали от воды и тропинок."; invalidate(); return;
    }
    if (scene.planted.length >= 5_000) { message = "Достигнут предел 5000 добавленных объектов."; invalidate(); return; }
    const asset = brush === "image" ? scene.assets.find(entry => entry.id === brushAssetId) : null;
    if (brush === "image" && !asset) { message = "Сначала добавь PNG через кнопку «Импорт PNG»."; invalidate(); return; }
    const object: ForestObject = { id: newId(), ...position, scale: brush === "tree" ? .92 : 1, variant: asset ? 0 : nextId % 24, kind: brush, rotation: 0,
      ...(asset ? { assetId: asset.id, ...imageObjectSize(asset) } : {}) };
    scene.planted.push(object); selectedId = object.id;
    commit(`Добавлен объект: ${names[brush]}. Его можно выбрать и переместить.`);
  }
  function removeObject(object: ForestObject) {
    const index = scene.planted.findIndex(entry => entry.id === object.id);
    if (index >= 0) scene.planted.splice(index, 1);
    else if (!scene.removed.includes(object.id)) scene.removed.push(object.id);
    scene.modified = scene.modified.filter(entry => entry.id !== object.id);
    if (selectedId === object.id) selectedId = null;
    commit("Объект удалён. Можно вернуть его кнопкой «Отменить».");
  }
  function edit(p: Point) {
    const position = world(p);
    if (mode === "plant") plant(position);
    else if (mode === "erase") {
      const object = pickObject(painter.objects(options), position.x, position.y);
      if (object) removeObject(object); else { message = "Нажми на объект, чтобы удалить его."; invalidate(); }
    }
  }
  function updateSelected(patch: ObjectPatch) {
    cancelGesture();
    const object = selected(); if (!object) return;
    const candidate = { ...object, ...patch };
    if (!within(candidate) || !Number.isFinite(candidate.scale) || candidate.scale < MIN_OBJECT_SCALE || candidate.scale > MAX_OBJECT_SCALE
      || !Number.isInteger(candidate.variant) || candidate.variant < 0 || candidate.variant > 23
      || !Number.isFinite(candidate.rotation ?? 0) || (candidate.rotation ?? 0) < -180 || (candidate.rotation ?? 0) > 180) {
      message = "Параметры вне диапазона: координаты внутри карты, масштаб 0,1–8, поворот −180°…180°, вариант 0–23."; invalidate(); return;
    }
    if (["x", "y", "scale", "rotation", "variant"].every(key => candidate[key as keyof ObjectPatch] === object[key as keyof ObjectPatch])) return;
    replaceObject(candidate); commit("Параметры объекта изменены.");
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
    cancelGesture(); mode = value; if (value === "plant" && (brush === "tree" || brush === "shrub")) options.trees = true; cursor();
    message = value === "pan" ? "Перетаскивай карту или используй стрелки."
      : value === "select" ? "Нажми на любой объект, затем перетащи его или измени параметры."
      : value === "plant" ? `Нажми на карту, чтобы добавить объект: ${names[brush]}.` : "Нажми на любой объект, чтобы удалить его.";
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
    if (disposed) return false;
    const asset = validateImageAsset(value);
    if (!asset) { if (!disposed) { message = "Не удалось добавить PNG: неверный файл или параметры изображения."; invalidate(); } return false; }
    const mergeAssets = () => {
      const existing = scene.assets.find(entry => entry.id === asset.id);
      return existing && existing.dataUrl !== asset.dataUrl ? null : existing ? scene.assets : [...scene.assets, asset];
    };
    const staged = mergeAssets();
    if (!staged || !validateScene({ ...scene, assets: staged })) { message = "Не удалось добавить PNG: превышен размер сцены или лимит изображений."; invalidate(); return false; }
    try { await painter.prepareAssets(staged); } catch (error) {
      if (!disposed) { message = `Не удалось открыть PNG: ${assetError(error)}`; invalidate(); } return false;
    }
    if (disposed) return false;
    cancelGesture();
    const assets = mergeAssets();
    if (!assets || scene.planted.length >= 5_000) { message = "Не удалось добавить PNG: достигнут лимит объектов или изображений."; invalidate(); return false; }
    const size = imageObjectSize(asset);
    const object: ForestObject = { id: newId(), kind: "image", assetId: asset.id, ...size,
      x: Math.max(0, Math.min(scene.width, cameraX)), y: Math.max(0, Math.min(WORLD_HEIGHT, cameraY + size.imageHeight / 2)), scale: 1, rotation: 0, variant: 0 };
    const appended = validateScene({ ...scene, assets, planted: [...scene.planted, object] });
    if (!appended) { message = "Не удалось добавить PNG: превышен размер сцены или лимит изображений."; invalidate(); return false; }
    scene = appended; selectedId = object.id; brush = "image"; brushAssetId = asset.id; mode = "select"; cursor();
    commit(`Добавлен PNG: ${asset.name}. Перетаскивай картинку или тяни за угол.`); return true;
  }
  async function importPng(file: File): Promise<boolean> {
    try { return await addPngAsset(await readPngFile(file)); } catch (error) {
      if (!disposed) { message = `Не удалось добавить PNG: ${assetError(error)}`; invalidate(); } return false;
    }
  }
  function duplicateSelected() {
    cancelGesture(); const object = selected(); if (!object || scene.planted.length >= 5_000) return;
    let position: Point | undefined;
    for (const offset of [40, -40, 80, -80, 120, -120]) {
      const candidate = { x: Math.max(0, Math.min(options.width, object.x + offset)), y: Math.max(0, Math.min(WORLD_HEIGHT, object.y + 30)) };
      if ((object.kind !== "tree" && object.kind !== "shrub") || canPlant(candidate.x, candidate.y, options.width)) { position = candidate; break; }
    }
    if (!position) { message = "Рядом нет свободной земли для копии. Добавь объект в другом месте."; invalidate(); return; }
    const copy = { ...object, ...position, id: newId() }; scene.planted.push(copy); selectedId = copy.id; commit("Копия добавлена и выбрана.");
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    const p = point(event.clientX, event.clientY); pointers.set(event.pointerId, p);
    if (pointers.size === 1) {
      const transient = spaceHeld || event.button === 1;
      gesture = { start: p, moved: false, pinched: false, pan: mode === "pan" || transient, temporaryPan: transient, pointerId: event.pointerId, shift: event.shiftKey };
      const position = world(p), current = selected();
      const corner = current && !gesture.pan ? findResizeHandle(current, position, zoom, event.pointerType === "touch" ? 22 : 14) : null;
      if (current && corner !== null) {
        gesture.object = { ...current }; gesture.resize = beginResize(current, corner, position); hoverResize = corner; mode = "select";
        message = "Тяни за угол, чтобы изменить размер. Пропорции картинки сохраняются.";
      } else if (mode === "select" && !gesture.pan) {
        const object = pickObject(painter.objects(options), position.x, position.y);
        selectedId = object?.id ?? null; options.selectedId = selectedId;
        if (object) { gesture.object = { ...object }; gesture.grabOffset = { x: object.x - position.x, y: object.y - position.y }; message = "Объект выбран. Перетащи его или измени параметры справа."; }
        else { gesture.pan = true; message = "Перетаскивай пустое место для перемещения карты."; }
      }
    } else if (gesture) {
      rollbackDrag(); gesture.object = undefined; gesture.grabOffset = undefined; gesture.resize = undefined; gesture.pinched = true; hoverResize = null; lastPanTime = null;
    }
    cursor(); invalidate();
  };
  const move = (event: PointerEvent) => {
    const p = point(event.clientX, event.clientY);
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      const object = !temporaryPan() && mode !== "pan" ? selected() : null;
      hoverResize = object ? findResizeHandle(object, world(p), zoom, event.pointerType === "touch" ? 22 : 14) : null; cursor(); return;
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
    } else if (gesture?.object && !gesture.pinched && !gesture.pan) {
      updateDrag(p); invalidate();
    } else { cameraX -= (p.x - previous.x) / zoom; cameraY -= (p.y - previous.y) / zoom; invalidate(); }
    pointers.set(event.pointerId, p);
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const finishing = pointers.size === 1;
    if (event.type !== "pointerup") {
      rollbackDrag(); if (gesture) { gesture.pinched = true; gesture.object = undefined; gesture.resize = undefined; } hoverResize = null;
    } else if (finishing && gesture && !gesture.pinched) {
      if (gesture.object && gesture.moved) { updateDrag(point(event.clientX, event.clientY)); commit(gesture.resize ? "Размер объекта изменён." : "Объект перемещён."); }
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
    if (command) return;
    if (event.key === "Shift") { if (gesture) { gesture.shift = true; updateDrag(); invalidate(); } return; }
    if (code === "Space") {
      event.preventDefault();
      if (!spaceHeld) {
        rollbackDrag(); spaceHeld = true;
        if (gesture) { gesture.object = undefined; gesture.grabOffset = undefined; gesture.resize = undefined; gesture.pan = true; gesture.temporaryPan = true; lastPanTime = null; }
        hoverResize = null;
        cursor(); invalidate();
      }
      return;
    }
    const tools: Partial<Record<string, ToolMode>> = { KeyV: "select", KeyH: "pan", KeyB: "plant", KeyE: "erase" };
    if (tools[code]) { event.preventDefault(); if (!event.repeat) setMode(tools[code]); return; }
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
    if (event.key === "Escape") { cancelGesture(); selectedId = null; invalidate(); return; }
    const object = mode === "select" && !temporaryPan() ? selected() : null;
    const delta = event.shiftKey ? 10 : 1;
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
  const leave = () => { if (!pointers.size) { hoverResize = null; cursor(); } };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up); canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("auxclick", auxiliary); editor.addEventListener("keydown", key);
  window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
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
    clearSelection() { cancelGesture(); selectedId = null; invalidate(); },
    selectById(id: string) { cancelGesture(); const object = painter.objects(options).find(entry => entry.id === id); selectedId = object?.id ?? null; invalidate(); return !!object; },
    deleteSelected() { cancelGesture(); const object = selected(); if (object) removeObject(object); },
    setLayer(layer: "trees" | "grid", value: boolean) {
      cancelGesture(); options[layer] = value;
      if (layer === "trees" && !value) { const object = selected(); if (object?.kind === "tree" || object?.kind === "shrub") selectedId = null; }
      invalidate();
    },
    expand() { cancelGesture(); if (scene.width >= MAX_WIDTH) return; scene.width += 800; commit("Добавлено 800 единиц справа. Все твои объекты сохранились."); fit(); },
    regenerate() {
      cancelGesture(); scene = { version: 2, seed: (scene.seed + 137) % 2_147_483_648, width: scene.width, planted: [], removed: [], modified: [], assets: scene.assets };
      selectedId = null; commit("Создан новый лес. Прежний вариант можно вернуть кнопкой «Отменить».");
    },
    resetEdits() { cancelGesture(); scene.planted = []; scene.removed = []; scene.modified = []; selectedId = null; commit("Все объекты возвращены к исходному состоянию. Действие можно отменить."); },
    getSceneJson() { return serializeScene(history.getScene()); },
    exportScene() { download(new Blob([serializeScene(history.getScene())], { type: "application/json" }), `forest-scene-${scene.seed}-${scene.width}.json`); },
    async importScene(json: string): Promise<boolean> {
      if (disposed) return false;
      const imported = parseScene(json);
      if (!imported) { message = "Не удалось открыть JSON: неверный формат сцены или параметры объектов. Текущая карта сохранена."; invalidate(); return false; }
      cancelGesture(); const token = ++sceneImportToken, before = revision;
      try { await painter.prepareAssets(imported.assets); } catch (error) {
        if (!disposed && token === sceneImportToken && revision === before && !gesture) { message = `Не удалось открыть PNG из JSON: ${assetError(error)}. Текущая карта сохранена.`; invalidate(); } return false;
      }
      if (disposed || token !== sceneImportToken) return false;
      if (revision !== before || gesture) { message = "Во время загрузки сцена изменилась. Импорт отменён; попробуй открыть JSON ещё раз."; invalidate(); return false; }
      scene = imported; selectedId = null; hoverResize = null; commit("Сцена открыта из JSON. Импорт можно отменить."); cursor(); fit(); return true;
    },
    async exportPng(): Promise<void> {
      const committed = history.getScene(), trees = options.trees;
      try { await painter.prepareAssets(committed.assets); } catch (error) { if (!disposed) { message = `Не удалось экспортировать PNG: ${assetError(error)}`; invalidate(); } return; }
      if (disposed) return;
      const image = makeCanvas(committed.width, WORLD_HEIGHT), exportCtx = image.getContext("2d"); if (!exportCtx) return;
      painter.paint(exportCtx, { x: 0, y: 0, width: committed.width, height: WORLD_HEIGHT }, { ...options, seed: committed.seed, width: committed.width,
        trees, assets: new Map(committed.assets.map(asset => [asset.id, asset])), planted: committed.planted, removed: new Set(committed.removed),
        modified: new Map(committed.modified.map(object => [object.id, object])), grid: false, selectedId: null, selectionZoom: 1 });
      const blob = await new Promise<Blob | null>(resolve => image.toBlob(resolve, "image/png"));
      if (blob) download(blob, `forest-${committed.seed}-${committed.width}.png`);
    },
    dispose() {
      cancelGesture(); disposed = true; cancelAnimationFrame(frame); observer.disconnect(); painter.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("auxclick", auxiliary); editor.removeEventListener("keydown", key);
      window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); pointers.clear();
    },
  };
}
