import { mountHabitat, type SceneOptions } from "@/lib/mochlik/scene";
import { clampCamera, homeCamera, HOME_AREA, INNER_AREA, isMapTap, MAP_SIZE, screenToWorld, viewportPoint, worldToScreen, zoomAt, type Point } from "./camera";
export type WorldPlace = "house" | "workshop" | "journeys" | "wardrobe" | "river" | "trail";
export type MapAction = "home" | "in" | "out";
const terrainCache = new Map<string, Promise<HTMLImageElement>>();
function terrain(path: string) {
  if (!terrainCache.has(path)) terrainCache.set(path, new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = path;
  }).catch(error => { terrainCache.delete(path); throw error; }));
  return terrainCache.get(path)!;
}
export async function createMapEngine(canvas: HTMLCanvasElement, initial: SceneOptions, onPlace: (place: WorldPlace) => void, anchors: HTMLElement[]) {
  const [ground, innerGround] = await Promise.all([terrain("/world/forest-expanded.webp"), terrain("/world/forest-world.webp")]);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas unavailable");
  let options = initial, disposed = false, raf = 0, last = 0;
  let view = { width: 1, height: 1 }, camera = homeCamera(view), started = false;
  let inView = true;
  const home = document.createElement("canvas"), blend = document.createElement("canvas"), mask = document.createElement("canvas");
  blend.width = mask.width = 256; blend.height = mask.height = 256;
  const blendContext = blend.getContext("2d")!, maskContext = mask.getContext("2d")!;
  maskContext.fillStyle = "white"; maskContext.fillRect(0, 0, 256, 256);
  maskContext.globalCompositeOperation = "destination-in";
  for (const vertical of [false, true]) {
    const gradient = maskContext.createLinearGradient(0, 0, vertical ? 0 : 256, vertical ? 256 : 0);
    gradient.addColorStop(0, "transparent"); gradient.addColorStop(.075, "white"); gradient.addColorStop(.925, "white"); gradient.addColorStop(1, "transparent");
    maskContext.fillStyle = gradient; maskContext.fillRect(0, 0, 256, 256);
  }
  // Cache the unchanged inner forest once; feather only its outer edge into the new terrain.
  const inner = document.createElement("canvas"); inner.width = inner.height = 768;
  const innerContext = inner.getContext("2d")!; innerContext.imageSmoothingEnabled = false;
  innerContext.drawImage(innerGround, 0, 0, 768, 768);
  innerContext.globalCompositeOperation = "destination-in"; innerContext.drawImage(mask, 0, 0, 768, 768);
  type Touch = { initial: Point; position: Point };
  const pointers = new Map<number, Touch>();
  let travelled = 0, multiTouch = false, cancelled = false;
  const habitat = mountHabitat(home, initial, { activity() {}, ready: () => draw(), failure: () => draw(), rendered: () => { if (options.reducedMotion) draw(); } });
  function draw() {
    if (disposed || !ctx) return;
    const ratio = canvas.width / view.width;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#13231a"; ctx.fillRect(0, 0, view.width, view.height);
    ctx.translate(view.width / 2, view.height / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
    ctx.drawImage(ground, 0, 0, MAP_SIZE, MAP_SIZE);
    ctx.drawImage(inner, INNER_AREA.x, INNER_AREA.y, INNER_AREA.size, INNER_AREA.size);
    if (options.dusk) { ctx.fillStyle = "rgba(8,17,35,.57)"; ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE); }
    blendContext.globalCompositeOperation = "copy"; blendContext.drawImage(home, 0, 0, 256, 256);
    blendContext.globalCompositeOperation = "destination-in"; blendContext.drawImage(mask, 0, 0);
    ctx.drawImage(blend, HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size);
    for (const node of anchors) {
      const point = worldToScreen({ x: Number(node.dataset.x), y: Number(node.dataset.y) }, camera, view);
      node.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
      node.style.visibility = point.x < -60 || point.y < 0 || point.x > view.width + 60 || point.y > view.height + 50 ? "hidden" : "visible";
    }
  }
  function tick(time: number) {
    raf = 0;
    if (disposed || document.hidden || !inView) return;
    if (time - last >= (options.reducedMotion ? 250 : 1000 / 30)) { draw(); last = time; }
    if (!options.reducedMotion) raf = requestAnimationFrame(tick);
  }
  function visibility() {
    if (document.hidden) {
      cancelled = true;
      for (const id of pointers.keys()) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      pointers.clear();
    }
    cancelAnimationFrame(raf); raf = 0;
    habitat.configure({ ...options, backgrounded: document.hidden || !inView });
    if (!disposed && !document.hidden && inView) { draw(); if (!options.reducedMotion) raf = requestAnimationFrame(tick); }
  }
  function resize() {
    // CSS entrance scaling changes the visual rect, not the map's layout viewport.
    view = { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) };
    const scale = Math.min(1, 1100 / Math.max(view.width, view.height));
    canvas.width = Math.round(view.width * scale); canvas.height = Math.round(view.height * scale);
    camera = started ? clampCamera(camera, view) : homeCamera(view); started = true; draw();
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas); resize();
  const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility(); }); observer.observe(canvas);
  const point = (event: PointerEvent): Point => viewportPoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), view);
  const separation = () => { const pair = [...pointers.values()].slice(0, 2); return pair.length === 2 ? Math.hypot(pair[0].position.x - pair[1].position.x, pair[0].position.y - pair[1].position.y) : 0; };
  const midpoint = () => { const pair = [...pointers.values()].slice(0, 2); return { x: (pair[0].position.x + pair[1].position.x) / 2, y: (pair[0].position.y + pair[1].position.y) / 2 }; };
  function down(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!pointers.size) { travelled = 0; multiTouch = false; cancelled = false; }
    const p = point(event); pointers.set(event.pointerId, { initial: p, position: p });
    multiTouch ||= pointers.size > 1; canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true });
  }
  function move(event: PointerEvent) {
    const touch = pointers.get(event.pointerId); if (!touch) return;
    const p = point(event), before = touch.position, oldDistance = separation();
    const oldCenter = pointers.size >= 2 ? midpoint() : null;
    travelled = Math.max(travelled, Math.hypot(p.x - touch.initial.x, p.y - touch.initial.y));
    touch.position = p;
    if (oldCenter && oldDistance > 2) {
      camera = zoomAt(camera, view, oldCenter, separation() / oldDistance);
      const center = midpoint(); camera = clampCamera({ ...camera, x: camera.x - (center.x - oldCenter.x) / camera.zoom, y: camera.y - (center.y - oldCenter.y) / camera.zoom }, view);
    } else camera = clampCamera({ ...camera, x: camera.x - (p.x - before.x) / camera.zoom, y: camera.y - (p.y - before.y) / camera.zoom }, view);
    draw();
  }
  function end(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    cancelled ||= event.type === "pointercancel" || event.type === "lostpointercapture";
    const p = point(event), touch = pointers.get(event.pointerId)!;
    travelled = Math.max(travelled, Math.hypot(p.x - touch.initial.x, p.y - touch.initial.y));
    pointers.delete(event.pointerId);
    if (!pointers.size && isMapTap(travelled, multiTouch, cancelled)) {
      const world = screenToWorld(p, camera, view);
      const x = (world.x - HOME_AREA.x) / HOME_AREA.size, y = (world.y - HOME_AREA.y) / HOME_AREA.size;
      if (habitat.hitPet(x, y)) onPlace("wardrobe");
      else if (x > .60 && x < .93 && y > .12 && y < .49) onPlace("house");
      else if (x > .08 && x < .30 && y > .58 && y < .79 && options.worldState?.workshop) onPlace("workshop");
      else if (x > .10 && x < .31 && y > .35 && y < .52) habitat.invite("bush");
      else if (x >= 0 && x <= 1 && y >= 0 && y <= 1) habitat.moveTo(x, y);
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    draw();
  }
  function wheel(event: WheelEvent) { event.preventDefault(); camera = zoomAt(camera, view, point(event as unknown as PointerEvent), Math.exp(-event.deltaY * .0015)); draw(); }
  function control(action: MapAction) {
    camera = action === "home" ? homeCamera(view) : zoomAt(camera, view, { x: view.width / 2, y: view.height / 2 }, action === "in" ? 1.25 : .8); draw();
  }
  function key(event: KeyboardEvent) {
    const delta = { ArrowUp: [0, -40], ArrowDown: [0, 40], ArrowLeft: [-40, 0], ArrowRight: [40, 0] }[event.key];
    if (delta) { event.preventDefault(); camera = clampCamera({ ...camera, x: camera.x + delta[0] / camera.zoom, y: camera.y + delta[1] / camera.zoom }, view); draw(); }
    else if (["+", "=", "-", "Home"].includes(event.key)) { event.preventDefault(); control(event.key === "Home" ? "home" : event.key === "-" ? "out" : "in"); }
  }
  canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, end);
  canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
  document.addEventListener("visibilitychange", visibility); visibility();
  return {
    control,
    update(next: SceneOptions) { options = next; visibility(); },
    notice() { habitat.notice(); draw(); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); habitat.dispose(); resizeObserver.disconnect(); observer.disconnect();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.removeEventListener(name, end);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); document.removeEventListener("visibilitychange", visibility);
    },
  };
}
