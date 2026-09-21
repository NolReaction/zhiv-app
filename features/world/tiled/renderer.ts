import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import { previewSiteAt, previewSiteVisual } from "./preview-state";
import type { FixedWorldScene, PreviewLevels, SiteVisual, WorldBounds, WorldPoint } from "./types";
import { createPreviewRoute, type PreviewActor, type PreviewRouteStatus } from "./preview-route";

export type FixedWorldRenderOptions = {
  levels: PreviewLevels;
  night: boolean;
  debug: boolean;
  selectedSiteId: string | null;
  reducedMotion: boolean;
  paused?: boolean;
};
export type FixedWorldRenderStatus = { loading: boolean; error: string | null };
export type FixedWorldRenderCallbacks = {
  onSelect?: (siteId: string) => void;
  onStatus?: (status: FixedWorldRenderStatus) => void;
  onRouteChange?: (status: PreviewRouteStatus) => void;
};

type Viewport = { width: number; height: number };
type Camera = WorldPoint & { zoom: number };
export type PaintFrame = {
  images: ReadonlyMap<string, HTMLImageElement>;
  visuals: Record<string, SiteVisual>;
  options: FixedWorldRenderOptions;
  actor: PreviewActor | null;
};

function polygon(ctx: CanvasRenderingContext2D, points: readonly WorldPoint[]) {
  ctx.beginPath();
  points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
}

/** Both cameras call this exact compositor in world pixels, including its light pass. */
export function paintFixedWorld(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, frame: PaintFrame) {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  for (const terrain of scene.terrain) {
    const image = frame.images.get(terrain.image), bounds = terrain.bounds;
    if (image) ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, bounds.x, bounds.y, bounds.width, bounds.height);
  }
  // Tiled object layers use draworder=index; preserve the compiled authoring order.
  for (const site of scene.sites) {
    const visual = frame.visuals[site.id], image = visual && frame.images.get(visual.image);
    if (image) ctx.drawImage(image, site.bounds.x, site.bounds.y, site.bounds.width, site.bounds.height);
  }
  const actor = frame.actor;
  if (actor) {
    const size = scene.actor?.size ?? 30;
    ctx.fillStyle = "rgba(18,38,26,.24)";
    ctx.beginPath(); ctx.ellipse(actor.x, actor.y - 2, size * .29, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixelSprite(actor.walking ? "walk" : "idle", actor.direction, actor.frame,
      { palette: "moss", head: null, neck: null }), actor.x - size / 2, actor.y - size, size, size);
  }
  if (frame.options.night) {
    ctx.fillStyle = "rgba(8,17,37,.56)"; ctx.fillRect(0, 0, scene.width, scene.height);
    ctx.globalCompositeOperation = "screen";
    for (const site of scene.sites) {
      if (!site.light || (frame.visuals[site.id]?.level ?? 0) < 1) continue;
      const { x, y } = site.light, radius = 115;
      const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
      light.addColorStop(0, "rgba(255,205,110,.53)");
      light.addColorStop(.23, "rgba(243,174,75,.27)");
      light.addColorStop(1, "rgba(219,154,65,0)");
      ctx.fillStyle = light; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  const selected = scene.sites.find(site => site.id === frame.options.selectedSiteId);
  if (selected) {
    ctx.strokeStyle = "rgba(255,231,160,.9)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(selected.entry.x, selected.entry.y + 3, 13, 4, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (frame.options.debug) {
    ctx.lineWidth = 1.5;
    for (const site of scene.sites) {
      ctx.strokeStyle = "#f9d866"; polygon(ctx, site.hitArea); ctx.stroke();
      ctx.fillStyle = "rgba(238,97,100,.16)"; ctx.strokeStyle = "#ee6164";
      polygon(ctx, site.collision); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "#ffffff99"; ctx.setLineDash([4, 4]);
      ctx.strokeRect(site.bounds.x, site.bounds.y, site.bounds.width, site.bounds.height); ctx.setLineDash([]);
      ctx.fillStyle = "#fff5c4"; ctx.beginPath(); ctx.arc(site.anchor.x, site.anchor.y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#91efb0"; ctx.beginPath(); ctx.arc(site.entry.x, site.entry.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = "#91efb0";
    for (const path of scene.paths) {
      ctx.beginPath(); path.points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke();
    }
    ctx.strokeStyle = "#c0dcff";
    ctx.strokeRect(scene.focus.x, scene.focus.y, scene.focus.width, scene.focus.height);
  }
  ctx.restore();
}

export async function createFixedWorldRenderer(
  worldCanvas: HTMLCanvasElement,
  circleCanvas: HTMLCanvasElement,
  scene: FixedWorldScene,
  initial: FixedWorldRenderOptions,
  callbacks: FixedWorldRenderCallbacks = {},
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const worldContext = worldCanvas.getContext("2d", { alpha: false });
  const circleContext = circleCanvas.getContext("2d", { alpha: true });
  if (!worldContext || !circleContext) throw new Error("Canvas 2D недоступен");
  const worldCtx = worldContext, circleCtx = circleContext;
  let options = { ...initial, levels: { ...initial.levels } }, disposed = false, ready = false;
  let worldView: Viewport = { width: 1, height: 1 }, circleView: Viewport = { width: 1, height: 1 };
  let camera: Camera = { x: scene.width / 2, y: scene.height / 2, zoom: 1 };
  let framing = "world", elapsed = 0, raf = 0, previous = 0, lastPaint = 0, frameNumber = 0;
  let resizeObserver: ResizeObserver | null = null, intersectionObserver: IntersectionObserver | null = null;
  const visible = new Map<HTMLCanvasElement, boolean>([[worldCanvas, true], [circleCanvas, true]]);
  const canPaint = () => !document.hidden && [...visible.values()].some(Boolean);
  const cleanup: Array<() => void> = [];
  const imagePromises = new Map<string, Promise<HTMLImageElement>>(), images = new Map<string, HTMLImageElement>();
  const cancelImages = new Set<() => void>();
  let visuals: Record<string, SiteVisual> = {}, requestVersion = 0, requestedKey: string | null = null;
  const route = createPreviewRoute(scene);
  let routeStatusKey = "";
  const reportStatus = (status: FixedWorldRenderStatus) => {
    for (const canvas of [worldCanvas, circleCanvas]) {
      canvas.dataset.loading = String(status.loading); canvas.dataset.error = status.error ?? "";
      canvas.dataset.requestedLevels = JSON.stringify(options.levels);
    }
    callbacks.onStatus?.(status);
  };
  const pointers = new Map<number, { initial: WorldPoint; position: WorldPoint }>();
  let travelled = 0, multitouch = false, cancelled = false;
  const minimumZoom = () => Math.min(worldView.width / scene.width, worldView.height / scene.height);
  const boundedCamera = (next: Camera): Camera => {
    const zoom = Math.max(minimumZoom(), Math.min(Math.max(4, minimumZoom() * 3), next.zoom));
    const bound = (value: number, extent: number, viewport: number) => viewport / zoom >= extent
      ? extent / 2 : Math.max(viewport / zoom / 2, Math.min(extent - viewport / zoom / 2, value));
    return { x: bound(next.x, scene.width, worldView.width), y: bound(next.y, scene.height, worldView.height), zoom };
  };
  const cameraFor = (bounds: WorldBounds, margin = 1) => boundedCamera({
    x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
    zoom: Math.min(worldView.width / bounds.width, worldView.height / bounds.height) / margin,
  });
  function frameCamera() {
    if (framing === "world") camera = cameraFor({ x: 0, y: 0, width: scene.width, height: scene.height }, 1.04);
    else if (framing === "home") camera = cameraFor(scene.focus, 1.3);
    else if (framing !== "manual") {
      const site = scene.sites.find(item => item.id === framing);
      if (site) camera = cameraFor(site.bounds, 2);
    } else camera = boundedCamera(camera);
  }
  const toWorld = (point: WorldPoint): WorldPoint => ({
    x: camera.x + (point.x - worldView.width / 2) / camera.zoom,
    y: camera.y + (point.y - worldView.height / 2) / camera.zoom,
  });
  function zoomAt(factor: number, anchor: WorldPoint) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const before = toWorld(anchor), next = boundedCamera({ ...camera, zoom: camera.zoom * factor });
    camera = boundedCamera({ ...next, x: before.x - (anchor.x - worldView.width / 2) / next.zoom,
      y: before.y - (anchor.y - worldView.height / 2) / next.zoom });
  }
  function loadImage(url: string): Promise<HTMLImageElement> {
    const cached = imagePromises.get(url);
    if (cached) return cached;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      let finished = false;
      const end = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer); cancelImages.delete(cancel);
        image.onload = null; image.onerror = null;
        if (error) { image.removeAttribute("src"); reject(error); }
        else { images.set(url, image); resolve(image); }
      };
      const cancel = () => end(new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(() => end(new Error("Изображение загружается слишком долго")), 20_000);
      cancelImages.add(cancel);
      image.decoding = "async";
      image.onload = () => image.naturalWidth && image.naturalHeight ? end() : end(new Error("Пустое изображение мира"));
      image.onerror = () => end(new Error("Не удалось загрузить изображение мира"));
      image.src = url;
    });
    imagePromises.set(url, promise);
    void promise.catch(() => { if (imagePromises.get(url) === promise) imagePromises.delete(url); });
    return promise;
  }
  async function prepareImages(force = false) {
    const next = Object.fromEntries(scene.sites.map(site => [site.id, previewSiteVisual(site, options.levels)]));
    const urls = [...new Set([...scene.terrain.map(image => image.image), ...Object.values(next).map(visual => visual.image)])];
    const key = JSON.stringify(Object.entries(next).map(([id, visual]) => [id, visual.level, visual.image]));
    if (!force && key === requestedKey) return;
    requestedKey = key;
    const version = ++requestVersion;
    if (!urls.every(url => images.has(url))) reportStatus({ loading: true, error: null });
    try {
      await Promise.all(urls.map(loadImage));
      if (disposed || version !== requestVersion) return;
      // A complete requested state replaces the previous complete frame atomically.
      visuals = next; ready = true;
      reportStatus({ loading: false, error: null }); draw(); animate();
    } catch (error) {
      if (disposed || version !== requestVersion) return;
      requestedKey = null;
      reportStatus({ loading: false, error: "Не удалось загрузить рисунок. Предыдущий вид сохранён; попробуйте ещё раз." });
      throw error;
    }
  }
  function draw() {
    if (disposed || !canPaint()) return;
    const actor = route.at(elapsed, !options.paused && !options.reducedMotion);
    const paintFrame: PaintFrame = { images, visuals, options, actor };
    worldCtx.setTransform(worldCanvas.width / worldView.width, 0, 0, worldCanvas.height / worldView.height, 0, 0);
    worldCtx.fillStyle = "#12231b"; worldCtx.fillRect(0, 0, worldView.width, worldView.height);
    worldCtx.save(); worldCtx.translate(worldView.width / 2, worldView.height / 2);
    worldCtx.scale(camera.zoom, camera.zoom); worldCtx.translate(-camera.x, -camera.y);
    if (ready) paintFixedWorld(worldCtx, scene, paintFrame); worldCtx.restore();
    circleCtx.setTransform(circleCanvas.width / circleView.width, 0, 0, circleCanvas.height / circleView.height, 0, 0);
    circleCtx.clearRect(0, 0, circleView.width, circleView.height);
    circleCtx.save(); circleCtx.beginPath();
    circleCtx.arc(circleView.width / 2, circleView.height / 2, Math.min(circleView.width, circleView.height) / 2, 0, Math.PI * 2); circleCtx.clip();
    circleCtx.fillStyle = "#12231b"; circleCtx.fillRect(0, 0, circleView.width, circleView.height);
    const circleZoom = Math.min(circleView.width / scene.focus.width, circleView.height / scene.focus.height);
    circleCtx.translate(circleView.width / 2, circleView.height / 2); circleCtx.scale(circleZoom, circleZoom);
    circleCtx.translate(-scene.focus.x - scene.focus.width / 2, -scene.focus.y - scene.focus.height / 2);
    if (ready) paintFixedWorld(circleCtx, scene, paintFrame); circleCtx.restore();
    const levels = JSON.stringify(Object.fromEntries(Object.entries(visuals).map(([id, visual]) => [id, visual.level])));
    frameNumber++;
    for (const canvas of [worldCanvas, circleCanvas]) {
      canvas.dataset.ready = String(ready); canvas.dataset.sceneId = scene.id; canvas.dataset.renderedLevels = levels;
      canvas.dataset.frame = String(frameNumber); canvas.dataset.actorX = String(actor?.x ?? ""); canvas.dataset.actorY = String(actor?.y ?? "");
      canvas.dataset.night = String(options.night); canvas.dataset.debug = String(options.debug);
      canvas.dataset.actorMoving = String(route.moving());
      canvas.dataset.pathId = route.status().pathId ?? "";
      canvas.dataset.actorSize = String(scene.actor?.size ?? 30);
    }
    const routeStatus = route.status(), nextRouteStatusKey = JSON.stringify(routeStatus);
    if (routeStatusKey !== nextRouteStatusKey) { routeStatusKey = nextRouteStatusKey; callbacks.onRouteChange?.(routeStatus); }
    worldCanvas.dataset.cameraX = String(camera.x); worldCanvas.dataset.cameraY = String(camera.y); worldCanvas.dataset.cameraZoom = String(camera.zoom);
  }
  function animate() {
    cancelAnimationFrame(raf); raf = 0; previous = 0; lastPaint = 0;
    if (!disposed && ready && !options.paused && !options.reducedMotion && route.moving() && canPaint()) raf = requestAnimationFrame(tick);
  }
  function tick(now: number) {
    raf = 0;
    if (disposed || !canPaint() || options.paused || options.reducedMotion || !route.moving()) return;
    if (previous) { const dt = Math.min((now - previous) / 1000, .08); elapsed += dt; route.advance(dt); }
    previous = now;
    if (now - lastPaint >= 1000 / 30 || !route.moving()) { draw(); lastPaint = now; }
    if (route.moving()) raf = requestAnimationFrame(tick);
  }
  function resize() {
    const resizeCanvas = (canvas: HTMLCanvasElement): Viewport => {
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 2200 / Math.max(width, height));
      const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      return { width, height };
    };
    worldView = resizeCanvas(worldCanvas); circleView = resizeCanvas(circleCanvas); frameCamera(); draw();
  }
  const pointerPoint = (event: { clientX: number; clientY: number }): WorldPoint => {
    const rect = worldCanvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * worldView.width / Math.max(1, rect.width),
      y: (event.clientY - rect.top) * worldView.height / Math.max(1, rect.height) };
  };
  const pair = () => [...pointers.values()].slice(0, 2).map(pointer => pointer.position);
  const midpoint = ([a, b]: WorldPoint[]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function down(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!pointers.size) { travelled = 0; multitouch = false; cancelled = false; }
    const point = pointerPoint(event); pointers.set(event.pointerId, { initial: point, position: point });
    multitouch ||= pointers.size > 1; worldCanvas.setPointerCapture(event.pointerId); worldCanvas.focus({ preventScroll: true });
  }
  function move(event: PointerEvent) {
    const pointer = pointers.get(event.pointerId); if (!pointer) return;
    const point = pointerPoint(event), before = pointer.position, oldPair = pair();
    travelled = Math.max(travelled, Math.hypot(point.x - pointer.initial.x, point.y - pointer.initial.y));
    pointer.position = point;
    if (pointers.size > 1) {
      const nextPair = pair(), oldDistance = Math.hypot(oldPair[0].x - oldPair[1].x, oldPair[0].y - oldPair[1].y);
      if (oldDistance > 2) {
        const oldCenter = midpoint(oldPair), center = midpoint(nextPair);
        zoomAt(Math.hypot(nextPair[0].x - nextPair[1].x, nextPair[0].y - nextPair[1].y) / oldDistance, oldCenter);
        camera = boundedCamera({ ...camera, x: camera.x - (center.x - oldCenter.x) / camera.zoom, y: camera.y - (center.y - oldCenter.y) / camera.zoom });
      }
    } else camera = boundedCamera({ ...camera, x: camera.x - (point.x - before.x) / camera.zoom, y: camera.y - (point.y - before.y) / camera.zoom });
    framing = "manual"; draw();
  }
  function end(event: PointerEvent) {
    const pointer = pointers.get(event.pointerId); if (!pointer) return;
    const point = pointerPoint(event);
    travelled = Math.max(travelled, Math.hypot(point.x - pointer.initial.x, point.y - pointer.initial.y));
    cancelled ||= event.type !== "pointerup"; pointers.delete(event.pointerId);
    if (!pointers.size && !cancelled && !multitouch && travelled < 8) {
      const site = previewSiteAt(scene, toWorld(point)); if (site) callbacks.onSelect?.(site.id);
    }
    if (worldCanvas.hasPointerCapture(event.pointerId)) worldCanvas.releasePointerCapture(event.pointerId);
  }
  function focus(siteId: string) {
    if (disposed || !(siteId === "world" || siteId === "home" || scene.sites.some(site => site.id === siteId))) return;
    framing = siteId; frameCamera(); draw();
  }
  function zoom(factor: number) {
    if (disposed) return;
    framing = "manual"; zoomAt(factor, { x: worldView.width / 2, y: worldView.height / 2 }); draw();
  }
  function wheel(event: WheelEvent) {
    event.preventDefault(); framing = "manual";
    zoomAt(Math.exp(-Math.max(-500, Math.min(500, event.deltaY)) * .0015), pointerPoint(event)); draw();
  }
  function key(event: KeyboardEvent) {
    const movement: Record<string, [number, number]> = { ArrowLeft: [-45, 0], ArrowRight: [45, 0], ArrowUp: [0, -45], ArrowDown: [0, 45] };
    const delta = movement[event.key];
    if (delta) {
      event.preventDefault(); framing = "manual";
      camera = boundedCamera({ ...camera, x: camera.x + delta[0] / camera.zoom, y: camera.y + delta[1] / camera.zoom }); draw();
    } else if (["+", "=", "-", "Home"].includes(event.key)) {
      event.preventDefault(); if (event.key === "Home") focus("home"); else zoom(event.key === "-" ? .8 : 1.25);
    }
  }
  function visibility() {
    if (document.hidden) {
      cancelled = true;
      for (const id of pointers.keys()) if (worldCanvas.hasPointerCapture(id)) worldCanvas.releasePointerCapture(id);
      pointers.clear();
    } else draw();
    animate();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; requestVersion++; cancelAnimationFrame(raf); raf = 0;
    resizeObserver?.disconnect(); intersectionObserver?.disconnect(); cleanup.forEach(remove => remove());
    for (const cancel of [...cancelImages]) cancel();
    for (const id of pointers.keys()) if (worldCanvas.hasPointerCapture(id)) worldCanvas.releasePointerCapture(id);
    pointers.clear(); images.clear(); imagePromises.clear();
  }
  const abort = () => dispose(); signal?.addEventListener("abort", abort, { once: true });
  cleanup.push(() => signal?.removeEventListener("abort", abort));
  for (const canvas of [worldCanvas, circleCanvas]) canvas.dataset.ready = "false";
  resize();
  try {
    await prepareImages();
    if (disposed) throw signal?.reason ?? new DOMException("Aborted", "AbortError");
  } catch (error) { dispose(); throw error; }
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(worldCanvas); resizeObserver.observe(circleCanvas);
  intersectionObserver = new IntersectionObserver(entries => {
    for (const entry of entries) visible.set(entry.target as HTMLCanvasElement, entry.isIntersecting);
    draw(); animate();
  });
  intersectionObserver.observe(worldCanvas); intersectionObserver.observe(circleCanvas);
  const oldTouchAction = worldCanvas.style.touchAction; worldCanvas.style.touchAction = "none";
  cleanup.push(() => { worldCanvas.style.touchAction = oldTouchAction; });
  worldCanvas.addEventListener("pointerdown", down); worldCanvas.addEventListener("pointermove", move);
  worldCanvas.addEventListener("wheel", wheel, { passive: false }); worldCanvas.addEventListener("keydown", key);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    worldCanvas.addEventListener(name, end); cleanup.push(() => worldCanvas.removeEventListener(name, end));
  }
  document.addEventListener("visibilitychange", visibility);
  cleanup.push(() => {
    worldCanvas.removeEventListener("pointerdown", down); worldCanvas.removeEventListener("pointermove", move);
    worldCanvas.removeEventListener("wheel", wheel); worldCanvas.removeEventListener("keydown", key);
    document.removeEventListener("visibilitychange", visibility);
  });
  resize(); animate();
  return {
    update(next: FixedWorldRenderOptions) {
      if (disposed) return;
      options = { ...next, levels: { ...next.levels } }; if (options.reducedMotion) route.settle(); draw(); animate();
      void prepareImages().catch(() => { /* The status callback exposes retry without losing the current artwork. */ });
    },
    focus, zoom,
    selectPath(pathId: string | null) {
      if (disposed) return false;
      const accepted = route.select(pathId);
      elapsed = 0; draw(); animate();
      return accepted;
    },
    startPath() {
      if (disposed) return false;
      const accepted = route.start(options.reducedMotion);
      if (accepted) { draw(); animate(); }
      return accepted;
    },
    reversePath() {
      if (disposed) return false;
      const accepted = route.reverse(options.reducedMotion);
      if (accepted) { draw(); animate(); }
      return accepted;
    },
    resetPath() { if (!disposed) { elapsed = 0; route.reset(); draw(); animate(); } },
    walkTo(siteId: string) {
      if (disposed) return false;
      const accepted = route.walkTo(siteId, options.reducedMotion);
      if (accepted) { draw(); animate(); }
      return accepted;
    },
    stroll() {
      if (disposed) return false;
      const accepted = route.stroll(options.reducedMotion);
      if (accepted) { draw(); animate(); }
      return accepted;
    },
    reset() { if (!disposed) { elapsed = 0; route.reset(); focus("world"); animate(); } },
    retry() { if (!disposed) void prepareImages(true).catch(() => {}); },
    dispose,
  };
}

export type FixedWorldRenderer = Awaited<ReturnType<typeof createFixedWorldRenderer>>;
