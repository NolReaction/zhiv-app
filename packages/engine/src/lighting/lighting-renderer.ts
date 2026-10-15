import { getObjectShadowHeight as defaultShadowHeight } from "../scene/objects.ts";
import type { Bounds, EngineObject } from "../scene/contracts.ts";
import type { LightingState, ScenePointLight } from "./lighting-data.ts";
import { canvasMemoryResources, estimateCacheMemory } from "../rendering/cache-memory.ts";

type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;
export type CasterSource = { image?: CanvasImageSource; bounds: Bounds };
export type ShadowProjection = { matrix: [number, number, number, number, number, number]; bounds: Bounds };
const TILE = 512, FIELD_SCALE = .5;
const radians = (value: number) => value * Math.PI / 180;
const intersects = (a: Bounds, b: Bounds) => a.x + a.width > b.x && a.x < b.x + b.width && a.y + a.height > b.y && a.y < b.y + b.height;

function projection(object: EngineObject, source: Bounds, dx: number, dy: number): ShadowProjection {
  const angle = radians(object.rotation ?? 0), cosine = Math.cos(angle), sine = Math.sin(angle);
  const top = Math.max(1, -source.y), scale = object.scale;
  const localX = (dx * cosine + dy * sine) / scale, localY = (-dx * sine + dy * cosine) / scale;
  const shearX = -localX / top, rawShearY = .08 - localY / top;
  const shearY = Math.abs(rawShearY) < .02 ? (rawShearY < 0 ? -.02 : .02) : rawShearY;
  const matrix: ShadowProjection["matrix"] = [scale * cosine, scale * sine,
    scale * (cosine * shearX - sine * shearY), scale * (sine * shearX + cosine * shearY), object.x, object.y];
  const [a, b, c, d, x, y] = matrix;
  const points = [[source.x, source.y], [source.x + source.width, source.y], [source.x + source.width, source.y + source.height], [source.x, source.y + source.height]]
    .map(([px, py]) => ({ x: a * px + c * py + x, y: b * px + d * py + y }));
  const left = Math.min(...points.map(point => point.x)), topY = Math.min(...points.map(point => point.y));
  return { matrix, bounds: { x: left, y: topY, width: Math.max(...points.map(point => point.x)) - left, height: Math.max(...points.map(point => point.y)) - topY } };
}

/** A billboard's height is projected onto the floor; this is a 2.5D approximation, not mesh geometry. */
export function sunShadowProjection(object: EngineObject, source: Bounds, light: Pick<LightingState, "sunAngle" | "sunElevation">, getObjectShadowHeight: (object: EngineObject) => number = defaultShadowHeight): ShadowProjection {
  const length = getObjectShadowHeight(object) / Math.tan(radians(light.sunElevation));
  const angle = radians(light.sunAngle);
  return projection(object, source, -Math.cos(angle) * length, Math.sin(angle) * length);
}

/** Local sources use a fixed virtual lamp height of 80 world units and a planar alpha blocker. */
export function pointShadowProjection(object: EngineObject, source: Bounds, light: ScenePointLight, getObjectShadowHeight: (object: EngineObject) => number = defaultShadowHeight): ShadowProjection | null {
  const dx = object.x - light.x, dy = object.y - light.y, distance = Math.hypot(dx, dy);
  if (distance < 12 || distance > light.radius + Math.max(source.width, source.height) * object.scale) return null;
  const length = Math.min(light.radius * 1.5, getObjectShadowHeight(object) * Math.min(2.5, distance / 80));
  return projection(object, source, dx / distance * length, dy / distance * length);
}

function sameCaster(a: EngineObject, b: EngineObject, getObjectShadowHeight: (object: EngineObject) => number) {
  return a.kind === b.kind && a.x === b.x && a.y === b.y && a.scale === b.scale && (a.rotation ?? 0) === (b.rotation ?? 0)
    && a.variant === b.variant && a.assetId === b.assetId && a.imageWidth === b.imageWidth && a.imageHeight === b.imageHeight
    && getObjectShadowHeight(a) === getObjectShadowHeight(b);
}

const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const cssRgb = (color: readonly number[]) => `rgb(${color.map(value => Math.max(0, Math.min(255, Math.round(value)))).join(",")})`;

/** Disposable masks never change an imported PNG's bytes or source pixels. */
export function createLightingRenderer(makeCanvas: CanvasFactory, sourceFor: (object: EngineObject) => CasterSource, getObjectShadowHeight: (object: EngineObject) => number = defaultShadowHeight) {
  type Caster = { object: EngineObject; source: CasterSource; sun: ShadowProjection; points: Map<string, ShadowProjection> };
  type RawTile = { bounds: Bounds; alpha: Uint8Array; used: number };
  type PointStamp = { canvas: HTMLCanvasElement; bounds: Bounds; used: number };
  const RAW_BUDGET = 12 * 1024 * 1024, POINT_BUDGET = 8 * 1024 * 1024;
  let lighting: LightingState | undefined, width = 0, height = 0, previousState: LightingState | undefined;
  let geometryKey = "", sunGeometryKey = "", fieldKey = "", disposed = false;
  let baseObjects: readonly EngineObject[] | undefined, previewMap: ReadonlyMap<string, EngineObject> | undefined, previewRevision: number | undefined;
  let base = new Map<string, Caster>(), overlays = new Map<string, Caster | null>();
  const effective = new Map<string, Caster>(), stationary = new Map<string, Caster>();
  const sunIndex = new Map<string, Set<Caster>>(), pointIndex = new Map<string, Map<string, Set<Caster>>>();
  const sunReady = new Set<string>(), fieldReady = new Set<string>(), rawTiles = new Map<string, RawTile>(), pointStamps = new Map<string, PointStamp>();
  let sunWorld: HTMLCanvasElement | undefined, fieldWorld: HTMLCanvasElement | undefined;
  let sunScratch: HTMLCanvasElement | undefined, sunBlur: HTMLCanvasElement | undefined, fieldScratch: HTMLCanvasElement | undefined;
  let sunPatch: HTMLCanvasElement | undefined, sunPatchBlur: HTMLCanvasElement | undefined;
  let fieldPatch: HTMLCanvasElement | undefined, pointPatch: HTMLCanvasElement | undefined, pointMask: HTMLCanvasElement | undefined, pointMaskBlur: HTMLCanvasElement | undefined;
  let sunBuilds = 0, fieldBuilds = 0, casterUpdates = 0, sunPatchBuilds = 0, fieldPatchBuilds = 0, pointStampBuilds = 0;
  let rawBytes = 0, stampBytes = 0, clock = 0, staticVersion = 0, sunPatchKey = "", fieldPatchKey = "";

  function keys(bounds: Bounds, padding = 0): string[] {
    const result: string[] = [], minX = Math.max(0, Math.floor((bounds.x - padding) / TILE)), minY = Math.max(0, Math.floor((bounds.y - padding) / TILE));
    const maxX = Math.min(Math.ceil(width / TILE) - 1, Math.floor((bounds.x + bounds.width + padding) / TILE));
    const maxY = Math.min(Math.ceil(height / TILE) - 1, Math.floor((bounds.y + bounds.height + padding) / TILE));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) result.push(`${x}:${y}`);
    return result;
  }
  const halo = () => Math.ceil((lighting?.shadowSoftness ?? 0) * 1.5) + 3;
  const pointBounds = (light: ScenePointLight): Bounds => ({ x: light.x - light.radius, y: light.y - light.radius, width: light.radius * 2, height: light.radius * 2 });
  const expand = (box: Bounds, padding: number): Bounds => ({ x: Math.floor(box.x - padding), y: Math.floor(box.y - padding), width: Math.ceil(box.x + box.width + padding) - Math.floor(box.x - padding), height: Math.ceil(box.y + box.height + padding) - Math.floor(box.y - padding) });
  const intersection = (a: Bounds, b: Bounds): Bounds | undefined => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
  };
  function union(a: Bounds | undefined, b: Bounds): Bounds {
    if (!a) return b;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
  }
  function dropRaw(key: string) { const old = rawTiles.get(key); if (old) { rawBytes -= old.alpha.byteLength; rawTiles.delete(key); } }
  function dropStamp(id: string) { const old = pointStamps.get(id); if (old) { stampBytes -= old.canvas.width * old.canvas.height * 4; pointStamps.delete(id); } }
  function trim<T extends { used: number }>(entries: Map<string, T>, bytes: () => number, budget: number, drop: (key: string) => void) {
    while (bytes() > budget && entries.size) { let oldest = "", age = Infinity; for (const [key, entry] of entries) if (entry.used < age) { oldest = key; age = entry.used; } drop(oldest); }
  }
  function dirtySun(caster: Caster) { for (const key of keys(caster.sun.bounds, halo())) { sunReady.delete(key); dropRaw(key); } }
  function dirtyPoint(id: string, cast: ShadowProjection) { dropStamp(id); for (const key of keys(cast.bounds, halo())) fieldReady.delete(key); }
  function index(caster: Caster, remove: boolean, invalidate = true) {
    if (invalidate) { dirtySun(caster); staticVersion++; sunPatchKey = ""; fieldPatchKey = ""; }
    for (const key of keys(caster.sun.bounds, halo())) {
      if (remove) { sunIndex.get(key)?.delete(caster); if (!sunIndex.get(key)?.size) sunIndex.delete(key); }
      else { let bucket = sunIndex.get(key); if (!bucket) { bucket = new Set(); sunIndex.set(key, bucket); } bucket.add(caster); }
    }
    for (const [id, cast] of caster.points) {
      if (invalidate) dirtyPoint(id, cast);
      let grid = pointIndex.get(id); if (!grid) { grid = new Map(); pointIndex.set(id, grid); }
      for (const key of keys(cast.bounds, halo())) {
        if (remove) { grid.get(key)?.delete(caster); if (!grid.get(key)?.size) grid.delete(key); }
        else { let bucket = grid.get(key); if (!bucket) { bucket = new Set(); grid.set(key, bucket); } bucket.add(caster); }
      }
    }
  }
  function setStationary(id: string, caster: Caster | null | undefined, invalidate = true) {
    const old = stationary.get(id); if (old === caster) return;
    if (old) { index(old, true, invalidate); stationary.delete(id); }
    if (caster) { stationary.set(id, caster); index(caster, false, invalidate); }
  }
  function replace(id: string, caster: Caster | null | undefined) {
    if (effective.get(id) === caster) return;
    if (caster) effective.set(id, caster); else effective.delete(id);
    casterUpdates++;
  }
  function makeCaster(object: EngineObject): Caster | null {
    if (!lighting || getObjectShadowHeight(object) <= 0
      || (!(lighting.sunIntensity > 0 && lighting.shadowOpacity > 0) && !lighting.points.some(light => light.enabled && light.intensity > 0))) return null;
    const source = sourceFor(object), points = new Map<string, ShadowProjection>();
    for (const light of lighting.points) if (light.enabled && light.intensity > 0) {
      const cast = pointShadowProjection(object, source.bounds, light, getObjectShadowHeight); if (cast) points.set(light.id, cast);
    }
    return { object, source, sun: sunShadowProjection(object, source.bounds, lighting, getObjectShadowHeight), points };
  }

  function sync(nextWidth: number, state: LightingState, objects: readonly EngineObject[], previews: ReadonlyMap<string, EngineObject> | undefined,
    revision: number | undefined, visible: (object: EngineObject) => boolean, nextHeight = nextWidth) {
    if (disposed) return;
    if (!state.enabled) { lighting = state; return; }
    let geometryChanged = !lighting?.enabled, sunChanged = geometryChanged;
    if (previousState !== state) {
      const nextSun = JSON.stringify([state.sunAngle, state.sunElevation, state.shadowSoftness, state.sunIntensity > 0 && state.shadowOpacity > 0]);
      sunChanged ||= nextSun !== sunGeometryKey; sunGeometryKey = nextSun;
      const nextGeometry = JSON.stringify([nextSun, state.points.map(light => [light.id, light.x, light.y, light.radius, light.enabled, light.intensity > 0])]);
      const nextField = JSON.stringify([state.ambient, state.ambientColor, state.sunElevation, state.sunIntensity, state.sunColor]);
      geometryChanged ||= nextGeometry !== geometryKey;
      if (nextField !== fieldKey) { fieldReady.clear(); fieldKey = nextField; }
      const oldPoints = new Map(previousState?.points.map(light => [light.id, light]) ?? []);
      for (const light of state.points) {
        const old = oldPoints.get(light.id); oldPoints.delete(light.id);
        if (!old || old.x !== light.x || old.y !== light.y || old.radius !== light.radius || old.intensity !== light.intensity || old.color !== light.color
          || old.enabled !== light.enabled || previousState?.shadowSoftness !== state.shadowSoftness) {
          dropStamp(light.id);
          for (const value of [old, light]) if (value) for (const key of keys(pointBounds(value), halo())) fieldReady.delete(key);
        }
      }
      for (const light of oldPoints.values()) { dropStamp(light.id); for (const key of keys(pointBounds(light), halo())) fieldReady.delete(key); }
      geometryKey = nextGeometry; previousState = state; fieldPatchKey = "";
    }
    const preserveSun = !sunChanged && width === nextWidth && height === nextHeight && baseObjects === objects && previewMap === previews && previewRevision === revision;
    lighting = state;
    if ((width !== nextWidth || height !== nextHeight)) {
      width = nextWidth; height = nextHeight; geometryChanged = true; sunChanged = true; sunWorld = undefined; fieldWorld = undefined; sunReady.clear(); fieldReady.clear();
    }
    if (geometryChanged) {
      baseObjects = undefined; previewRevision = undefined; base.clear(); overlays.clear(); effective.clear(); stationary.clear(); sunIndex.clear(); pointIndex.clear();
      if (!preserveSun) { sunReady.clear(); rawTiles.clear(); rawBytes = 0; staticVersion++; }
      if (sunChanged) { fieldReady.clear(); pointStamps.clear(); stampBytes = 0; }
      sunPatchKey = ""; fieldPatchKey = "";
    }
    if (baseObjects !== objects) {
      const fresh = new Map<string, Caster>();
      for (const object of objects) {
        const old = base.get(object.id), caster = old && sameCaster(old.object, object, getObjectShadowHeight) ? old : makeCaster(object);
        if (caster) fresh.set(object.id, caster);
        if (!overlays.has(object.id)) { replace(object.id, caster); setStationary(object.id, caster, !geometryChanged); }
      }
      for (const id of base.keys()) if (!fresh.has(id) && !overlays.has(id)) { replace(id, null); setStationary(id, null); }
      base = fresh; baseObjects = objects;
    }
    if (previewMap !== previews || previewRevision !== revision || geometryChanged) {
      const fresh = new Map<string, Caster | null>();
      for (const [id, object] of previews ?? []) {
        const old = overlays.get(id), caster = visible(object) ? old && sameCaster(old.object, object, getObjectShadowHeight) ? old : makeCaster(object) : null;
        fresh.set(id, caster); setStationary(id, null, !geometryChanged); replace(id, caster);
      }
      for (const id of overlays.keys()) if (!fresh.has(id)) { replace(id, base.get(id)); setStationary(id, base.get(id)); }
      overlays = fresh; previewMap = previews; previewRevision = revision; sunPatchKey = ""; fieldPatchKey = "";
    }
  }

  function drawCaster(ctx: CanvasRenderingContext2D, caster: Caster, cast: ShadowProjection) {
    if (!caster.source.image) return;
    ctx.save(); ctx.transform(...cast.matrix);
    const box = caster.source.bounds; ctx.drawImage(caster.source.image, box.x, box.y, box.width, box.height); ctx.restore();
  }
  function context(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Не удалось подготовить свет."); return ctx;
  }
  function clear(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  function worldTransform(ctx: CanvasRenderingContext2D, bounds: Bounds, scale = 1) { ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale); }
  function black(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "source-in"; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
  }
  function copyCore(source: HTMLCanvasElement, target: HTMLCanvasElement, tx: number, ty: number, padding: number, scale: number) {
    const ctx = context(target), w = Math.min(TILE, width - tx * TILE) * scale, h = Math.min(TILE, height - ty * TILE) * scale;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false; ctx.clearRect(tx * TILE * scale, ty * TILE * scale, w, h);
    ctx.drawImage(source, padding * scale, padding * scale, w, h, tx * TILE * scale, ty * TILE * scale, w, h); ctx.restore();
  }
  function sunTile(tx: number, ty: number, requireRaw = false) {
    const key = `${tx}:${ty}`; if ((sunReady.has(key) && (!requireRaw || rawTiles.has(key))) || !lighting) return;
    const padding = halo(), side = TILE + padding * 2;
    sunWorld ??= makeCanvas(width, height);
    if (!sunScratch || sunScratch.width !== side) { sunScratch = makeCanvas(side, side); sunBlur = makeCanvas(side, side); }
    const ctx = context(sunScratch), blur = context(sunBlur!);
    ctx.save(); clear(ctx, sunScratch); ctx.translate(padding - tx * TILE, padding - ty * TILE);
    for (const caster of sunIndex.get(key) ?? []) drawCaster(ctx, caster, caster.sun);
    ctx.restore(); black(ctx, sunScratch);
    // Only black alpha is read back. Imported source RGBA never makes a round trip.
    const w = Math.min(TILE, width - tx * TILE) + padding * 2, h = Math.min(TILE, height - ty * TILE) + padding * 2;
    const pixels = ctx.getImageData(0, 0, w, h);
    if (pixels?.data) {
      const alpha = new Uint8Array(w * h); for (let i = 0; i < alpha.length; i++) alpha[i] = pixels.data[i * 4 + 3];
      dropRaw(key); rawTiles.set(key, { bounds: { x: tx * TILE - padding, y: ty * TILE - padding, width: w, height: h }, alpha, used: ++clock }); rawBytes += alpha.byteLength;
      trim(rawTiles, () => rawBytes, RAW_BUDGET, dropRaw);
    }
    blur.save(); clear(blur, sunBlur!); blur.filter = `blur(${lighting.shadowSoftness / 2}px)`; blur.drawImage(sunScratch, 0, 0); blur.restore();
    copyCore(sunBlur!, sunWorld, tx, ty, padding, 1); sunReady.add(key); sunBuilds++;
  }
  function fillRaw(ctx: CanvasRenderingContext2D, bounds: Bounds) {
    const image = ctx.createImageData(bounds.width, bounds.height);
    if (!image?.data) {
      // Test contexts may omit pixel APIs; browsers always use the bounded alpha cache.
      ctx.save(); worldTransform(ctx, bounds); const casters = new Set<Caster>();
      for (const key of keys(bounds, halo())) for (const caster of sunIndex.get(key) ?? []) casters.add(caster);
      for (const caster of casters) drawCaster(ctx, caster, caster.sun); ctx.restore(); return;
    }
    for (const key of keys(bounds)) { const [tx, ty] = key.split(":").map(Number); sunTile(tx, ty, true); }
    for (const [key, tile] of rawTiles) {
      const [tx, ty] = key.split(":").map(Number), coreX = tx * TILE, coreY = ty * TILE;
      const domain = { x: tx === 0 ? tile.bounds.x : coreX, y: ty === 0 ? tile.bounds.y : coreY,
        width: Math.min(TILE, width - coreX) + (tx === 0 ? halo() : 0) + (tx === Math.ceil(width / TILE) - 1 ? halo() : 0),
        height: Math.min(TILE, height - coreY) + (ty === 0 ? halo() : 0) + (ty === Math.ceil(height / TILE) - 1 ? halo() : 0) };
      const overlap = intersection(bounds, domain); if (!overlap) continue; tile.used = ++clock;
      for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
        let source = (y - tile.bounds.y) * tile.bounds.width + overlap.x - tile.bounds.x;
        let dest = ((y - bounds.y) * bounds.width + overlap.x - bounds.x) * 4 + 3;
        for (let x = 0; x < overlap.width; x++, source++, dest += 4) image.data[dest] = tile.alpha[source];
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  function pointStamp(light: ScenePointLight): PointStamp {
    const cached = pointStamps.get(light.id); if (cached) { cached.used = ++clock; return cached; }
    const bounds = alignField(expand(pointBounds(light), halo()));
    const canvas = makeCanvas(Math.ceil(bounds.width * FIELD_SCALE), Math.ceil(bounds.height * FIELD_SCALE)), ctx = context(canvas);
    ctx.save(); worldTransform(ctx, bounds, FIELD_SCALE);
    const strength = Math.min(.98, light.intensity * .72), color = rgb(light.color);
    const gradient = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, light.radius);
    gradient.addColorStop(0, `rgba(${color.join(",")},${strength})`); gradient.addColorStop(.35, `rgba(${color.join(",")},${strength * .72})`);
    gradient.addColorStop(.75, `rgba(${color.join(",")},${strength * .2})`); gradient.addColorStop(1, `rgba(${color.join(",")},0)`);
    ctx.fillStyle = gradient; ctx.fillRect(light.x - light.radius, light.y - light.radius, light.radius * 2, light.radius * 2);
    ctx.globalCompositeOperation = "destination-out"; ctx.globalAlpha = .78; ctx.filter = `blur(${lighting!.shadowSoftness * FIELD_SCALE / 2}px)`;
    const casters = new Set<Caster>(); for (const bucket of pointIndex.get(light.id)?.values() ?? []) for (const caster of bucket) casters.add(caster);
    for (const caster of casters) { const cast = caster.points.get(light.id); if (cast && intersects(expand(cast.bounds, halo()), bounds)) drawCaster(ctx, caster, cast); }
    ctx.restore(); const entry = { canvas, bounds, used: ++clock }; pointStamps.set(light.id, entry); stampBytes += canvas.width * canvas.height * 4;
    trim(pointStamps, () => stampBytes, POINT_BUDGET, dropStamp); pointStampBuilds++; return entry;
  }
  function ambient(ctx: CanvasRenderingContext2D, area: Bounds) {
    const color = rgb(lighting!.ambientColor), sun = rgb(lighting!.sunColor), strength = lighting!.sunIntensity * Math.sin(radians(lighting!.sunElevation));
    ctx.fillStyle = cssRgb(color.map((value, index) => value * lighting!.ambient + sun[index] * strength)); ctx.fillRect(area.x, area.y, area.width, area.height);
  }
  function drawStamp(ctx: CanvasRenderingContext2D, stamp: PointStamp) {
    ctx.drawImage(stamp.canvas, stamp.bounds.x, stamp.bounds.y, stamp.bounds.width, stamp.bounds.height);
  }
  function fieldTile(tx: number, ty: number) {
    const key = `${tx}:${ty}`; if (fieldReady.has(key) || !lighting) return;
    const padding = Math.ceil(halo() / 2) * 2, side = (TILE + padding * 2) * FIELD_SCALE;
    fieldWorld ??= makeCanvas(Math.ceil(width * FIELD_SCALE), Math.ceil(height * FIELD_SCALE));
    if (!fieldScratch || fieldScratch.width !== side) fieldScratch = makeCanvas(side, side);
    const ctx = context(fieldScratch), area = { x: tx * TILE - padding, y: ty * TILE - padding, width: TILE + padding * 2, height: TILE + padding * 2 };
    ctx.save(); worldTransform(ctx, area, FIELD_SCALE); ambient(ctx, area); ctx.globalCompositeOperation = "screen";
    for (const light of lighting.points) if (light.enabled && light.intensity > 0 && intersects(area, pointBounds(light))) drawStamp(ctx, pointStamp(light));
    ctx.restore(); copyCore(fieldScratch, fieldWorld, tx, ty, padding, FIELD_SCALE); fieldReady.add(key); fieldBuilds++;
  }
  function ensure(view: Bounds, tile: (x: number, y: number) => void) { for (const key of keys(view)) { const [x, y] = key.split(":").map(Number); tile(x, y); } }
  function alignField(box: Bounds): Bounds {
    const x = Math.floor(box.x / 2) * 2, y = Math.floor(box.y / 2) * 2;
    return { x, y, width: Math.ceil((box.x + box.width) / 2) * 2 - x, height: Math.ceil((box.y + box.height) / 2) * 2 - y };
  }
  function repairBounds(points: boolean): Bounds | undefined {
    let bounds: Bounds | undefined;
    for (const caster of overlays.values()) if (caster) {
      if (!points) bounds = union(bounds, expand(caster.sun.bounds, halo()));
      else for (const light of lighting!.points) {
        const cast = caster.points.get(light.id); if (!cast || !light.enabled || light.intensity <= 0) continue;
        const affected = intersection(expand(cast.bounds, halo()), expand(pointBounds(light), halo())); if (affected) bounds = union(bounds, affected);
      }
    }
    return bounds && intersection(points ? alignField(bounds) : bounds, { x: 0, y: 0, width, height: height });
  }
  function outside(ctx: CanvasRenderingContext2D, box: Bounds, draw: () => void) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip("evenodd"); draw(); ctx.restore();
  }
  function patches(box: Bounds, view: Bounds, draw: (core: Bounds, cacheable: boolean) => void) {
    if (box.width <= TILE && box.height <= TILE) { if (intersects(box, view)) draw(box, true); return; }
    // Oversized PNGs/groups are streamed through one bounded patch, including projections far outside the map.
    for (let y = box.y; y < box.y + box.height; y += TILE) for (let x = box.x; x < box.x + box.width; x += TILE) {
      const core = { x, y, width: Math.min(TILE, box.x + box.width - x), height: Math.min(TILE, box.y + box.height - y) };
      if (intersects(core, view)) draw(core, false);
    }
  }
  function patchKey(core: Bounds) { return `${staticVersion}:${previewRevision}:${core.x}:${core.y}:${core.width}:${core.height}`; }
  function buildSunPatch(core: Bounds, cacheable: boolean) {
    const key = patchKey(core); if (cacheable && key === sunPatchKey && sunPatchBlur) return;
    const area = expand(core, halo()), w = Math.ceil(area.width / 32) * 32, h = Math.ceil(area.height / 32) * 32;
    if (!sunPatch || sunPatch.width !== w || sunPatch.height !== h) { sunPatch = makeCanvas(w, h); sunPatchBlur = makeCanvas(w, h); }
    const ctx = context(sunPatch), blur = context(sunPatchBlur!);
    ctx.save(); clear(ctx, sunPatch); fillRaw(ctx, area); worldTransform(ctx, area);
    for (const caster of overlays.values()) if (caster && intersects(caster.sun.bounds, area)) drawCaster(ctx, caster, caster.sun);
    ctx.restore(); black(ctx, sunPatch);
    blur.save(); clear(blur, sunPatchBlur!); blur.filter = `blur(${lighting!.shadowSoftness / 2}px)`; blur.drawImage(sunPatch, 0, 0); blur.restore();
    sunPatchKey = cacheable ? key : ""; sunPatchBuilds++;
  }
  function buildFieldPatch(core: Bounds, cacheable: boolean) {
    const key = patchKey(core); if (cacheable && key === fieldPatchKey && fieldPatch) return;
    const area = expand(core, Math.ceil(halo() / 2) * 2), w = Math.ceil(area.width * FIELD_SCALE / 32) * 32, h = Math.ceil(area.height * FIELD_SCALE / 32) * 32;
    if (!fieldPatch || fieldPatch.width !== w || fieldPatch.height !== h) {
      fieldPatch = makeCanvas(w, h); pointPatch = makeCanvas(w, h); pointMask = makeCanvas(w, h); pointMaskBlur = makeCanvas(w, h);
    }
    const ctx = context(fieldPatch), point = context(pointPatch!), mask = context(pointMask!), blur = context(pointMaskBlur!);
    ctx.save(); worldTransform(ctx, area, FIELD_SCALE); ambient(ctx, area);
    for (const light of lighting!.points) {
      if (!light.enabled || light.intensity <= 0 || !intersects(area, pointBounds(light))) continue;
      point.save(); clear(point, pointPatch!); worldTransform(point, area, FIELD_SCALE); drawStamp(point, pointStamp(light));
      for (const caster of overlays.values()) {
        const cast = caster?.points.get(light.id); if (!caster || !cast || !intersects(expand(cast.bounds, halo()), area)) continue;
        // Each blocker attenuates the lamp once, preserving the original overlapping-blocker semantics.
        mask.save(); clear(mask, pointMask!); worldTransform(mask, area, FIELD_SCALE); drawCaster(mask, caster, cast); mask.restore(); black(mask, pointMask!);
        blur.save(); clear(blur, pointMaskBlur!); blur.filter = `blur(${lighting!.shadowSoftness * FIELD_SCALE / 2}px)`; blur.drawImage(pointMask!, 0, 0); blur.restore();
        point.save(); point.setTransform(1, 0, 0, 1, 0, 0); point.globalCompositeOperation = "destination-out"; point.globalAlpha = .78; point.drawImage(pointMaskBlur!, 0, 0); point.restore();
      }
      point.restore(); ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = "screen"; ctx.drawImage(pointPatch!, 0, 0); ctx.restore();
    }
    ctx.restore(); fieldPatchKey = cacheable ? key : ""; fieldPatchBuilds++;
  }
  function paintGroundShadows(ctx: CanvasRenderingContext2D, view: Bounds) {
    if (disposed || !lighting?.enabled || lighting.sunIntensity <= 0 || lighting.shadowOpacity <= 0) return;
    ensure(view, sunTile); if (!sunWorld) return;
    const repair = repairBounds(false);
    ctx.save(); ctx.globalAlpha = lighting.shadowOpacity * Math.min(1, lighting.sunIntensity * 1.5);
    if (!repair) ctx.drawImage(sunWorld, 0, 0);
    else {
      outside(ctx, repair, () => ctx.drawImage(sunWorld!, 0, 0));
      patches(repair, view, (core, cacheable) => { buildSunPatch(core, cacheable); const padding = halo(); ctx.drawImage(sunPatchBlur!, padding, padding, core.width, core.height, core.x, core.y, core.width, core.height); });
    }
    ctx.restore();
  }
  function paintIllumination(ctx: CanvasRenderingContext2D, view: Bounds) {
    if (disposed || !lighting?.enabled) return;
    ensure(view, fieldTile); if (!fieldWorld) return;
    const repair = repairBounds(true);
    ctx.save(); ctx.globalCompositeOperation = "multiply";
    if (!repair) ctx.drawImage(fieldWorld, 0, 0, width * FIELD_SCALE, height * FIELD_SCALE, 0, 0, width, height);
    else {
      outside(ctx, repair, () => ctx.drawImage(fieldWorld!, 0, 0, width * FIELD_SCALE, height * FIELD_SCALE, 0, 0, width, height));
      patches(repair, view, (core, cacheable) => { buildFieldPatch(core, cacheable); const padding = Math.ceil(halo() / 2) * 2;
        ctx.drawImage(fieldPatch!, padding * FIELD_SCALE, padding * FIELD_SCALE, core.width * FIELD_SCALE, core.height * FIELD_SCALE, core.x, core.y, core.width, core.height); });
    }
    const exposure = lighting.ambient + lighting.sunIntensity * Math.sin(radians(lighting.sunElevation));
    if (exposure > 1) { ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = Math.min(.3, (exposure - 1) * .25); ctx.fillStyle = lighting.sunColor; ctx.fillRect(view.x, view.y, view.width, view.height); }
    ctx.restore();
  }
  function invalidateAsset(id: string) {
    if (disposed || !lighting?.enabled) return;
    const casters = new Set([...base.values(), ...effective.values()]);
    for (const caster of casters) if (caster.object.kind === "image" && caster.object.assetId === id) {
      caster.source = sourceFor(caster.object);
      if (stationary.get(caster.object.id) === caster) { dirtySun(caster); for (const [light, cast] of caster.points) dirtyPoint(light, cast); staticVersion++; }
    }
    sunPatchKey = ""; fieldPatchKey = "";
  }
  return { sync, paintGroundShadows, paintIllumination, invalidateAsset,
    diagnostics: (seen?: Set<object>) => ({ sunBuilds, fieldBuilds, casterUpdates, sunPatchBuilds, fieldPatchBuilds, pointStampBuilds, rawBytes, stampBytes,
      pixels: [sunWorld, fieldWorld, sunScratch, sunBlur, fieldScratch, sunPatch, sunPatchBlur, fieldPatch, pointPatch, pointMask, pointMaskBlur].reduce((sum, canvas) => sum + (canvas ? canvas.width * canvas.height : 0), 0) + stampBytes / 4,
      memory: estimateCacheMemory({
        lightingWorld: canvasMemoryResources([sunWorld, fieldWorld]),
        lightingWorkspace: canvasMemoryResources([sunScratch, sunBlur, fieldScratch, sunPatch, sunPatchBlur, fieldPatch, pointPatch, pointMask, pointMaskBlur]),
        lightingPointStamps: canvasMemoryResources(Array.from(pointStamps.values(), stamp => stamp.canvas)),
      }, rawBytes, seen),
      budgets: { rawBufferBytes: RAW_BUDGET, pointStampBytes: POINT_BUDGET } }),
    dispose() { disposed = true; lighting = undefined; base.clear(); overlays.clear(); effective.clear(); stationary.clear(); sunIndex.clear(); pointIndex.clear(); sunReady.clear(); fieldReady.clear(); rawTiles.clear(); pointStamps.clear(); rawBytes = 0; stampBytes = 0;
      sunWorld = undefined; fieldWorld = undefined; sunScratch = undefined; sunBlur = undefined; fieldScratch = undefined; sunPatch = undefined; sunPatchBlur = undefined; fieldPatch = undefined; pointPatch = undefined; pointMask = undefined; pointMaskBlur = undefined; baseObjects = undefined; previewMap = undefined; } };
}
