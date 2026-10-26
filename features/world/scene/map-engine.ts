import { drawForestSpeech } from "@/features/world/characters/social/forest-speech-painter";
import { mountHabitat, type SceneOptions } from "@/features/mochlik/scene";
import type { WorldResidentId } from "@/features/world/characters/world-characters-model";
import { clampCamera, homeCamera, worldCamera, overviewCamera, HOME_AREA, MAP_SIZE, isMapTap, screenToWorld, viewportPoint, worldToScreen, zoomAt, type Point, type Camera, type VerticalCameraInsets } from "./camera";
import { loadHabitatImage } from "@/features/mochlik/assets";
import { WORLD_ART } from "./art";
import { mapPlaceAt, worldToHome } from "@/features/world/legacy/map-layout";
import { drawWaterAmbience } from "@/features/world/legacy/water-ambience";
import { drawRouteProps } from "@/features/world/legacy/route-props";
import { drawBoatWreck, prepareBoatWreck } from "@/features/world/legacy/boat-wreck";
import { NEW_MAP_BOUNDS, NEW_MAP_FOCUS, TILED_WORLD, WORLD_PRESENTATION } from "./presentation";
import { WORLD_DEV_ENABLED, worldDevStore } from "@/features/world/dev/world-dev-store";
import { tradeShipCamera } from "./trade-ship-camera";
import { retainWorldDevClientState } from "@/features/world/dev/world-dev-hmr-cache";
import { WORLD_LIGHTING_EDITOR_CANCEL_EVENT, worldLightingEditorStore } from "@/features/world/dev/world-lighting-editor-store";
import { createWorldLightingEditorMap, WORLD_LIGHTING_EDITOR_FOCUS_EVENT, takeWorldLightingEditorFocus, WORLD_STUDIO_CREATE_EVENT, takeWorldStudioCreate, type WorldStudioCreateKind, type WorldLightingEditorFocus } from "@/features/world/dev/world-lighting-editor-map";
import { WORLD_STUDIO_MAP_KEY_EVENT, type WorldStudioMapKeyRequest } from "@/features/world/dev/world-studio-keyboard";
import { mapObjectAt, type MapObjectPlace, type MapInteractiveObject } from "./site-interactions";
import { projectConstructionAnchor, type MapObjectScreenAnchor } from "./construction-map-anchor";
import { drawMapGuideTarget, mapGuideCamera, minerArrivalGuideTarget, leaftailArrivalGuideTarget, lopukhArrivalGuideTarget } from "./map-guide-target";
import { createMapSceneRehearsal } from "./map-scene-rehearsal";
import { worldFrameDue } from "./frame-timing";
import { sameSceneOptions } from "./scene-options";
import { createMapPanSurface } from "./map-pan-surface";
import { withExpandedCanvasViewport } from "./canvas-viewport-compatibility";
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
  objectMarkerHeight?: (place: MapObjectPlace) => number;
};
export type MapAction = "home" | "pet" | "overview" | "in" | "out" | "plesk" | "builder" | "fishing" | "ship";
export type CameraHudElements = { top?: HTMLElement | null; bottom?: HTMLElement | null };
type MapFraming = "world" | "home" | "overview" | "manual" | "guide";
type StudioViewport = { camera: Camera; framing: MapFraming };
// A refresh reuses the DOM canvas; closing the world creates a new one. Weak
// keys retain neither discarded canvases nor production/account state.
const studioViewports = WORLD_DEV_ENABLED ? retainWorldDevClientState("studio-map-viewports",
  `v1:1:${TILED_WORLD.id}:${TILED_WORLD.width}:${TILED_WORLD.height}`,
  () => new WeakMap<HTMLCanvasElement, StudioViewport>()).value : null;
export async function createMapEngine(canvas: HTMLCanvasElement, initial: SceneOptions, onPlace: (place: WorldPlace, selection?: MapObjectSelection) => void, anchors: HTMLElement[], signal?: AbortSignal, cameraHud: CameraHudElements = {}, interactions: MapInteractionCallbacks = {}, speechCanvas?: HTMLCanvasElement | null, viewportRoot?: HTMLElement | null) {
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
  let speechSurfaceDirty = speechContext !== ctx;
  let options = initial, disposed = false, raf = 0, last = 0, redrawPending = false;
  const viewportElement = viewportRoot ?? canvas;
  const panSurface = createMapPanSurface(canvas);
  let normalBacking = { width: 1, height: 1 };
  let rasterCamera: Camera | null = null, panBlocked = false;
  let viewportRect: DOMRect | null = null;
  let dev = WORLD_DEV_ENABLED && !initial.readOnly ? worldDevStore.getSnapshot() : undefined;
  const initialCameraEventId = dev?.cameraEvent?.id;
  let focusedShipArrival: string | null = null;
  let queuedShipArrival: string | null = null;
  const motionReduced = () => dev?.reducedMotion === "on" || dev?.reducedMotion !== "off" && options.reducedMotion;
  const paused = () => options.paused || Boolean(dev?.paused);
  let boatArt: HTMLCanvasElement | null = null;
  let cameraInsets: VerticalCameraInsets = { top: 0, bottom: 0 };
  const focusCamera = (viewport: { width: number; height: number }, close: boolean) => rebuilding
    ? clampCamera({ x: NEW_MAP_FOCUS.x + NEW_MAP_FOCUS.width / 2, y: NEW_MAP_FOCUS.y + NEW_MAP_FOCUS.height / 2,
      zoom: close ? Math.min(viewport.width / NEW_MAP_FOCUS.width, viewport.height / NEW_MAP_FOCUS.height)
        : Math.min(viewport.width / bounds.width, viewport.height / bounds.height) }, viewport, bounds, cameraInsets)
    : close ? homeCamera(viewport) : worldCamera(viewport);
  let studioWasActive = !initial.readOnly && WORLD_DEV_ENABLED && worldLightingEditorStore.getSnapshot().enabled;
  const retainedViewport = studioWasActive ? studioViewports?.get(canvas) : undefined;
  let restoreStudioViewport = Boolean(retainedViewport);
  let view = { width: 1, height: 1 }, camera = retainedViewport ? { ...retainedViewport.camera } : focusCamera(view, false);
  let framing: MapFraming = retainedViewport?.framing ?? "world";
  let guidePlace: MapObjectPlace | null = null, guideBottomInset = 0;
  let followedArrival = false;
  const guideInsets = () => ({ ...cameraInsets, bottom: Math.max(cameraInsets.bottom, guideBottomInset) });
  let inView = true;
  const home = document.createElement("canvas");
  type Touch = { initial: Point; position: Point; objectId?: string; capture: HTMLElement; editor?: boolean; additive?: boolean };
  const pointers = new Map<number, Touch>();
  let pendingEditorMove: Point | null = null;
  let travelled = 0, multiTouch = false, cancelled = false;
  let selectedObjectId: string | null = null, selectionKey: string | null = null;
  let anchorsKey = "";
  let anchorProjection: { objects: readonly MapInteractiveObject[]; camera: Camera; width: number; height: number;
    top: number; bottom: number; markerHeights: (number | undefined)[] } | null = null;
  let objectAnchorsEnabled = interactions.objectAnchorsEnabled ?? true;
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const habitatReady = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let habitat = mountHabitat(home, { ...initial, view: "world", backgrounded: Boolean(initial.backgrounded || document.hidden) }, {
    activity() {}, ready: readyResolve, failure: error => readyReject(new MapLoadError("character", error)),
    rendered: () => { if (motionReduced() || paused()) { if (pointers.size) requestDraw(); else draw(); } else updateSelection(); },
  });
  const lightingEditor = createWorldLightingEditorMap(() => habitat.lightingCasters?.() ?? [], worldLightingEditorStore,
    { getLights: () => habitat.lightingLights?.() ?? [], getReceivers: () => habitat.lightingReceivers?.() ?? [], onFocus: focusLighting });
  const editingLight = () => !options.readOnly && WORLD_DEV_ENABLED && rebuilding && worldLightingEditorStore.getSnapshot().enabled;
  function studioUsableRectangle() {
    type Rectangle = { left: number; right: number; top: number; bottom: number };
    const safe: Rectangle = { left: 20, right: view.width - 20, top: cameraInsets.top + 16, bottom: view.height - cameraInsets.bottom - 16 };
    const selector = "[data-world-lighting-studio-panel],[data-world-studio-panel]";
    const single = document.querySelector?.<HTMLElement>(selector);
    const panels = document.querySelectorAll ? [...document.querySelectorAll<HTMLElement>(selector)] : single ? [single] : [];
    if (!panels.length) return safe;
    const viewport = viewportElement.getBoundingClientRect();
    let candidates = [safe];
    for (const node of panels) {
      const panel = node.getBoundingClientRect();
      if (!(panel.width > 0 && panel.height > 0)) continue;
      const left = (panel.left - viewport.left) * view.width / Math.max(1, viewport.width) - 16;
      const right = left + panel.width * view.width / Math.max(1, viewport.width) + 32;
      const top = (panel.top - viewport.top) * view.height / Math.max(1, viewport.height) - 16;
      const bottom = top + panel.height * view.height / Math.max(1, viewport.height) + 32;
      candidates = candidates.flatMap(rect => {
        if (left >= rect.right || right <= rect.left || top >= rect.bottom || bottom <= rect.top) return [rect];
        return [
          { ...rect, right: Math.min(rect.right, left) }, { ...rect, left: Math.max(rect.left, right) },
          { ...rect, bottom: Math.min(rect.bottom, top) }, { ...rect, top: Math.max(rect.top, bottom) },
        ].filter(part => part.right > part.left && part.bottom > part.top);
      });
    }
    return candidates.sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top))[0] ?? safe;
  }
  function createStudioElement(kind: WorldStudioCreateKind | null) {
    if (!kind || disposed || !editingLight() || !worldLightingEditorStore.getSnapshot().previewDraft) return;
    lightingEditor.cancel();
    const safe = studioUsableRectangle();
    const point = screenToWorld({ x: (safe.left + safe.right) / 2, y: (safe.top + safe.bottom) / 2 }, camera, view);
    const created = kind === "receiver-hole" ? lightingEditor.createReceiverHole(point)
      : kind === "caster" ? worldLightingEditorStore.addCaster(point) : worldLightingEditorStore.addReceiver(point);
    if (created) { if (kind !== "receiver-hole") worldLightingEditorStore.setTool("move"); requestDraw(); canvas.focus?.({ preventScroll: true }); }
  }
  function focusLighting(request: WorldLightingEditorFocus) {
    if (disposed || !editingLight() || !Number.isFinite(request.point?.x) || !Number.isFinite(request.point?.y)) return;
    const safe = studioUsableRectangle();
    const width = Math.max(100, safe.right - safe.left), height = Math.max(100, safe.bottom - safe.top);
    const box = request.bounds;
    const zoom = box && Number.isFinite(box.width) && Number.isFinite(box.height)
      ? Math.min(width / Math.max(50, box.width + 40), height / Math.max(50, box.height + 40)) : Math.max(camera.zoom, 2);
    const bounded = clampCamera({ ...camera, zoom }, view, bounds, cameraInsets);
    // Constrain the world to the usable rectangle, not to the hidden area under
    // the studio. Near map edges the full-viewport clamp would hide the target.
    const focused = clampCamera({ x: request.point.x, y: request.point.y, zoom: bounded.zoom }, { width, height }, bounds);
    framing = "manual";
    camera = { zoom: focused.zoom,
      x: focused.x + (view.width / 2 - safe.left - width / 2) / focused.zoom,
      y: focused.y + (view.height / 2 - safe.top - height / 2) / focused.zoom };
    draw(); canvas.focus?.({ preventScroll: true });
  }
  const abort = () => { disposed = true; habitat.dispose(); readyReject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
  try { await habitatReady; signal?.throwIfAborted(); }
  catch (error) { habitat.dispose(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
  const naturalHabitat = habitat;
  let naturalViewport: { camera: Camera; framing: MapFraming } | null = null;
  const rehearsal = createMapSceneRehearsal({ natural: naturalHabitat, mount: mountHabitat,
    select(scene, request) {
      if (disposed) return;
      if (request && habitat === naturalHabitat) naturalViewport = { camera: { ...camera }, framing };
      habitat = scene;
      if (request) {
        const point = request.actor === "mochlik" ? habitat.position() : habitat.inspectPoint?.(request.actor);
        if (point) { framing = "manual"; camera = clampCamera({ ...camera, ...point, zoom: Math.max(camera.zoom, 2) }, view, bounds, cameraInsets); }
      } else if (naturalViewport) {
        camera = naturalViewport.camera; framing = naturalViewport.framing; naturalViewport = null;
      }
      draw();
    },
    rendered: () => { if (!disposed) requestDraw(); },
    failed: id => worldDevStore.reportScene(id, "blocked", "Не удалось загрузить репетицию. Попробуй ещё раз."),
  });
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
  function setGuidePlace(place: MapObjectPlace | null, bottomInset = 0) {
    if (disposed || place === guidePlace && bottomInset === guideBottomInset) return;
    const changed = place !== guidePlace;
    guidePlace = place; guideBottomInset = bottomInset;
    const object = currentGuideTarget();
    if (object && (changed || framing === "guide")) {
      framing = "guide";
      camera = mapGuideCamera(object, view, bounds, guideInsets());
    } else if (!place && framing === "guide") framing = "manual";
    draw();
  }
  function arrivalTarget() {
    if (guidePlace === "lopukh-home" && options.lopukhArrival?.enabled && !options.lopukhArrival.seen && !editingLight()) {
      const point = habitat.lopukhArrivalPoint?.();
      return point ? lopukhArrivalGuideTarget(point) : undefined;
    }
    if (guidePlace === "leaftail-caravan" && options.merchantArrival?.enabled && !options.merchantArrival.seen && !editingLight()) {
      const point = habitat.merchantArrivalPoint?.();
      return point ? leaftailArrivalGuideTarget(point) : undefined;
    }
    if (guidePlace !== "quarry" || !options.residentArrival?.enabled || options.residentArrival.seen || editingLight()) return;
    const point = habitat.residentArrivalPoint?.();
    return point ? minerArrivalGuideTarget(point) : undefined;
  }
  function currentGuideTarget(objects = habitat.mapObjects?.() ?? []) {
    return arrivalTarget() ?? (guidePlace ? objects.find(object => object.place === guidePlace) : undefined);
  }
  function updateObjectAnchors(objects: readonly MapInteractiveObject[]) {
    if (disposed || !objectAnchorsEnabled || !interactions.onObjectAnchorsChange) return;
    if (editingLight()) {
      anchorProjection = null;
      if (anchorsKey !== "lighting-editor") { anchorsKey = "lighting-editor"; interactions.onObjectAnchorsChange([]); }
      return;
    }
    // Timers may change their actual height without moving the camera. Sample
    // those small values, but leave unchanged geometry/projections alone during
    // ambient frames. Tiled/preview objects keep their identity until replaced.
    const previous = anchorProjection;
    const markerHeights = previous?.objects === objects ? previous.markerHeights : [];
    let unchanged = Boolean(previous && previous.objects === objects && previous.camera.x === camera.x
      && previous.camera.y === camera.y && previous.camera.zoom === camera.zoom && previous.width === view.width
      && previous.height === view.height && previous.top === cameraInsets.top && previous.bottom === cameraInsets.bottom);
    for (let index = 0; index < objects.length; index++) {
      const height = interactions.objectMarkerHeight?.(objects[index].place);
      if (markerHeights[index] !== height) unchanged = false;
      markerHeights[index] = height;
    }
    if (unchanged) return;
    anchorProjection = { objects, camera: { ...camera }, width: view.width, height: view.height,
      top: cameraInsets.top, bottom: cameraInsets.bottom, markerHeights };
    const projected: MapObjectScreenAnchor[] = [];
    for (let index = 0; index < objects.length; index++) {
      const anchor = projectConstructionAnchor(objects[index], camera, view, cameraInsets, markerHeights[index]);
      if (anchor) projected.push(anchor);
    }
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
    if (!options.readOnly && object.place === "plesk-shop") {
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
    if (!options.readOnly && object.place === "house") habitat.wakeHomeResident?.();
    draw();
    onPlace(selection.place, selection);
    return true;
  }
  function draw(allowPan = false, rasterClock = performance.now()) {
    if (disposed || !ctx) return;
    const ship = habitat.tradeShipFrame?.();
    if (!options.readOnly && options.tradeShipArrivalEnabled && !options.backgrounded && !document.hidden && inView && !paused()
      && !guidePlace && !editingLight() && ship?.kind === "arrival" && ship.pending && queuedShipArrival !== ship.voyageId) {
      const id = ship.voyageId; queuedShipArrival = id;
      queueMicrotask(() => {
        if (disposed || queuedShipArrival !== id) return;
        queuedShipArrival = null;
        const current = habitat.tradeShipFrame?.();
        if (options.readOnly || !options.tradeShipArrivalEnabled || options.backgrounded || document.hidden || !inView || paused()
          || guidePlace || editingLight() || current?.voyageId !== id || !current.pending) return;
        if (!habitat.startTradeShipArrival?.()) return;
        if (focusedShipArrival !== id) {
          focusedShipArrival = id; framing = "manual"; camera = tradeShipCamera(view, bounds, cameraInsets);
        }
        draw();
      });
    }
    redrawPending = false;
    const arriving = arrivalTarget();
    if (framing === "guide" && (arriving || followedArrival)) {
      const target = arriving ?? currentGuideTarget();
      if (target) camera = mapGuideCamera(target, view, bounds, guideInsets());
    }
    followedArrival = Boolean(arriving && framing === "guide");
    habitat.setAudioCamera?.({ x: camera.x, y: camera.y, zoom: camera.zoom, viewportWidth: view.width, viewportHeight: view.height });
    if (!pointers.size) viewportRect = null;
    const ratio = normalBacking.width / view.width, ratioY = normalBacking.height / view.height;
    const objects = habitat.mapObjects?.() ?? [];
    const guideTarget = currentGuideTarget(objects);
    // Only camera motion uses compositor frames. Simulation and artwork still
    // refresh at their normal 30Hz, with direct draws for explicit state changes.
    const panning = allowPan && rebuilding && viewportRoot && viewportRoot !== canvas
      && pointers.size === 1 && !multiTouch && travelled > 0 && !panBlocked
      && speechContext !== ctx && !editingLight() && !guideTarget && !motionReduced() && !paused()
      && (!rasterCamera || rasterCamera.zoom === camera.zoom);
    if (!panning) panSurface.reset();
    const moved = Boolean(panning && panSurface.active && rasterCamera && !worldFrameDue(rasterClock, last)
      && panSurface.present((rasterCamera.x - camera.x) * camera.zoom, (rasterCamera.y - camera.y) * camera.zoom));
    if (!moved) {
      if (panning) panSurface.activate();
      if (panSurface.active) panSurface.present(0, 0);
      function paintRaster() {
        const expanded = panSurface.active ? panSurface.geometry : null;
        const padX = expanded?.padX ?? 0, padY = expanded?.padY ?? 0;
        ctx!.setTransform(ratio, 0, 0, ratioY, padX, padY);
        ctx!.imageSmoothingEnabled = true; ctx!.imageSmoothingQuality = "low";
        ctx!.fillStyle = "#13231a";
        ctx!.fillRect(-padX / ratio, -padY / ratioY, canvas.width / ratio, canvas.height / ratioY);
        ctx!.translate(view.width / 2, view.height / 2); ctx!.scale(camera.zoom, camera.zoom); ctx!.translate(-camera.x, -camera.y);
        if (rebuilding) {
          if (expanded) return withExpandedCanvasViewport(ctx!, {
            x: padX, y: padY, width: normalBacking.width, height: normalBacking.height,
          }, () => habitat.paintWorld?.(ctx!));
          habitat.paintWorld?.(ctx!);
        } else {
          // Both views share the detailed tile and fixed world anchors. Its outer rim
          // contains the original map pixels; animation coordinates remain unchanged.
          ctx!.drawImage(ground, 0, 0, MAP_SIZE, MAP_SIZE);
          const weather = habitat.ambience();
          drawWaterAmbience(ctx!, weather.elapsed, options.reducedMotion, weather.rain);
          if (boatArt) drawBoatWreck(ctx!, boatArt);
          drawRouteProps(ctx!);
          habitat.paintVisitors(ctx!, "ground");
          ctx!.save(); ctx!.beginPath(); ctx!.rect(0, 0, MAP_SIZE, MAP_SIZE);
          ctx!.rect(HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size); ctx!.clip("evenodd");
          habitat.paintJourney(ctx!); ctx!.restore();
          habitat.paintLighting(ctx!);
          ctx!.drawImage(home, HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size);
          habitat.paintVisitors(ctx!, "air");
          habitat.paintWeather(ctx!);
        }
        return true;
      }
      if (!paintRaster()) {
        // Discard an expanded frame whose mask budget would change the artwork.
        // Retry only once per gesture, before the browser can present that frame.
        panBlocked = true; panSurface.reset(); paintRaster();
      }
      rasterCamera = { ...camera }; last = rasterClock;
      if (editingLight()) {
        ctx.setTransform(ratio, 0, 0, ratioY, 0, 0);
        lightingEditor.draw(ctx, p => worldToScreen(p, camera, view));
      }
      if (guideTarget) {
        ctx.setTransform(ratio, 0, 0, ratioY, 0, 0);
        drawMapGuideTarget(ctx, guideTarget, camera, view, habitat.ambience().elapsed, motionReduced() || paused());
      }
    }
    const speechFrames = habitat.speechFrames?.() ?? [];
    // An empty separate overlay stays transparent. Clearing its full backing
    // surface on every drag frame needlessly updates another viewport-sized
    // canvas. Keep live speech repainting and clear once when its last line ends.
    if (speechContext === ctx || speechFrames.length || speechSurfaceDirty) {
      if (speechContext !== ctx) {
        speechContext.setTransform(1, 0, 0, 1, 0, 0);
        speechContext.clearRect(0, 0, speechCanvas!.width, speechCanvas!.height);
      }
      speechContext.setTransform(ratio, 0, 0, ratioY, 0, 0);
      drawForestSpeech(speechContext, speechFrames.map(frame => ({ ...frame,
        anchor: worldToScreen(frame.anchor, camera, view) })), { ...view, insets: cameraInsets,
        reducedMotion: motionReduced(), night: options.dusk });
      speechSurfaceDirty = speechFrames.length > 0;
    }
    for (const node of anchors) {
      if (editingLight()) { node.style.visibility = "hidden"; continue; }
      // Keyboard/touch shortcuts follow the geometry committed with the visible artwork.
      const anchor = rebuilding ? node.dataset.objectId
        ? objects.find(object => object.id === node.dataset.objectId)?.anchor
        : habitat.siteAnchor?.(node.dataset.siteId ?? "")
        : { x: Number(node.dataset.x), y: Number(node.dataset.y) };
      if (!anchor) { if (node.style.visibility !== "hidden") node.style.visibility = "hidden"; continue; }
      // Only the decorative diamond follows zoom. Its accessible touch target
      // and the authored world hit area keep their existing dimensions.
      const hintDetail = camera.zoom < .5 ? "far" : camera.zoom < 1 ? "distant" : "near";
      if (node.dataset.tapHintDetail !== hintDetail) node.dataset.tapHintDetail = hintDetail;
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
    if (pendingEditorMove) {
      const point = pendingEditorMove; pendingEditorMove = null;
      lightingEditor.move(point);
    }
    // Input updates the camera immediately, but a burst of pointer events gets
    // one paint in the next browser frame, shared with ambient animation.
    if (redrawPending || !paused() && worldFrameDue(time, last)) {
      draw(true, time);
    }
    if (!motionReduced() && !paused() && !raf) raf = requestAnimationFrame(tick);
  }
  function visibility() {
    const wasPanning = panSurface.active;
    const backgrounded = Boolean(options.backgrounded || document.hidden || !inView);
    panSurface.reset(); rasterCamera = null;
    if (backgrounded) {
      pendingEditorMove = null;
      lightingEditor.blur();
      cancelled = true;
      for (const [id, touch] of pointers) if (touch.capture.hasPointerCapture(id)) touch.capture.releasePointerCapture(id);
      pointers.clear();
    }
    cancelAnimationFrame(raf); raf = 0;
    rehearsal.configure(options, dev?.scenePreview, backgrounded);
    // Suspension can leave the portal visible during its exit animation. Resetting
    // an expanded backing clears its pixels, so finish that visible frame first.
    if (!disposed && wasPanning && backgrounded && !document.hidden && inView) draw();
    if (!disposed && !backgrounded) { draw(); if (!motionReduced() && !paused() && !raf) raf = requestAnimationFrame(tick); }
  }
  function resize() {
    if (disposed) return;
    viewportRect = null;
    // CSS entrance scaling changes the visual rect, not the map's layout viewport.
    view = { width: Math.max(1, viewportElement.clientWidth), height: Math.max(1, viewportElement.clientHeight) };
    // Both HUDs are anchored to the viewport edges. Layout height includes their
    // safe-area padding and avoids entrance transforms changing the pan limits.
    cameraInsets = { top: cameraHud.top?.offsetHeight ?? 0, bottom: cameraHud.bottom?.offsetHeight ?? 0 };
    const scale = Math.min(window.devicePixelRatio || 1, 2, 2200 / Math.max(view.width, view.height));
    const width = Math.round(view.width * scale), height = Math.round(view.height * scale);
    // A HUD-only ResizeObserver notification changes camera insets, not the
    // backing surface. Reassigning even equal dimensions discards that surface.
    normalBacking = { width, height };
    panSurface.configure(view, width, height); rasterCamera = null;
    if (speechCanvas) {
      if (speechCanvas.width !== width) { speechCanvas.width = width; speechSurfaceDirty = true; }
      if (speechCanvas.height !== height) { speechCanvas.height = height; speechSurfaceDirty = true; }
    }
    const guideTarget = framing === "guide" ? currentGuideTarget() : undefined;
    if (restoreStudioViewport && editingLight()) {
      // Selection focus may extend the full camera beyond a world edge to keep
      // the target in the gap between studio panels. Clamp that usable area,
      // just as focusLighting does, rather than moving it under a sidebar.
      const safe = studioUsableRectangle(), width = Math.max(100, safe.right - safe.left), height = Math.max(100, safe.bottom - safe.top);
      const zoom = clampCamera(camera, view, bounds, cameraInsets).zoom;
      const offset = { x: (view.width / 2 - safe.left - width / 2) / zoom, y: (view.height / 2 - safe.top - height / 2) / zoom };
      const focused = clampCamera({ x: camera.x - offset.x, y: camera.y - offset.y, zoom }, { width, height }, bounds);
      camera = { zoom: focused.zoom, x: focused.x + offset.x, y: focused.y + offset.y };
    } else camera = guideTarget ? mapGuideCamera(guideTarget, view, bounds, guideInsets()) : framing === "world" ? focusCamera(view, false) : framing === "home" ? focusCamera(view, true) : framing === "overview" ? overviewCamera(view, bounds) : clampCamera(camera, view, bounds, cameraInsets);
    restoreStudioViewport = false; draw();
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(viewportElement);
  if (cameraHud.top) resizeObserver.observe(cameraHud.top, { box: "border-box" });
  if (cameraHud.bottom) resizeObserver.observe(cameraHud.bottom, { box: "border-box" });
  resize();
  const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility(); }); observer.observe(viewportElement);
  const point = (event: Pick<PointerEvent, "clientX" | "clientY">): Point => {
    // Marker transforms are written during paint. Re-reading layout on every
    // move forces the browser to flush those writes during high-rate input.
    viewportRect ??= viewportElement.getBoundingClientRect();
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
    if (!pointers.size) { travelled = 0; multiTouch = false; cancelled = false; viewportRect = null; panBlocked = false; }
    const p = point(event);
    if (pointers.size && editingLight()) {
      pendingEditorMove = null;
      lightingEditor.cancel();
      for (const touch of pointers.values()) touch.editor = false;
      cancelled = true;
    }
    const editor = !pointers.size && editingLight() && lightingEditor.down(screenToWorld(p, camera, view), 11 / camera.zoom,
      { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey });
    // Large touch targets overlap in the phone overview. Resolve the closest
    // rendered marker, independently of which DOM button received the press.
    // Keep capture on the original button on touch devices: transferring it to
    // a sibling canvas competes with the browser's implicit touch capture.
    const capture = typeof target.setPointerCapture === "function" ? target : canvas;
    pointers.set(event.pointerId, { initial: p, position: p, objectId: objectId ? nearestMarkerObject(p) : undefined, capture, editor, additive: event.ctrlKey || event.metaKey });
    multiTouch ||= pointers.size > 1; capture.setPointerCapture(event.pointerId); capture.focus?.({ preventScroll: true });
    if (panSurface.active && pointers.size !== 1) draw();
    if (editingLight()) requestDraw();
  }
  function move(event: PointerEvent) {
    const touch = pointers.get(event.pointerId);
    if (!touch) {
      if (editingLight() && worldLightingEditorStore.getSnapshot().tool === "light") {
        lightingEditor.hover(screenToWorld(point(event), camera, view)); requestDraw();
      }
      return;
    }
    const p = point(event), before = touch.position, oldDistance = separation();
    // Applying a geometry edit also publishes all property panels and invalidates
    // light masks. Coalesce high-rate pointer packets before doing that work.
    if (touch.editor) { pendingEditorMove = screenToWorld(p, camera, view); touch.position = p; requestDraw(); return; }
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
    if (touch.editor) {
      pendingEditorMove = null;
      if (!cancelled) lightingEditor.move(screenToWorld(p, camera, view));
      lightingEditor.end(cancelled);
      if (touch.capture.hasPointerCapture(event.pointerId)) touch.capture.releasePointerCapture(event.pointerId);
      requestDraw(); return;
    }
    if (editingLight()) {
      if (!touch.additive && !lightingEditor.isPanning() && !pointers.size && isMapTap(travelled, multiTouch, cancelled)) worldLightingEditorStore.clearSelection();
      if (touch.capture.hasPointerCapture(event.pointerId)) touch.capture.releasePointerCapture(event.pointerId);
      requestDraw(); return;
    }
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
        const resident = habitat.hitResident?.(world.x, world.y);
        if (resident) { setSelectedObject(null); if (!options.readOnly) habitat.noticeResident?.(resident); }
        else if (habitat.hitVisiblePet?.(petPoint.x, petPoint.y)) { setSelectedObject(null); if (!options.readOnly) habitat.notice(); }
        else if (markerObject) activateObject(markerObject.id);
        else if (object) activateObject(object.id);
        else {
          setSelectedObject(null);
          if (options.readOnly) { /* Visitors inspect progress without directing its actors. */ }
          else if (habitat.disturbTree?.(world)) { /* A crown consumes its tap, including its quiet cooldown. */ }
          else if (habitat.hitPet(petPoint.x, petPoint.y)) habitat.notice();
          else habitat.disturbWater?.(world);
        }
      } else {
        const { x, y } = worldToHome(world);
        const place = mapPlaceAt(world);
        if (place === "cave" || place === "fishing") onPlace(place);
        else if (habitat.hitPet(x, y)) onPlace("wardrobe");
        else if (place === "house") onPlace("house");
        else if (!options.readOnly && place === "bush") habitat.invite("bush");
        else if (!options.readOnly && x >= 0 && x <= 1 && y >= 0 && y <= 1) habitat.moveTo(x, y);
      }
    }
    if (touch.capture.hasPointerCapture(event.pointerId)) touch.capture.releasePointerCapture(event.pointerId);
    if (panSurface.active) draw(); else requestDraw();
  }
  function wheel(event: WheelEvent) { event.preventDefault(); pendingEditorMove = null; lightingEditor.cancel(); framing = "manual"; camera = zoomAt(camera, view, point(event), Math.exp(-event.deltaY * .0015), bounds, cameraInsets); requestDraw(); }
  function control(action: MapAction) {
    framing = action === "home" || action === "overview" ? action : "manual";
    if (action === "ship") {
      if (WORLD_DEV_ENABLED && !options.readOnly && rebuilding) {
        // Show the berth and the leftward exit together, including under the mobile HUD.
        camera = tradeShipCamera(view, bounds, cameraInsets);
      }
      draw(); return;
    }
    if (action === "plesk" || action === "builder" || action === "fishing") {
      const target = habitat.inspectPoint?.(action);
      if (target) camera = clampCamera({ ...target, zoom: Math.max(camera.zoom, focusCamera(view, true).zoom) }, view, bounds, cameraInsets);
      draw(); return;
    }
    camera = action === "pet" ? clampCamera({ ...habitat.position(), zoom: Math.max(camera.zoom, focusCamera(view, true).zoom) }, view, bounds, cameraInsets)
      : action === "home" ? focusCamera(view, true) : action === "overview" ? overviewCamera(view, bounds) : zoomAt(camera, view, { x: view.width / 2, y: view.height / 2 }, action === "in" ? 1.25 : .8, bounds, cameraInsets); draw();
  }
  function key(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.isComposing || target?.isContentEditable || target?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    if (WORLD_DEV_ENABLED && lightingEditor.key(event)) { event.preventDefault(); requestDraw(); return; }
    const delta = { ArrowUp: [0, -40], ArrowDown: [0, 40], ArrowLeft: [-40, 0], ArrowRight: [40, 0] }[event.key];
    if (delta) { event.preventDefault(); framing = "manual"; camera = clampCamera({ ...camera, x: camera.x + delta[0] / camera.zoom, y: camera.y + delta[1] / camera.zoom }, view, bounds, cameraInsets); draw(); }
    else if (["+", "=", "-", "Home"].includes(event.key)) { event.preventDefault(); control(event.key === "Home" ? "pet" : event.key === "-" ? "out" : "in"); }
  }
  function keyUp(event: KeyboardEvent) { if (lightingEditor.keyUp(event)) { event.preventDefault(); requestDraw(); } }
  function editorBlur() { pendingEditorMove = null; lightingEditor.blur(); requestDraw(); }
  function editorLeave() { lightingEditor.hover(null); if (editingLight()) requestDraw(); }
  function editorFocus(event: Event) {
    const request = takeWorldLightingEditorFocus() ?? (event as CustomEvent<WorldLightingEditorFocus | "selection">).detail;
    const target = request === "selection" ? lightingEditor.focus() : request;
    if (target) focusLighting(target);
  }
  function editorCreate(event: Event) {
    const kind = takeWorldStudioCreate() ?? (event as CustomEvent<WorldStudioCreateKind>).detail;
    if (kind === "caster" || kind === "receiver" || kind === "receiver-hole") createStudioElement(kind);
  }
  if (WORLD_DEV_ENABLED) {
    window.addEventListener?.(WORLD_LIGHTING_EDITOR_FOCUS_EVENT, editorFocus);
    window.addEventListener?.(WORLD_STUDIO_CREATE_EVENT, editorCreate);
  }
  function editorMapKey(event: Event) {
    if (!editingLight()) return;
    const request = (event as CustomEvent<WorldStudioMapKeyRequest>).detail;
    if (!request || request.handled) return;
    if (request.phase === "cancel") { pendingEditorMove = null; lightingEditor.blur(); request.handled = true; }
    else request.handled = request.phase === "up" ? lightingEditor.keyUp(request.input) : lightingEditor.key(request.input);
    if (request.handled) requestDraw();
  }
  if (WORLD_DEV_ENABLED) window.addEventListener?.(WORLD_STUDIO_MAP_KEY_EVENT, editorMapKey);
  // DEV and the enclosing world dialog both capture Escape. Handle a map drag
  // first, while leaving keyboard input in the panel to its own controls.
  function editorEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.isComposing || event.target !== canvas || !editingLight()) return;
    if (document.querySelector?.("[data-world-lighting-studio-panel]")) return;
    lightingEditor.key(event); event.preventDefault(); event.stopImmediatePropagation(); requestDraw();
  }
  window.addEventListener?.("keydown", editorEscape, true);
  function editorCancel(event: Event) {
    const key = (event as CustomEvent<KeyboardEvent>).detail;
    if (!editingLight() || key?.key !== "Escape") return;
    pendingEditorMove = null; lightingEditor.blur(); requestDraw();
  }
  window.addEventListener?.(WORLD_LIGHTING_EDITOR_CANCEL_EVENT, editorCancel);
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, end);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
  canvas.addEventListener("keyup", keyUp); canvas.addEventListener("blur", editorBlur); canvas.addEventListener("pointerleave", editorLeave);
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
  if (WORLD_DEV_ENABLED && !initial.readOnly) dev = worldDevStore.getSnapshot();
  document.addEventListener("visibilitychange", visibility); visibility();
  const pendingLightingFocus = WORLD_DEV_ENABLED && !initial.readOnly ? takeWorldLightingEditorFocus() : null;
  const pendingLightingTarget = pendingLightingFocus === "selection" ? lightingEditor.focus() : pendingLightingFocus;
  if (pendingLightingTarget) focusLighting(pendingLightingTarget);
  if (WORLD_DEV_ENABLED && !initial.readOnly) createStudioElement(takeWorldStudioCreate());
  // An absolute DEV target chosen in the circle survives opening the full map.
  if ((!retainedViewport || dev?.cameraEvent?.id !== initialCameraEventId)
    && (dev?.cameraEvent?.action === "plesk" || dev?.cameraEvent?.action === "builder" || dev?.cameraEvent?.action === "fishing" || dev?.cameraEvent?.action === "ship")) control(dev.cameraEvent.action);
  const unsubscribeDev = WORLD_DEV_ENABLED && !initial.readOnly ? worldDevStore.subscribe(() => {
    if (disposed) return;
    const previousCamera = dev?.cameraEvent?.id;
    dev = worldDevStore.getSnapshot();
    cancelAnimationFrame(raf); raf = 0;
    if (!document.hidden && !options.backgrounded && inView) {
      if (dev.cameraEvent && dev.cameraEvent.id !== previousCamera) control(dev.cameraEvent.action);
      else visibility();
      if (!motionReduced() && !paused() && !raf) raf = requestAnimationFrame(tick);
    }
  }) : () => {};
  const unsubscribeLightingEditor = WORLD_DEV_ENABLED && !initial.readOnly ? worldLightingEditorStore.subscribe(() => {
    studioWasActive ||= editingLight();
    if (!editingLight()) { pendingEditorMove = null; lightingEditor.blur(); }
    if (editingLight()) setSelectedObject(null);
    requestDraw();
  }) : () => {};
  return {
    control,
    activateObject,
    setSelectedObject,
    setGuidePlace,
    refreshObjectAnchors() {
      if (!document.hidden && !options.backgrounded && inView) updateObjectAnchors(habitat.mapObjects?.() ?? []);
    },
    setObjectAnchorsEnabled(enabled: boolean) {
      if (disposed || enabled === objectAnchorsEnabled) return;
      objectAnchorsEnabled = enabled; anchorsKey = ""; anchorProjection = null;
      if (enabled) requestDraw();
      else interactions.onObjectAnchorsChange?.([]);
    },
    setTime(now: number) { naturalHabitat.setTime(now); },
    update(next: SceneOptions) {
      // Camera/UI publications can rebuild the wrapper object while all game
      // inputs remain unchanged. Reconfiguring would stop the simulation RAF
      // and discard its previous timestamp on every selected-object pan.
      if (disposed || sameSceneOptions(options, next)) return;
      options = next;
      visibility();
    },
    notice() { if (!options.readOnly) habitat.notice(); draw(); },
    visitBush() { if (!options.readOnly) habitat.invite("bush"); draw(); },
    dispose() {
      if (studioWasActive) studioViewports?.set(canvas, { camera: { ...camera }, framing });
      else studioViewports?.delete(canvas);
      panSurface.dispose(); rasterCamera = null;
      disposed = true; pendingEditorMove = null; lightingEditor.blur(); cancelAnimationFrame(raf); unsubscribeDev(); unsubscribeLightingEditor(); rehearsal.dispose(); resizeObserver.disconnect(); observer.disconnect();
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
      canvas.removeEventListener("keyup", keyUp); canvas.removeEventListener("blur", editorBlur); canvas.removeEventListener("pointerleave", editorLeave);
      window.removeEventListener?.(WORLD_LIGHTING_EDITOR_FOCUS_EVENT, editorFocus);
      window.removeEventListener?.(WORLD_STUDIO_CREATE_EVENT, editorCreate);
      window.removeEventListener?.(WORLD_STUDIO_MAP_KEY_EVENT, editorMapKey);
      window.removeEventListener?.("keydown", editorEscape, true);
      window.removeEventListener?.(WORLD_LIGHTING_EDITOR_CANCEL_EVENT, editorCancel);
    },
  };
}
