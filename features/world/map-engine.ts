import { drawForestSpeech } from "./forest-speech-painter";
import { mountHabitat, type SceneOptions } from "@/features/mochlik/scene";
import type { WorldResidentId } from "@/features/world/world-characters-model";
import { clampCamera, homeCamera, worldCamera, overviewCamera, HOME_AREA, MAP_SIZE, isMapTap, screenToWorld, viewportPoint, worldToScreen, zoomAt, type Point, type VerticalCameraInsets } from "./camera";
import { loadHabitatImage } from "@/features/mochlik/assets";
import { WORLD_ART } from "./art";
import { mapPlaceAt, worldToHome } from "./map-layout";
import { drawWaterAmbience } from "./water-ambience";
import { drawRouteProps } from "./route-props";
import { drawBoatWreck, prepareBoatWreck } from "./boat-wreck";
import { NEW_MAP_BOUNDS, NEW_MAP_FOCUS, TILED_WORLD, WORLD_PRESENTATION } from "./presentation";
import { WORLD_DEV_ENABLED, worldDevStore } from "./dev/world-dev-store";
import { mapObjectAt, type MapObjectPlace, type MapInteractiveObject } from "./site-interactions";
import { projectConstructionAnchor, type MapObjectScreenAnchor } from "./construction-map-anchor";
export class MapLoadError extends Error {
  constructor(public stage: "map" | "character", public cause: unknown) { super("Не удалось загрузить лес"); }
}
export type WorldPlace = MapObjectPlace | "journeys" | "wardrobe" | "river" | "trail" | "cave" | "fishing";
export type MapObjectSelection = { place: WorldPlace; objectId: string; x: number; y: number; viewportWidth: number; viewportHeight: number };
export type MapInteractionCallbacks = {
  onResident?: (id: WorldResidentId) => void;
  objectAnchorsEnabled?: boolean;
  onSelectionChange?: (selection: MapObjectSelection | null) => void;
  onObjectAnchorsChange?: (anchors: readonly MapObjectScreenAnchor[]) => void;
};
export type MapAction = "home" | "pet" | "overview" | "in" | "out" | "plesk" | "builder" | "fishing";
export type CameraHudElements = { top?: HTMLElement | null; bottom?: HTMLElement | null };
export async function createMapEngine(canvas: HTMLCanvasElement, initial: SceneOptions, onPlace: (place: WorldPlace, selection?: MapObjectSelection) => void, anchors: HTMLElement[], signal?: AbortSignal, cameraHud: CameraHudElements = {}, interactions: MapInteractionCallbacks = {}, speechCanvas?: HTMLCanvasElement | null) {
  let ground: HTMLImageElement;
  const rebuilding = WORLD_PRESENTATION.rebuilding;
  const bounds = rebuilding ? NEW_MAP_BOUNDS : { width: MAP_SIZE, height: MAP_SIZE };
  try {
    if (rebuilding) ground = await loadHabitatImage(TILED_WORLD.terrain[0].image);
    else [ground] = await Promise.all([loadHabitatImage(WORLD_ART.mapPreview), loadHabitatImage(WORLD_ART.homePreview)]);
  }
  catch (error) { throw new MapLoadError("map", error); }
  signal?.throwIfAborted();
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas unavailable");
  const speechContext = speechCanvas?.getContext("2d") ?? ctx;
  let options = initial, disposed = false, raf = 0, last = 0, redrawPending = false;
  let viewportRect: DOMRect | null = null;
  let dev = WORLD_DEV_ENABLED ? worldDevStore.getSnapshot() : undefined;
  const motionReduced = () => dev?.reducedMotion === "on" || dev?.reducedMotion !== "off" && options.reducedMotion;
  const paused = () => options.paused || Boolean(dev?.paused);
  let boatArt: HTMLCanvasElement | null = null;
  let cameraInsets: VerticalCameraInsets = { top: 0, bottom: 0 };
  const focusCamera = (viewport: { width: number; height: number }, close: boolean) => rebuilding
    ? clampCamera({ x: NEW_MAP_FOCUS.x + NEW_MAP_FOCUS.width / 2, y: NEW_MAP_FOCUS.y + NEW_MAP_FOCUS.height / 2,
      zoom: close ? Math.min(viewport.width / NEW_MAP_FOCUS.width, viewport.height / NEW_MAP_FOCUS.height)
        : Math.min(viewport.width / bounds.width, viewport.height / bounds.height) }, viewport, bounds, cameraInsets)
    : close ? homeCamera(viewport) : worldCamera(viewport);
  let view = { width: 1, height: 1 }, camera = focusCamera(view, false);
  let framing: "world" | "home" | "overview" | "manual" = "world";
  let inView = true;
  const home = document.createElement("canvas");
  type Touch = { initial: Point; position: Point; objectId?: string; capture: HTMLElement };
  const pointers = new Map<number, Touch>();
  let travelled = 0, multiTouch = false, cancelled = false;
  let selectedObjectId: string | null = null, selectionKey: string | null = null;
  let anchorsKey = "";
  let objectAnchorsEnabled = interactions.objectAnchorsEnabled ?? true;
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const habitatReady = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const habitat = mountHabitat(home, { ...initial, view: "world", backgrounded: Boolean(initial.backgrounded || document.hidden) }, {
    activity() {}, ready: readyResolve, failure: error => readyReject(new MapLoadError("character", error)),
    rendered: () => { if (motionReduced() || paused()) { if (pointers.size) requestDraw(); else draw(); } else updateSelection(); },
  });
  const abort = () => { disposed = true; habitat.dispose(); readyReject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
  try { await habitatReady; signal?.throwIfAborted(); }
  catch (error) { habitat.dispose(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
  let fullGround = rebuilding, upgradingGround = false;
  async function upgradeGround() {
    if (disposed || fullGround || upgradingGround) return;
    upgradingGround = true;
    try {
      const image = await loadHabitatImage(WORLD_ART.map, "low");
      if (disposed) return;
      if (image.naturalWidth !== MAP_SIZE || image.naturalHeight !== MAP_SIZE) throw new Error("Map dimensions do not match its manifest");
      ground = image; fullGround = true;
      if (!document.hidden && !options.backgrounded && inView && !options.paused) draw();
    } catch { /* Reconnect retries; the complete overview remains usable. */ }
    finally { upgradingGround = false; }
  }
  const retryGround = () => { if (!document.hidden && !options.backgrounded) void upgradeGround(); };
  window.addEventListener?.("online", retryGround); window.addEventListener?.("focus", retryGround);
  void upgradeGround();
  if (!rebuilding) void loadHabitatImage(WORLD_ART.boatWreck).then(image => {
    if (disposed) return;
    boatArt = prepareBoatWreck(image);
    if (!document.hidden && !options.backgrounded && inView && !options.paused) draw();
  }).catch(() => { /* An unavailable prop must not prevent visiting the forest. */ });
  function projectedSelection(objectId: string, objects = habitat.mapObjects?.() ?? []): MapObjectSelection | null {
    const object = objects.find(object => object.id === objectId);
    if (!object) return null;
    const point = worldToScreen(object.anchor, camera, view);
    if (point.x < 0 || point.x > view.width || point.y < 0 || point.y > view.height) return null;
    return { objectId, place: object.place, x: Math.round(point.x), y: Math.round(point.y),
      viewportWidth: view.width, viewportHeight: view.height };
  }
  function updateSelection(objects?: readonly MapInteractiveObject[]): MapObjectSelection | null {
    if (disposed) return null;
    const selection = selectedObjectId ? projectedSelection(selectedObjectId, objects) : null;
    if (!selection) selectedObjectId = null;
    const key = selection ? JSON.stringify(selection) : null;
    if (key !== selectionKey) { selectionKey = key; interactions.onSelectionChange?.(selection); }
    return selection;
  }
  function setSelectedObject(objectId: string | null) {
    selectedObjectId = objectId;
    updateSelection();
  }
  function updateObjectAnchors(objects: readonly MapInteractiveObject[]) {
    if (disposed || !objectAnchorsEnabled || !interactions.onObjectAnchorsChange) return;
    const projected = objects.flatMap(object => {
      const anchor = projectConstructionAnchor(object, camera, view, cameraInsets);
      return anchor ? [anchor] : [];
    });
    const key = JSON.stringify(projected);
    if (key !== anchorsKey) { anchorsKey = key; interactions.onObjectAnchorsChange(projected); }
  }
  function activateObject(objectId: string) {
    const object = habitat.mapObjects?.().find(object => object.id === objectId);
    if (!object) return false;
    if (!projectedSelection(objectId)) {
      framing = "manual";
      camera = clampCamera({ ...camera, x: object.anchor.x, y: object.anchor.y }, view, bounds, cameraInsets);
    }
    if (object.place === "plesk-shop") {
      setSelectedObject(null);
      habitat.visitTradingPlace?.("plesk");
      draw();
      if (interactions.onResident) interactions.onResident("plesk");
      else onPlace("plesk-shop");
      return true;
    }
    selectedObjectId = objectId;
    const selection = updateSelection();
    if (!selection) return false;
    // A deliberate house activation reaches the resident even behind its PNG,
    // while retaining the same building menu. Camera changes never take this path.
    if (object.place === "house") habitat.wakeHomeResident?.();
    draw();
    onPlace(selection.place, selection);
    return true;
  }
  function draw() {
    if (disposed || !ctx) return;
    redrawPending = false;
    if (!pointers.size) viewportRect = null;
    const ratio = canvas.width / view.width;
    ctx.setTransform(ratio, 0, 0, canvas.height / view.height, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "low";
    ctx.fillStyle = "#13231a"; ctx.fillRect(0, 0, view.width, view.height);
    ctx.translate(view.width / 2, view.height / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
    if (rebuilding) habitat.paintWorld?.(ctx);
    else {
      // Both views share the detailed tile and fixed world anchors. Its outer rim
      // contains the original map pixels; animation coordinates remain unchanged.
      ctx.drawImage(ground, 0, 0, MAP_SIZE, MAP_SIZE);
      const weather = habitat.ambience();
      drawWaterAmbience(ctx, weather.elapsed, options.reducedMotion, weather.rain);
      if (boatArt) drawBoatWreck(ctx, boatArt);
      drawRouteProps(ctx);
      habitat.paintVisitors(ctx, "ground");
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, MAP_SIZE, MAP_SIZE);
      ctx.rect(HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size); ctx.clip("evenodd");
      habitat.paintJourney(ctx); ctx.restore();
      habitat.paintLighting(ctx);
      ctx.drawImage(home, HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size);
      habitat.paintVisitors(ctx, "air");
      habitat.paintWeather(ctx);
    }
    speechContext.setTransform(ratio, 0, 0, canvas.height / view.height, 0, 0);
    if (speechContext !== ctx) speechContext.clearRect(0, 0, view.width, view.height);
    drawForestSpeech(speechContext, (habitat.speechFrames?.() ?? []).map(frame => ({ ...frame,
      anchor: worldToScreen(frame.anchor, camera, view) })), { ...view, insets: cameraInsets,
      reducedMotion: motionReduced(), night: options.dusk });
    const objects = habitat.mapObjects?.() ?? [];
    for (const node of anchors) {
      // Keyboard/touch shortcuts follow the geometry committed with the visible artwork.
      const anchor = rebuilding ? node.dataset.objectId
        ? objects.find(object => object.id === node.dataset.objectId)?.anchor
        : habitat.siteAnchor?.(node.dataset.siteId ?? "")
        : { x: Number(node.dataset.x), y: Number(node.dataset.y) };
      if (!anchor) { if (node.style.visibility !== "hidden") node.style.visibility = "hidden"; continue; }
      const point = worldToScreen(anchor, camera, view);
      const transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
      if (node.style.transform !== transform) node.style.transform = transform;
      // At region scale, the small bush target would overlap the house button.
      const smallDetail = node.dataset.kind === "bush" && HOME_AREA.size * camera.zoom < 200;
      const visibility = smallDetail || point.x < -60 || point.y < 0 || point.x > view.width + 60 || point.y > view.height + 50 ? "hidden" : "visible";
      if (node.style.visibility !== visibility) node.style.visibility = visibility;
    }
    updateSelection(objects);
    updateObjectAnchors(objects);
  }
  function requestDraw() {
    if (disposed || document.hidden || !inView || options.backgrounded) return;
    redrawPending = true;
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick(time: number) {
    raf = 0;
    if (disposed || document.hidden || !inView || options.backgrounded) return;
    // Input updates the camera immediately, but a burst of pointer events gets
    // one paint in the next browser frame, shared with ambient animation.
    if (redrawPending || !paused() && time - last >= 1000 / 30) {
      draw(); last = time;
    }
    if (!motionReduced() && !paused() && !raf) raf = requestAnimationFrame(tick);
  }
  function visibility() {
    if (document.hidden) {
      cancelled = true;
      for (const [id, touch] of pointers) if (touch.capture.hasPointerCapture(id)) touch.capture.releasePointerCapture(id);
      pointers.clear();
    }
    cancelAnimationFrame(raf); raf = 0;
    const backgrounded = Boolean(options.backgrounded || document.hidden || !inView);
    habitat.configure({ ...options, view: "world", backgrounded });
    if (!disposed && !backgrounded) { draw(); if (!motionReduced() && !paused() && !raf) raf = requestAnimationFrame(tick); }
  }
  function resize() {
    if (disposed) return;
    viewportRect = null;
    // CSS entrance scaling changes the visual rect, not the map's layout viewport.
    view = { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) };
    // Both HUDs are anchored to the viewport edges. Layout height includes their
    // safe-area padding and avoids entrance transforms changing the pan limits.
    cameraInsets = { top: cameraHud.top?.offsetHeight ?? 0, bottom: cameraHud.bottom?.offsetHeight ?? 0 };
    const scale = Math.min(window.devicePixelRatio || 1, 2, 2200 / Math.max(view.width, view.height));
    canvas.width = Math.round(view.width * scale); canvas.height = Math.round(view.height * scale);
    if (speechCanvas) { speechCanvas.width = canvas.width; speechCanvas.height = canvas.height; }
    camera = framing === "world" ? focusCamera(view, false) : framing === "home" ? focusCamera(view, true) : framing === "overview" ? overviewCamera(view, bounds) : clampCamera(camera, view, bounds, cameraInsets); draw();
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas);
  if (cameraHud.top) resizeObserver.observe(cameraHud.top, { box: "border-box" });
  if (cameraHud.bottom) resizeObserver.observe(cameraHud.bottom, { box: "border-box" });
  resize();
  const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility(); }); observer.observe(canvas);
  const point = (event: Pick<PointerEvent, "clientX" | "clientY">): Point => {
    // Marker transforms are written during paint. Re-reading layout on every
    // move forces the browser to flush those writes during high-rate input.
    viewportRect ??= canvas.getBoundingClientRect();
    return viewportPoint({ x: event.clientX, y: event.clientY }, viewportRect, view);
  };
  const invalidateViewportRect = () => { viewportRect = null; };
  window.addEventListener?.("scroll", invalidateViewportRect, true);
  const markerObjectIds = new Set(anchors.flatMap(node => node.dataset.objectId ? [node.dataset.objectId] : []));
  function nearestMarkerObject(p: Point): string | undefined {
    let nearest: string | undefined, distance = Infinity;
    for (const object of habitat.mapObjects?.() ?? []) {
      if (!markerObjectIds.has(object.id)) continue;
      const projected = worldToScreen(object.anchor, camera, view);
      if (projected.x < -60 || projected.y < 0 || projected.x > view.width + 60 || projected.y > view.height + 50) continue;
      const candidateDistance = (Math.round(projected.x) - p.x) ** 2 + (Math.round(projected.y) - p.y) ** 2;
      if (candidateDistance <= 43 ** 2 && candidateDistance < distance) { nearest = object.id; distance = candidateDistance; }
    }
    return nearest;
  }
  const separation = () => { const pair = [...pointers.values()].slice(0, 2); return pair.length === 2 ? Math.hypot(pair[0].position.x - pair[1].position.x, pair[0].position.y - pair[1].position.y) : 0; };
  const midpoint = () => { const pair = [...pointers.values()].slice(0, 2); return { x: (pair[0].position.x + pair[1].position.x) / 2, y: (pair[0].position.y + pair[1].position.y) / 2 }; };
  function down(event: PointerEvent, objectId?: string, target: HTMLElement = canvas) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!pointers.size) { travelled = 0; multiTouch = false; cancelled = false; viewportRect = null; }
    const p = point(event);
    // Large touch targets overlap in the phone overview. Resolve the closest
    // rendered marker, independently of which DOM button received the press.
    // Keep capture on the original button on touch devices: transferring it to
    // a sibling canvas competes with the browser's implicit touch capture.
    const capture = typeof target.setPointerCapture === "function" ? target : canvas;
    pointers.set(event.pointerId, { initial: p, position: p, objectId: objectId ? nearestMarkerObject(p) : undefined, capture });
    multiTouch ||= pointers.size > 1; capture.setPointerCapture(event.pointerId); capture.focus?.({ preventScroll: true });
  }
  function move(event: PointerEvent) {
    const touch = pointers.get(event.pointerId); if (!touch) return;
    const p = point(event), before = touch.position, oldDistance = separation();
    const oldCenter = pointers.size >= 2 ? midpoint() : null;
    framing = "manual";
    travelled = Math.max(travelled, Math.hypot(p.x - touch.initial.x, p.y - touch.initial.y));
    touch.position = p;
    if (oldCenter && oldDistance > 2) {
      camera = zoomAt(camera, view, oldCenter, separation() / oldDistance, bounds, cameraInsets);
      const center = midpoint(); camera = clampCamera({ ...camera, x: camera.x - (center.x - oldCenter.x) / camera.zoom, y: camera.y - (center.y - oldCenter.y) / camera.zoom }, view, bounds, cameraInsets);
    } else camera = clampCamera({ ...camera, x: camera.x - (p.x - before.x) / camera.zoom, y: camera.y - (p.y - before.y) / camera.zoom }, view, bounds, cameraInsets);
    requestDraw();
  }
  function end(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    cancelled ||= event.type === "pointercancel" || event.type === "lostpointercapture";
    const p = point(event), touch = pointers.get(event.pointerId)!;
    travelled = Math.max(travelled, Math.hypot(p.x - touch.initial.x, p.y - touch.initial.y));
    pointers.delete(event.pointerId);
    if (!pointers.size && isMapTap(travelled, multiTouch, cancelled)) {
      const world = screenToWorld(p, camera, view);
      if (rebuilding) {
        const petPoint = { x: (world.x - NEW_MAP_FOCUS.x) / NEW_MAP_FOCUS.width,
          y: (world.y - NEW_MAP_FOCUS.y) / NEW_MAP_FOCUS.height };
        const objects = habitat.mapObjects?.() ?? [];
        const markerObject = touch.objectId ? objects.find(object => object.id === touch.objectId) : null;
        // Artwork hidden by a foreground canopy is not a building touch target.
        // Explicit production/status markers remain their own visible controls.
        const visibleSite = habitat.hitSite?.(world);
        const object = mapObjectAt(habitat.hitSite ? objects.filter(object => object.kind !== "site" || object.id === visibleSite) : objects, world);
        const resident = interactions.onResident ? habitat.hitResident?.(world.x, world.y) : null;
        if (resident) { setSelectedObject(null); habitat.noticeResident?.(resident); interactions.onResident?.(resident); }
        else if (habitat.hitVisiblePet?.(petPoint.x, petPoint.y)) { setSelectedObject(null); habitat.notice(); }
        else if (markerObject) activateObject(markerObject.id);
        else if (object) activateObject(object.id);
        else {
          setSelectedObject(null);
          if (habitat.hitPet(petPoint.x, petPoint.y)) habitat.notice();
        }
      } else {
        const { x, y } = worldToHome(world);
        const place = mapPlaceAt(world);
        if (place === "cave" || place === "fishing") onPlace(place);
        else if (habitat.hitPet(x, y)) onPlace("wardrobe");
        else if (place === "house") onPlace("house");
        else if (place === "bush") habitat.invite("bush");
        else if (x >= 0 && x <= 1 && y >= 0 && y <= 1) habitat.moveTo(x, y);
      }
    }
    if (touch.capture.hasPointerCapture(event.pointerId)) touch.capture.releasePointerCapture(event.pointerId);
    requestDraw();
  }
  function wheel(event: WheelEvent) { event.preventDefault(); framing = "manual"; camera = zoomAt(camera, view, point(event), Math.exp(-event.deltaY * .0015), bounds, cameraInsets); requestDraw(); }
  function control(action: MapAction) {
    framing = action === "home" || action === "overview" ? action : "manual";
    if (action === "plesk" || action === "builder" || action === "fishing") {
      const target = habitat.inspectPoint?.(action);
      if (target) camera = clampCamera({ ...target, zoom: Math.max(camera.zoom, focusCamera(view, true).zoom) }, view, bounds, cameraInsets);
      draw(); return;
    }
    camera = action === "pet" ? clampCamera({ ...habitat.position(), zoom: Math.max(camera.zoom, focusCamera(view, true).zoom) }, view, bounds, cameraInsets)
      : action === "home" ? focusCamera(view, true) : action === "overview" ? overviewCamera(view, bounds) : zoomAt(camera, view, { x: view.width / 2, y: view.height / 2 }, action === "in" ? 1.25 : .8, bounds, cameraInsets); draw();
  }
  function key(event: KeyboardEvent) {
    const delta = { ArrowUp: [0, -40], ArrowDown: [0, 40], ArrowLeft: [-40, 0], ArrowRight: [40, 0] }[event.key];
    if (delta) { event.preventDefault(); framing = "manual"; camera = clampCamera({ ...camera, x: camera.x + delta[0] / camera.zoom, y: camera.y + delta[1] / camera.zoom }, view, bounds, cameraInsets); draw(); }
    else if (["+", "=", "-", "Home"].includes(event.key)) { event.preventDefault(); control(event.key === "Home" ? "pet" : event.key === "-" ? "out" : "in"); }
  }
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, end);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
  // Markers are real touch targets as well as keyboard buttons. Native touch
  // capture keeps their move/up events on the marker, so handle the whole
  // gesture there. React's detail=0 click remains the keyboard/AT fallback.
  const markerListeners = anchors.filter(node => node.dataset.objectId).map(node => {
    const pointerDown = (event: PointerEvent) => down(event, node.dataset.objectId, node);
    node.addEventListener?.("pointerdown", pointerDown);
    node.addEventListener?.("pointermove", move);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) node.addEventListener?.(name, end);
    return () => {
      node.removeEventListener?.("pointerdown", pointerDown);
      node.removeEventListener?.("pointermove", move);
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) node.removeEventListener?.(name, end);
    };
  });
  // Controls may have changed while the scene's selected artwork was loading.
  if (WORLD_DEV_ENABLED) dev = worldDevStore.getSnapshot();
  document.addEventListener("visibilitychange", visibility); visibility();
  // An absolute DEV target chosen in the circle survives opening the full map.
  if (dev?.cameraEvent?.action === "plesk" || dev?.cameraEvent?.action === "builder" || dev?.cameraEvent?.action === "fishing") control(dev.cameraEvent.action);
  const unsubscribeDev = WORLD_DEV_ENABLED ? worldDevStore.subscribe(() => {
    if (disposed) return;
    const previousCamera = dev?.cameraEvent?.id;
    dev = worldDevStore.getSnapshot();
    cancelAnimationFrame(raf); raf = 0;
    if (!document.hidden && !options.backgrounded && inView) {
      if (dev.cameraEvent && dev.cameraEvent.id !== previousCamera) control(dev.cameraEvent.action);
      else draw();
      if (!motionReduced() && !paused() && !raf) raf = requestAnimationFrame(tick);
    }
  }) : () => {};
  return {
    control,
    activateObject,
    setSelectedObject,
    setObjectAnchorsEnabled(enabled: boolean) {
      if (disposed || enabled === objectAnchorsEnabled) return;
      objectAnchorsEnabled = enabled; anchorsKey = "";
      if (enabled) requestDraw();
      else interactions.onObjectAnchorsChange?.([]);
    },
    setTime(now: number) { habitat.setTime(now); },
    update(next: SceneOptions) {
      options = next;
      visibility();
    },
    notice() { habitat.notice(); draw(); },
    visitBush() { habitat.invite("bush"); draw(); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); unsubscribeDev(); habitat.dispose(); resizeObserver.disconnect(); observer.disconnect();
      if (speechCanvas && speechContext !== ctx) {
        speechContext.setTransform(1, 0, 0, 1, 0, 0); speechContext.clearRect(0, 0, speechCanvas.width, speechCanvas.height);
      }
      markerListeners.forEach(remove => remove());
      for (const [id, touch] of pointers) if (touch.capture.hasPointerCapture(id)) touch.capture.releasePointerCapture(id);
      pointers.clear();
      window.removeEventListener?.("scroll", invalidateViewportRect, true);
      window.removeEventListener?.("online", retryGround); window.removeEventListener?.("focus", retryGround);
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.removeEventListener(name, end);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); document.removeEventListener("visibilitychange", visibility);
    },
  };
}
