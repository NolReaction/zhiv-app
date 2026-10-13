import type { FixedWorldScene, WorldPoint, WorldShadowCaster, WorldShadowReceiver } from "@/features/world/tiled/types";
import { prepareForestShadowGeometry, projectForestShadow, type PreparedForestShadowGeometry,
  type PointShadowLight, type ShadowLight } from "./forest-shadow-geometry";

export type ForestShadowSource = {
  id: string;
  /** Ground position; the painted flame sits height units above it. */
  position: WorldPoint;
  height: number;
  radius: number;
  intensity: number;
  color: string;
  ownerSiteId?: string;
};
export type ForestShadowFrame = {
  night: number;
  /** Direction toward the sun/moon, in degrees on the uncompressed ground. */
  azimuth: number;
  elevation: number;
  quality: "low" | "high";
  sources: readonly ForestShadowSource[];
  actors: readonly WorldShadowCaster[];
  showBuildings?: boolean;
  /** Disable only building blockers while keeping visible lamps and receivers. */
  buildingShadows?: boolean;
  /** Opt-in immutable geometry contract. Bump on in-place contour/height edits;
   * replacing either geometry array also invalidates the cache automatically. */
  geometryRevision?: number;
};
type Surface = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
type Pool = Surface & { x: number; y: number; width: number; height: number; light: PointShadowLight };
type DirectionalMask = Surface & { light: ShadowLight };
type ReceiverGroup = { height: number; polygons: WorldPoint[][]; path?: Path2D };
type SceneCache = {
  signature?: string; geometryRevision?: number;
  sourceCasters?: WorldShadowCaster[]; sourceReceivers?: WorldShadowReceiver[];
  sceneWidth: number; sceneHeight: number; showBuildings: boolean; buildingShadows: boolean;
  scale: number; width: number; height: number;
  base: Surface; field: Surface; scratch: Surface; directional: Surface;
  receivers: ReceiverGroup[]; casters: WorldShadowCaster[];
  prepared: Map<WorldShadowCaster, PreparedForestShadowGeometry>;
  pools: Map<string, Pool>; shadows: Map<string, DirectionalMask>;
};
// Weak scene ownership prevents a disposed world retaining its textures. Each
// scene has at most two quality variants, 16 cropped lamp pools and two sun masks.
const caches = new WeakMap<FixedWorldScene, Map<string, SceneCache>>();
const clamp = (value: number, max = 1) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const visibleGeometry = <T extends { when?: { siteId: string } }>(values: readonly T[], frame: ForestShadowFrame) =>
  values.filter(value => frame.showBuildings !== false || !value.when);
const visibleCasters = (scene: FixedWorldScene, frame: ForestShadowFrame) =>
  visibleGeometry(scene.shadowCasters ?? [], frame).filter(caster => frame.buildingShadows !== false || !caster.when);

function surface(width: number, height: number): Surface | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d"); return ctx ? { canvas, ctx } : undefined;
}
function reset(target: Surface, width = target.canvas.width, height = target.canvas.height) {
  const ctx = target.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none"; ctx.clearRect(0, 0, width, height);
}
type PathSink = Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath">;
function appendPath(ctx: PathSink, polygons: readonly WorldPoint[][], normalized = false) {
  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    // Receiver contours authored in either direction form a union, not holes.
    const area = normalized ? 1 : polygon.reduce((sum, point, index) => {
      const next = polygon[(index + 1) % polygon.length]; return sum + point.x * next.y - point.y * next.x;
    }, 0);
    const points = area < 0 ? [...polygon].reverse() : polygon;
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
    ctx.closePath();
  }
}
function path(ctx: CanvasRenderingContext2D, polygons: readonly WorldPoint[][], normalized = false) {
  ctx.beginPath(); appendPath(ctx, polygons, normalized);
}
function receiverGroups(receivers: WorldShadowReceiver[]): ReceiverGroup[] {
  const groups = new Map<number, WorldPoint[][]>();
  for (const receiver of receivers) {
    if (!Number.isFinite(receiver.height) || receiver.points.length < 3 || receiver.points.some(point => !finitePoint(point))) continue;
    const polygons = groups.get(receiver.height) ?? []; polygons.push(receiver.points); groups.set(receiver.height, polygons);
  }
  return [...groups].map(([height, polygons]) => {
    // Native receiver paths are reusable across lamps and moving characters;
    // headless/older environments retain the same immediate-mode path.
    const receiverPath = typeof Path2D === "undefined" ? undefined : new Path2D();
    if (receiverPath) appendPath(receiverPath, polygons);
    return { height, polygons, path: receiverPath };
  });
}
function ambient(cache: SceneCache, scene: FixedWorldScene) {
  const ctx = cache.base.ctx;
  ctx.setTransform(cache.scale, 0, 0, cache.scale, 0, 0);
  ctx.fillStyle = "#2d3d62"; ctx.fillRect(0, 0, scene.width, scene.height);
  const moon = ctx.createRadialGradient(scene.width * .68, scene.height * .12, 0,
    scene.width * .68, scene.height * .12, Math.max(scene.width, scene.height) * .98);
  moon.addColorStop(0, "rgba(112,151,198,.28)"); moon.addColorStop(.55, "rgba(87,121,176,.12)");
  moon.addColorStop(1, "rgba(76,101,156,0)");
  ctx.globalCompositeOperation = "screen"; ctx.fillStyle = moon; ctx.fillRect(0, 0, scene.width, scene.height);
}
function sceneCache(scene: FixedWorldScene, frame: ForestShadowFrame): SceneCache | undefined {
  if (!Number.isFinite(scene.width) || !Number.isFinite(scene.height) || scene.width <= 0 || scene.height <= 0) return;
  let variants = caches.get(scene);
  if (!variants) { variants = new Map(); caches.set(scene, variants); }
  const previous = variants.get(frame.quality);
  const geometryRevision = Number.isFinite(frame.geometryRevision) ? frame.geometryRevision : undefined;
  const showBuildings = frame.showBuildings !== false, buildingShadows = frame.buildingShadows !== false;
  if (geometryRevision !== undefined && previous?.geometryRevision === geometryRevision
    && previous.sourceCasters === scene.shadowCasters && previous.sourceReceivers === scene.shadowReceivers
    && previous.sceneWidth === scene.width && previous.sceneHeight === scene.height
    && previous.showBuildings === showBuildings && previous.buildingShadows === buildingShadows) return previous;
  const receivers = visibleGeometry(scene.shadowReceivers ?? [], frame), casters = visibleCasters(scene, frame);
  if (!receivers.length) return;
  // Legacy mutable callers still detect in-place edits. Runtime/editor callers
  // provide a revision, avoiding full geometry serialization on every pass.
  const signature = geometryRevision === undefined ? JSON.stringify([scene.width, scene.height, receivers, casters]) : undefined;
  if (signature !== undefined && previous?.signature === signature) return previous;
  const scale = Math.min(1, (frame.quality === "low" ? 512 : 768) / Math.max(scene.width, scene.height));
  const width = Math.max(1, Math.ceil(scene.width * scale)), height = Math.max(1, Math.ceil(scene.height * scale));
  const base = surface(width, height), field = surface(width, height), scratch = surface(1, 1), directional = surface(width, height);
  if (!base || !field || !scratch || !directional) return;
  const groups = receiverGroups(receivers); if (!groups.length) return;
  const cache: SceneCache = { signature, geometryRevision, sourceCasters: scene.shadowCasters, sourceReceivers: scene.shadowReceivers,
    sceneWidth: scene.width, sceneHeight: scene.height, showBuildings, buildingShadows,
    scale, width, height, base, field, scratch, directional, receivers: groups, casters,
    prepared: new Map(casters.map(caster => [caster, prepareForestShadowGeometry(caster.points)])),
    pools: new Map(), shadows: new Map() };
  ambient(cache, scene); variants.set(frame.quality, cache); return cache;
}
function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value); return value;
}
function shadows(ctx: CanvasRenderingContext2D, cache: SceneCache, light: ShadowLight,
  casters: readonly WorldShadowCaster[], dynamic: boolean, ownerSiteId?: string) {
  for (const receiver of cache.receivers) {
    ctx.save();
    if (receiver.path) ctx.clip(receiver.path);
    else { path(ctx, receiver.polygons); ctx.clip(); }
    for (const caster of casters) {
      if (ownerSiteId && caster.when?.siteId === ownerSiteId || clamp(caster.opacity) <= 0) continue;
      const pieces = projectForestShadow(caster, light, receiver.height, dynamic ? undefined : cache.prepared.get(caster)); if (!pieces.length) continue;
      // Union the extruded prism first. Filling its triangles separately would
      // darken their overlaps and create visible diagonal bands in soft foliage.
      path(ctx, pieces, true); ctx.globalAlpha = clamp(caster.opacity); ctx.fillStyle = "#000";
      ctx.filter = !dynamic && caster.softness > 0 ? `blur(${Math.min(12, caster.softness) * cache.scale}px)` : "none";
      ctx.fill();
    }
    ctx.restore();
  }
}
function sourceKey(source: ForestShadowSource) {
  return JSON.stringify([source.id, source.position.x, source.position.y, source.height, source.radius, source.color, source.ownerSiteId]);
}
function validSource(source: ForestShadowSource, frame: ForestShadowFrame) {
  return finitePoint(source.position) && Number.isFinite(source.height) && source.height > 0
    && Number.isFinite(source.radius) && source.radius > 0 && clamp(source.intensity, 2) > 0
    && /^#[0-9a-f]{6}$/i.test(source.color) && (frame.showBuildings !== false || !source.ownerSiteId);
}
function nearbyActors(source: ForestShadowSource, actors: readonly WorldShadowCaster[]) {
  return actors.filter(actor => {
    if (clamp(actor.opacity) <= 0 || actor.height <= 0 || source.height <= actor.baseHeight
      || source.ownerSiteId && actor.when?.siteId === source.ownerSiteId || actor.points.length < 3) return false;
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const point of actor.points) {
      left = Math.min(left, point.x); right = Math.max(right, point.x);
      top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
    }
    const dx = Math.max(left - source.position.x, 0, source.position.x - right);
    const dy = Math.max(top - source.position.y, 0, source.position.y - bottom);
    // Projection runs away from the source. A body wholly outside its radius
    // cannot cast a shadow into the pool; a large body crossing it still can.
    return dx * dx + dy * dy <= source.radius * source.radius;
  });
}
function pool(cache: SceneCache, source: ForestShadowSource): Pool | undefined {
  const key = sourceKey(source), existing = cache.pools.get(key); if (existing) return existing;
  const x = Math.max(0, source.position.x - source.radius), y = Math.max(0, source.position.y - source.radius);
  const width = Math.min(cache.width / cache.scale, source.position.x + source.radius) - x;
  const height = Math.min(cache.height / cache.scale, source.position.y + source.radius) - y;
  if (width <= 0 || height <= 0) return;
  const target = surface(Math.max(1, Math.ceil(width * cache.scale)), Math.max(1, Math.ceil(height * cache.scale)));
  if (!target) return;
  const ctx = target.ctx; ctx.setTransform(cache.scale, 0, 0, cache.scale, -x * cache.scale, -y * cache.scale);
  const gradient = ctx.createRadialGradient(source.position.x, source.position.y, 0,
    source.position.x, source.position.y, source.radius);
  const rgb = [1, 3, 5].map(offset => parseInt(source.color.slice(offset, offset + 2), 16)).join(",");
  for (const [stop, alpha] of [[0, .96], [.14, .83], [.38, .44], [.7, .12], [1, 0]]) gradient.addColorStop(stop, `rgba(${rgb},${alpha})`);
  ctx.fillStyle = gradient; ctx.fillRect(x, y, width, height);
  // Erase from this source alone. Another lamp is independently visible through
  // its own shadow mask and can fill this one's shadow when fields are combined.
  ctx.globalCompositeOperation = "destination-out";
  const light: PointShadowLight = { kind: "point", position: { ...source.position }, height: source.height, radius: source.radius };
  shadows(ctx, cache, light, cache.casters, false, source.ownerSiteId);
  return remember(cache.pools, key, { ...target, x, y, width, height, light }, 16);
}
function directionalLight(frame: ForestShadowFrame): ShadowLight {
  const angle = (Number.isFinite(frame.azimuth) ? frame.azimuth : 135) * Math.PI / 180;
  return { kind: "directional", direction: { x: Math.cos(angle), y: Math.sin(angle) }, elevation: frame.elevation };
}
function directionalMask(cache: SceneCache, frame: ForestShadowFrame): DirectionalMask | undefined {
  const key = JSON.stringify([frame.azimuth, frame.elevation]), existing = cache.shadows.get(key); if (existing) return existing;
  const target = surface(cache.width, cache.height); if (!target) return;
  target.ctx.setTransform(cache.scale, 0, 0, cache.scale, 0, 0);
  const light = directionalLight(frame);
  shadows(target.ctx, cache, light, cache.casters, false);
  return remember(cache.shadows, key, { ...target, light }, 2);
}

/** Directional shadows land on authored surfaces before the building sprites. */
export function drawForestDirectionalShadows(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, frame: ForestShadowFrame) {
  const cache = sceneCache(scene, frame); if (!cache) return;
  const staticMask = directionalMask(cache, frame); if (!staticMask) return;
  const target = frame.actors.length ? cache.directional : staticMask;
  if (frame.actors.length) {
    reset(target); target.ctx.drawImage(staticMask.canvas, 0, 0);
    target.ctx.setTransform(cache.scale, 0, 0, cache.scale, 0, 0);
    shadows(target.ctx, cache, staticMask.light, frame.actors, true);
  }
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha *= .18 * (1 - clamp(frame.night)) + .07 * clamp(frame.night);
  ctx.drawImage(target.canvas, 0, 0, scene.width, scene.height); ctx.restore();
}

/** Final world-space illumination. No pixel readback, background copies, clock
 * updates or camera-sized allocations; false asks the caller for legacy fallback. */
export function drawForestOccludedLighting(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, frame: ForestShadowFrame): boolean {
  const cache = sceneCache(scene, frame); if (!cache) return false;
  const night = clamp(frame.night); if (!night) return true;
  const field = cache.field; reset(field); field.ctx.drawImage(cache.base.canvas, 0, 0);
  field.ctx.globalCompositeOperation = "screen";
  for (const source of frame.sources) {
    if (!validSource(source, frame)) continue;
    const light = pool(cache, source); if (!light) continue;
    const actors = nearbyActors(source, frame.actors);
    let contribution = light.canvas;
    if (actors.length) {
      const scratch = cache.scratch;
      // Grow only to the largest lamp footprint encountered. Clear and sample
      // the current cropped rectangle, never the entire map for a small flame.
      if (scratch.canvas.width < light.canvas.width) scratch.canvas.width = light.canvas.width;
      if (scratch.canvas.height < light.canvas.height) scratch.canvas.height = light.canvas.height;
      reset(scratch, light.canvas.width, light.canvas.height);
      scratch.ctx.drawImage(light.canvas, 0, 0);
      scratch.ctx.setTransform(cache.scale, 0, 0, cache.scale, -light.x * cache.scale, -light.y * cache.scale);
      scratch.ctx.globalCompositeOperation = "destination-out";
      shadows(scratch.ctx, cache, light.light, actors, true, source.ownerSiteId);
      contribution = scratch.canvas;
    }
    // Extra screen energy preserves the bright half of a flame's pulse above
    // intensity=1 without changing or saturating its cached alpha gradient.
    for (const strength of [clamp(source.intensity), clamp(source.intensity - 1)]) {
      if (!strength) continue;
      field.ctx.globalAlpha = strength;
      field.ctx.drawImage(contribution, 0, 0, light.canvas.width, light.canvas.height,
        light.x * cache.scale, light.y * cache.scale, light.canvas.width, light.canvas.height);
    }
  }
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha *= night;
  ctx.drawImage(field.canvas, 0, 0, scene.width, scene.height); ctx.restore(); return true;
}

/** Independent authoring overlays deliberately never inspect Occluders. */
export function drawForestShadowDebug(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, frame: ForestShadowFrame) {
  ctx.save(); ctx.globalAlpha = .8; ctx.globalCompositeOperation = "source-over"; ctx.lineWidth = 1;
  ctx.strokeStyle = "#56d5ec";
  path(ctx, visibleGeometry(scene.shadowReceivers ?? [], frame).map(receiver => receiver.points)); ctx.stroke();
  ctx.strokeStyle = "#d187ff";
  for (const caster of [...visibleCasters(scene, frame), ...frame.actors]) {
    path(ctx, [caster.points]); ctx.stroke();
    const top = caster.points.map(point => ({ x: point.x, y: point.y - caster.baseHeight - caster.height }));
    path(ctx, [top]); ctx.stroke();
    ctx.beginPath(); caster.points.forEach((point, index) => { ctx.moveTo(point.x, point.y); ctx.lineTo(top[index].x, top[index].y); }); ctx.stroke();
  }
  ctx.strokeStyle = "#ffce73";
  for (const source of frame.sources) {
    if (!validSource(source, frame)) continue;
    ctx.beginPath(); ctx.arc(source.position.x, source.position.y, 3, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(source.position.x, source.position.y); ctx.lineTo(source.position.x, source.position.y - source.height); ctx.stroke();
  }
  ctx.restore();
}
