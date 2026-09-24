import type { FixedWorldScene, WorldBounds, WorldBush, WorldPoint } from "./tiled/types";

export type ForestBushFrame = { id: string; rustle: number; occlude: boolean };
type TerrainSource = { image: HTMLImageElement; bounds: WorldBounds };
type BushTexture = { leaves: HTMLCanvasElement | null; bounds: WorldBounds; sources: TerrainSource[] };
const textures = new WeakMap<FixedWorldScene, WeakMap<WorldBush, BushTexture>>();
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function polygon(ctx: CanvasRenderingContext2D, points: readonly WorldPoint[]) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
}

function boundsOf(points: readonly WorldPoint[]): WorldBounds | null {
  if (points.length < 3 || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function overlaps(a: WorldBounds, b: WorldBounds) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function paintTerrain(ctx: CanvasRenderingContext2D, sources: readonly TerrainSource[]) {
  for (const { image, bounds } of sources) {
    ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, bounds.x, bounds.y, bounds.width, bounds.height);
  }
}

/** Keep only a small native-resolution crop, shared by the circle and the world camera. */
function textureFor(scene: FixedWorldScene, bush: WorldBush, bounds: WorldBounds, sources: TerrainSource[]) {
  let byBush = textures.get(scene);
  if (!byBush) { byBush = new WeakMap(); textures.set(scene, byBush); }
  const cached = byBush.get(bush);
  if (cached && cached.sources.length === sources.length && cached.sources.every((source, index) =>
    source.image === sources[index].image && source.bounds === sources[index].bounds)) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas"), padding = 4;
  const density = Math.max(...sources.map(source => Math.max(source.image.naturalWidth / source.bounds.width,
    source.image.naturalHeight / source.bounds.height)));
  const scale = Math.min(4, density, 512 / (Math.max(bounds.width, bounds.height) + padding * 2));
  // Align the crop with native pixels: an unmoving mask should not resample the artwork twice.
  const x = Math.floor((bounds.x - padding) * scale) / scale, y = Math.floor((bounds.y - padding) * scale) / scale;
  canvas.width = Math.max(1, Math.ceil((bounds.x + bounds.width + padding - x) * scale));
  canvas.height = Math.max(1, Math.ceil((bounds.y + bounds.height + padding - y) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const crop = { x, y, width: canvas.width / scale, height: canvas.height / scale };
  ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  paintTerrain(ctx, sources);
  const leaves = document.createElement("canvas"); leaves.width = canvas.width; leaves.height = canvas.height;
  const leafCtx = leaves.getContext("2d");
  if (leafCtx) {
    leafCtx.drawImage(canvas, 0, 0);
    leafCtx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
    leafCtx.globalCompositeOperation = "destination-in";
    polygon(leafCtx, bush.points); leafCtx.fill();
    // Leave a softly anchored perimeter. Moving the baked outline would reveal a
    // second copy on the original terrain, even when the destination is clipped.
    leafCtx.globalCompositeOperation = "destination-out";
    leafCtx.filter = `blur(${scale}px)`;
    leafCtx.lineWidth = 8; leafCtx.lineJoin = "round"; leafCtx.strokeStyle = "#000";
    polygon(leafCtx, bush.points); leafCtx.stroke();
  }
  const result = { leaves: leafCtx ? leaves : null, bounds: crop, sources };
  byBush.set(bush, result);
  return result;
}

/**
 * Foreground foliage comes from the exact Tiled polygon, never a rectangular cover.
 * Call after the actor and before rain/light. The ground itself stays stationary:
 * only pixels inside the authored leaves flex, with their bottom edge anchored.
 */
export function drawForestBush(
  ctx: CanvasRenderingContext2D,
  scene: FixedWorldScene,
  images: ReadonlyMap<string, HTMLImageElement>,
  frame: ForestBushFrame | null | undefined,
  elapsed = 0,
  still = false,
) {
  if (!frame) return;
  const rustle = still ? 0 : clamp(frame.rustle);
  if (!frame.occlude && !rustle) return;
  const bush = scene.bushes?.find(item => item.id === frame.id);
  if (!bush) return;
  const bounds = boundsOf(bush.points);
  if (!bounds) return;
  const padded = { x: bounds.x - 4, y: bounds.y - 4, width: bounds.width + 8, height: bounds.height + 8 };
  const sources: TerrainSource[] = [];
  for (const terrain of scene.terrain) {
    if (!overlaps(padded, terrain.bounds)) continue;
    const image = images.get(terrain.image);
    // Do not retain an incomplete foreground while artwork is still loading.
    if (!image || !image.naturalWidth || !image.naturalHeight) return;
    sources.push({ image, bounds: terrain.bounds });
  }
  if (!sources.length) return;
  const texture = textureFor(scene, bush, bounds, sources);
  ctx.save();
  polygon(ctx, bush.points); ctx.clip();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  // Redraw native terrain through the exact clip so entering a bush does not
  // change its sharpness. This also works without offscreen canvas or Path2D.
  paintTerrain(ctx, sources);
  if (texture && rustle > .001 && texture.leaves) {
    const area = texture.bounds, time = Number.isFinite(elapsed) ? elapsed : 0;
    const amplitude = rustle * Math.min(1.8, bounds.width * .022, bounds.height * .028);
    const displacement = (y: number) => {
      const height = clamp((y - bounds.y) / bounds.height), freedom = Math.pow(1 - height, .65);
      return amplitude * freedom * (.72 * Math.sin(time * 17 + height * 2.4)
        + .28 * Math.sin(time * 27 - height * 6));
    };
    const bands = 12, bandHeight = bounds.height / bands;
    for (let index = 0; index < bands; index++) {
      const y = bounds.y + index * bandHeight, nextY = y + bandHeight;
      const offset = displacement(y), nextOffset = displacement(nextY);
      ctx.save();
      // A continuous shear between row edges avoids detached horizontal leaf strips.
      ctx.beginPath(); ctx.rect(area.x, y, area.width, bandHeight + .15); ctx.clip();
      const shear = (nextOffset - offset) / bandHeight;
      ctx.transform(1, 0, shear, 1, offset - shear * y, 0);
      ctx.drawImage(texture.leaves, area.x, area.y, area.width, area.height);
      ctx.restore();
    }
  }
  ctx.restore();
}
