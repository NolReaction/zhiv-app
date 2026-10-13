import { createForestPainter, type ForestOptions } from "./renderer";
import { canPlant, INITIAL_SEED, MAX_WIDTH, pickObject, WORLD_HEIGHT, type ForestObject, type ObjectKind } from "./objects";
import { createSceneHistory, parseScene, readStoredScene, serializeScene, writeStoredScene, type SceneStorage } from "./editor-scene";

export type ToolMode = "pan" | "select" | "plant" | "erase";
export type ForestStatus = {
  seed: number; width: number; objects: number; zoom: number; edited: number; message: string;
  selected: ForestObject | null; canUndo: boolean; canRedo: boolean; storage: "saved" | "unavailable"; brush: ObjectKind;
};
type ObjectPatch = Partial<Pick<ForestObject, "x" | "y" | "scale" | "rotation" | "variant">>;
type Point = { x: number; y: number };
type Gesture = { start: Point; moved: boolean; pinched: boolean; object?: ForestObject; origin?: Point };
const names: Record<ObjectKind, string> = { tree: "дерево", shrub: "куст", rock: "камень", ruins: "руины", bridge: "мост", jetty: "причал" };

export function createForestController(canvas: HTMLCanvasElement, report: (status: ForestStatus) => void) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось открыть Canvas 2D.");
  const makeCanvas = (width: number, height: number) => {
    const surface = document.createElement("canvas"); surface.width = width; surface.height = height; return surface;
  };
  const painter = createForestPainter(makeCanvas);
  let localStorage: SceneStorage | null = null;
  try { localStorage = window.localStorage; } catch { /* Private browsing can deny all storage access. */ }
  const restored = readStoredScene(localStorage);
  const history = createSceneHistory(restored.scene);
  let scene = history.getScene();
  const options: ForestOptions = { seed: scene.seed, width: scene.width, trees: true, grid: false,
    removed: new Set(scene.removed), planted: scene.planted, modified: new Map(scene.modified.map(object => [object.id, object])), selectedId: null };
  let storage: ForestStatus["storage"] = restored.available && !restored.invalid ? "saved" : "unavailable";
  let mode: ToolMode = "select", brush: ObjectKind = "tree", selectedId: string | null = null;
  let screenWidth = 1, screenHeight = 1, zoom = .5, cameraX = 800, cameraY = 800;
  let initialized = false, disposed = false, frame = 0, nextId = 0;
  let message = restored.invalid ? "Сохранённый файл повреждён. Открыта исходная карта; можно импортировать резервную копию JSON."
    : scene.planted.length || scene.removed.length || scene.modified.length || scene.seed !== INITIAL_SEED ? "Твои правки восстановлены. Выбери любой объект и перетащи его."
    : "Выбери любой объект, чтобы переместить его и изменить параметры.";
  const pointers = new Map<number, Point>();
  let gesture: Gesture | undefined;

  function sync() {
    options.seed = scene.seed; options.width = scene.width; options.planted = scene.planted;
    options.removed = new Set(scene.removed); options.modified = new Map(scene.modified.map(object => [object.id, object]));
    options.selectedId = selectedId;
    for (const object of scene.planted) {
      const number = /^planted:(\d+)$/.exec(object.id);
      const value = number ? Number(number[1]) : NaN;
      if (Number.isSafeInteger(value) && value < 1_000_000_000) nextId = Math.max(nextId, value + 1);
    }
  }
  sync(); canvas.dataset.tool = mode;
  function selected() { return selectedId ? painter.objects({ ...options, trees: true }).find(object => object.id === selectedId) ?? null : null; }
  function fit() { zoom = Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .94; cameraX = options.width / 2; cameraY = WORLD_HEIGHT / 2; invalidate(); }
  function clamp() {
    zoom = Math.max(Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .65, Math.min(2.5, zoom));
    cameraX = Math.max(0, Math.min(options.width, cameraX)); cameraY = Math.max(0, Math.min(WORLD_HEIGHT, cameraY));
  }
  function draw() {
    frame = 0; if (disposed || !ctx) return;
    clamp(); options.selectedId = selectedId;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#11251e"; ctx.fillRect(0, 0, screenWidth, screenHeight);
    ctx.translate(screenWidth / 2, screenHeight / 2); ctx.scale(zoom, zoom); ctx.translate(-cameraX, -cameraY);
    const stats = painter.paint(ctx, { x: cameraX - screenWidth / zoom / 2, y: cameraY - screenHeight / zoom / 2, width: screenWidth / zoom, height: screenHeight / zoom }, options);
    const object = selected();
    report({ seed: options.seed, width: options.width, objects: stats.objects, zoom,
      edited: scene.removed.length + scene.planted.length + scene.modified.length, message,
      selected: object ? { ...object } : null, canUndo: history.canUndo, canRedo: history.canRedo, storage, brush });
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
    const after = world(point); cameraX += before.x - after.x; cameraY += before.y - after.y; invalidate();
  }
  function save() { storage = writeStoredScene(localStorage, scene) ? "saved" : "unavailable"; }
  function commit(text: string) { sync(); if (history.commit(scene)) save(); message = text; invalidate(); }
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
    rollbackDrag(); gesture = undefined;
    for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    pointers.clear();
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
    const object: ForestObject = { id: newId(), ...position, scale: brush === "tree" ? .92 : 1, variant: nextId % 24, kind: brush, rotation: 0 };
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
    if (!within(candidate) || !Number.isFinite(candidate.scale) || candidate.scale < .4 || candidate.scale > 2.4
      || !Number.isInteger(candidate.variant) || candidate.variant < 0 || candidate.variant > 23
      || !Number.isFinite(candidate.rotation ?? 0) || (candidate.rotation ?? 0) < -180 || (candidate.rotation ?? 0) > 180) {
      message = "Параметры вне диапазона: координаты внутри карты, масштаб 0,4–2,4, поворот −180°…180°, вариант 0–23."; invalidate(); return;
    }
    if (["x", "y", "scale", "rotation", "variant"].every(key => candidate[key as keyof ObjectPatch] === object[key as keyof ObjectPatch])) return;
    replaceObject(candidate); commit("Параметры объекта изменены.");
  }
  function undo() {
    cancelGesture(); const previous = history.undo(); if (!previous) return;
    scene = previous; sync(); if (!selected()) selectedId = null; save(); message = "Последнее изменение отменено."; invalidate();
  }
  function redo() {
    cancelGesture(); const next = history.redo(); if (!next) return;
    scene = next; sync(); if (!selected()) selectedId = null; save(); message = "Изменение повторено."; invalidate();
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    const p = point(event.clientX, event.clientY); pointers.set(event.pointerId, p);
    if (pointers.size === 1) {
      gesture = { start: p, moved: false, pinched: false };
      if (mode === "select") {
        const position = world(p), object = pickObject(painter.objects(options), position.x, position.y);
        selectedId = object?.id ?? null; options.selectedId = selectedId;
        if (object) { gesture.object = { ...object }; gesture.origin = position; message = "Объект выбран. Перетащи его или измени параметры справа."; }
        else message = "Перетаскивай пустое место для перемещения карты.";
        invalidate();
      }
    } else if (gesture) {
      rollbackDrag(); gesture.object = undefined; gesture.origin = undefined; gesture.pinched = true;
    }
  };
  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    const p = point(event.clientX, event.clientY);
    if (gesture && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 5) gesture.moved = true;
    if (pointers.size >= 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const distance = Math.hypot(previous.x - other.x, previous.y - other.y), next = Math.hypot(p.x - other.x, p.y - other.y);
        if (distance > 5 && next > 5) {
          zoomAt(next / distance, { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 });
          cameraX -= (p.x - previous.x) / (2 * zoom); cameraY -= (p.y - previous.y) / (2 * zoom); invalidate();
        }
      }
    } else if (gesture?.object && gesture.origin && !gesture.pinched) {
      if (gesture.moved) {
        const position = world(p), object = gesture.object;
        replaceObject({ ...object, x: Math.max(0, Math.min(options.width, object.x + position.x - gesture.origin.x)),
          y: Math.max(0, Math.min(WORLD_HEIGHT, object.y + position.y - gesture.origin.y)) });
        invalidate();
      }
    } else { cameraX -= (p.x - previous.x) / zoom; cameraY -= (p.y - previous.y) / zoom; invalidate(); }
    pointers.set(event.pointerId, p);
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const finishing = pointers.size === 1;
    if (event.type !== "pointerup") {
      rollbackDrag(); if (gesture) { gesture.pinched = true; gesture.object = undefined; }
    } else if (finishing && gesture && !gesture.pinched) {
      if (gesture.object && gesture.moved) commit("Объект перемещён.");
      else if (!gesture.moved && mode !== "pan" && mode !== "select") edit(point(event.clientX, event.clientY));
    }
    pointers.delete(event.pointerId); if (!pointers.size) gesture = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const wheel = (event: WheelEvent) => { event.preventDefault(); zoomAt(Math.exp(-event.deltaY * .0015), point(event.clientX, event.clientY)); };
  const key = (event: KeyboardEvent) => {
    if (event.target !== canvas || event.altKey) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (command && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
    if (command) return;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Enter", "Delete", "Backspace", "Escape"].includes(event.key)) event.preventDefault();
    if (event.key === "Delete" || event.key === "Backspace") { cancelGesture(); const object = selected(); if (object) removeObject(object); return; }
    if (event.key === "Escape") { cancelGesture(); selectedId = null; invalidate(); return; }
    const object = mode === "select" ? selected() : null;
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
    if (event.key === "0") fit();
    if (event.key === "Enter" && (mode === "plant" || mode === "erase")) edit({ x: screenWidth / 2, y: screenHeight / 2 });
    invalidate();
  };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up); canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();

  function download(blob: Blob, filename: string) {
    if (disposed) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    fit, zoom: zoomAt, updateSelected, undo, redo,
    setMode(value: ToolMode) {
      cancelGesture(); mode = value; canvas.dataset.tool = value;
      message = value === "pan" ? "Перетаскивай карту или используй стрелки."
        : value === "select" ? "Нажми на любой объект, затем перетащи его или измени параметры."
        : value === "plant" ? `Нажми на карту, чтобы добавить объект: ${names[brush]}.` : "Нажми на любой объект, чтобы удалить его.";
      invalidate();
    },
    setBrush(value: ObjectKind) { if (!Object.hasOwn(names, value)) return; brush = value; message = `Выбран объект для добавления: ${names[value]}.`; invalidate(); },
    clearSelection() { cancelGesture(); selectedId = null; invalidate(); },
    selectById(id: string) { cancelGesture(); const object = painter.objects(options).find(entry => entry.id === id); selectedId = object?.id ?? null; invalidate(); return !!object; },
    deleteSelected() { cancelGesture(); const object = selected(); if (object) removeObject(object); },
    duplicateSelected() {
      cancelGesture(); const object = selected(); if (!object || scene.planted.length >= 5_000) return;
      let position: Point | undefined;
      for (const offset of [40, -40, 80, -80, 120, -120]) {
        const candidate = { x: Math.max(0, Math.min(options.width, object.x + offset)), y: Math.max(0, Math.min(WORLD_HEIGHT, object.y + 30)) };
        if ((object.kind !== "tree" && object.kind !== "shrub") || canPlant(candidate.x, candidate.y, options.width)) { position = candidate; break; }
      }
      if (!position) { message = "Рядом нет свободной земли для копии. Добавь объект в другом месте."; invalidate(); return; }
      const copy = { ...object, ...position, id: newId() }; scene.planted.push(copy); selectedId = copy.id; commit("Копия добавлена и выбрана.");
    },
    setLayer(layer: "trees" | "grid", value: boolean) {
      cancelGesture(); options[layer] = value;
      if (layer === "trees" && !value) { const object = selected(); if (object?.kind === "tree" || object?.kind === "shrub") selectedId = null; }
      invalidate();
    },
    expand() { cancelGesture(); if (scene.width >= MAX_WIDTH) return; scene.width += 800; commit("Добавлено 800 единиц справа. Все твои объекты сохранились."); fit(); },
    regenerate() {
      cancelGesture(); scene = { version: 1, seed: (scene.seed + 137) % 2_147_483_648, width: scene.width, planted: [], removed: [], modified: [] };
      selectedId = null; commit("Создан новый лес. Прежний вариант можно вернуть кнопкой «Отменить».");
    },
    resetEdits() { cancelGesture(); scene.planted = []; scene.removed = []; scene.modified = []; selectedId = null; commit("Все объекты возвращены к исходному состоянию. Действие можно отменить."); },
    getSceneJson() { return serializeScene(history.getScene()); },
    exportScene() { download(new Blob([serializeScene(history.getScene())], { type: "application/json" }), `forest-scene-${scene.seed}-${scene.width}.json`); },
    importScene(json: string) {
      const imported = parseScene(json);
      if (!imported) { message = "Не удалось открыть JSON: неверный формат сцены или параметры объектов. Текущая карта сохранена."; invalidate(); return false; }
      cancelGesture(); scene = imported; selectedId = null; commit("Сцена открыта из JSON. Импорт можно отменить."); fit(); return true;
    },
    exportPng() {
      const image = makeCanvas(options.width, WORLD_HEIGHT), exportCtx = image.getContext("2d");
      if (!exportCtx) return;
      const committed = history.getScene();
      painter.paint(exportCtx, { x: 0, y: 0, width: committed.width, height: WORLD_HEIGHT }, { ...options, seed: committed.seed, width: committed.width,
        planted: committed.planted, removed: new Set(committed.removed), modified: new Map(committed.modified.map(object => [object.id, object])), grid: false, selectedId: null });
      image.toBlob(blob => { if (blob) download(blob, `forest-${committed.seed}-${committed.width}.png`); }, "image/png");
    },
    dispose() {
      cancelGesture(); disposed = true; cancelAnimationFrame(frame); observer.disconnect(); painter.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); pointers.clear();
    },
  };
}
