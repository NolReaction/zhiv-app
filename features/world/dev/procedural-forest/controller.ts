import { createForestPainter, type ForestOptions } from "./renderer";
import { canPlant, INITIAL_SEED, INITIAL_WIDTH, MAX_WIDTH, pickObject, WORLD_HEIGHT, type ForestObject } from "./objects";

export type ToolMode = "pan" | "plant" | "erase";
export type ForestStatus = { seed: number; width: number; objects: number; zoom: number; edited: number; message: string };

export function createForestController(canvas: HTMLCanvasElement, report: (status: ForestStatus) => void) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось открыть Canvas 2D.");
  const makeCanvas = (width: number, height: number) => {
    const surface = document.createElement("canvas"); surface.width = width; surface.height = height; return surface;
  };
  const painter = createForestPainter(makeCanvas);
  const removed = new Set<string>();
  const planted: ForestObject[] = [];
  const options: ForestOptions = { seed: INITIAL_SEED, width: INITIAL_WIDTH, trees: true, grid: false, removed, planted };
  let mode: ToolMode = "pan", screenWidth = 1, screenHeight = 1;
  let zoom = .5, cameraX = 800, cameraY = 800, initialized = false, disposed = false, frame = 0;
  let message = "Лес готов. Можно приблизить и рассмотреть детали.";
  let nextId = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { x: number; y: number; moved: boolean; pinched: boolean } | undefined;

  function fit() { zoom = Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .94; cameraX = options.width / 2; cameraY = WORLD_HEIGHT / 2; invalidate(); }
  function clamp() {
    zoom = Math.max(Math.min(screenWidth / options.width, screenHeight / WORLD_HEIGHT) * .65, Math.min(2.5, zoom));
    cameraX = Math.max(0, Math.min(options.width, cameraX)); cameraY = Math.max(0, Math.min(WORLD_HEIGHT, cameraY));
  }
  function draw() {
    frame = 0; if (disposed || !ctx) return;
    clamp();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#11251e"; ctx.fillRect(0, 0, screenWidth, screenHeight);
    ctx.translate(screenWidth / 2, screenHeight / 2); ctx.scale(zoom, zoom); ctx.translate(-cameraX, -cameraY);
    const stats = painter.paint(ctx, { x: cameraX - screenWidth / zoom / 2, y: cameraY - screenHeight / zoom / 2, width: screenWidth / zoom, height: screenHeight / zoom }, options);
    report({ seed: options.seed, width: options.width, objects: stats.objects, zoom, edited: removed.size + planted.length, message });
  }
  function invalidate() { if (!disposed && !frame) frame = requestAnimationFrame(draw); }
  function resize() {
    const rect = canvas.getBoundingClientRect(); screenWidth = rect.width; screenHeight = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(screenWidth * dpr); canvas.height = Math.round(screenHeight * dpr);
    if (!initialized) { fit(); initialized = true; } else invalidate();
  }
  function point(clientX: number, clientY: number) { const rect = canvas.getBoundingClientRect(); return { x: clientX - rect.left, y: clientY - rect.top }; }
  function world(point: { x: number; y: number }) { return { x: cameraX + (point.x - screenWidth / 2) / zoom, y: cameraY + (point.y - screenHeight / 2) / zoom }; }
  function zoomAt(factor: number, point = { x: screenWidth / 2, y: screenHeight / 2 }) {
    const before = world(point); zoom *= factor; clamp();
    const after = world(point); cameraX += before.x - after.x; cameraY += before.y - after.y; invalidate();
  }
  function edit(point: { x: number; y: number }) {
    const position = world(point);
    if (position.x < 0 || position.y < 0 || position.x > options.width || position.y > WORLD_HEIGHT) return;
    if (mode === "plant") {
      if (!canPlant(position.x, position.y, options.width)) { message = "Для дерева выбери землю рядом с тропой, подальше от воды."; invalidate(); return; }
      if (painter.objects(options).some(o => Math.hypot(o.x - position.x, o.y - position.y) < 30)) { message = "Здесь уже растёт дерево или стоит другой объект."; invalidate(); return; }
      planted.push({ id: `planted:${nextId++}`, ...position, scale: .92, variant: nextId % 24, kind: "tree" });
      message = "Дерево посажено. Остальная карта не изменилась.";
    } else if (mode === "erase") {
      const object = pickObject(painter.objects(options), position.x, position.y);
      if (object) { removed.add(object.id); message = "Объект убран. Земля под ним существует отдельно."; }
      else message = "Нажми на дерево, куст или камень, чтобы убрать его.";
    }
    invalidate();
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    const p = point(event.clientX, event.clientY); pointers.set(event.pointerId, p);
    if (pointers.size === 1) gesture = { ...p, moved: false, pinched: false };
    else if (gesture) gesture.pinched = true;
  };
  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    const p = point(event.clientX, event.clientY);
    if (gesture && Math.hypot(p.x - gesture.x, p.y - gesture.y) > 5) gesture.moved = true;
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) { const distance = Math.hypot(previous.x - other.x, previous.y - other.y); const next = Math.hypot(p.x - other.x, p.y - other.y);
        if (distance > 5 && next > 5) {
          zoomAt(next / distance, { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 });
          cameraX -= (p.x - previous.x) / (2 * zoom); cameraY -= (p.y - previous.y) / (2 * zoom);
        } }
    } else { cameraX -= (p.x - previous.x) / zoom; cameraY -= (p.y - previous.y) / zoom; invalidate(); }
    pointers.set(event.pointerId, p);
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    if (event.type === "pointerup" && gesture && !gesture.moved && !gesture.pinched && mode !== "pan") edit(point(event.clientX, event.clientY));
    pointers.delete(event.pointerId); if (pointers.size === 0) gesture = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const wheel = (event: WheelEvent) => { event.preventDefault(); zoomAt(Math.exp(-event.deltaY * .0015), point(event.clientX, event.clientY)); };
  const key = (event: KeyboardEvent) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Enter"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowLeft") cameraX -= 80 / zoom;
    if (event.key === "ArrowRight") cameraX += 80 / zoom;
    if (event.key === "ArrowUp") cameraY -= 80 / zoom;
    if (event.key === "ArrowDown") cameraY += 80 / zoom;
    if (event.key === "+" || event.key === "=") zoomAt(1.2);
    if (event.key === "-") zoomAt(1 / 1.2);
    if (event.key === "0") fit();
    if (event.key === "Enter" && mode !== "pan") edit({ x: screenWidth / 2, y: screenHeight / 2 });
    invalidate();
  };
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up); canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();

  return {
    fit, zoom: zoomAt,
    setMode(value: ToolMode) { mode = value; canvas.dataset.tool = value; message = value === "pan" ? "Перетаскивай карту или используй стрелки." : value === "plant" ? "Нажми на свободную землю, чтобы посадить дерево." : "Нажми на дерево, куст или камень, чтобы убрать его."; invalidate(); },
    setLayer(layer: "trees" | "grid", value: boolean) { options[layer] = value; invalidate(); },
    expand() { if (options.width >= MAX_WIDTH) return; options.width += 800; message = "Добавлено 800 единиц справа. Уже открытая часть леса сохранилась."; fit(); },
    regenerate() { options.seed += 137; removed.clear(); planted.length = 0; message = "Новый лес на том же рельефе. Локальные правки сброшены."; invalidate(); },
    resetEdits() { removed.clear(); planted.length = 0; message = "Посадки и удаления отменены."; invalidate(); },
    exportPng() {
      const image = makeCanvas(options.width, WORLD_HEIGHT), exportCtx = image.getContext("2d");
      if (!exportCtx) return;
      painter.paint(exportCtx, { x: 0, y: 0, width: options.width, height: WORLD_HEIGHT }, { ...options, grid: false });
      image.toBlob(blob => { if (!blob || disposed) return; const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `forest-${options.seed}-${options.width}.png`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }, "image/png");
    },
    dispose() { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); painter.dispose();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); pointers.clear(); },
  };
}
