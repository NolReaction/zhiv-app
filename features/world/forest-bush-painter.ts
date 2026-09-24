import type { FixedWorldScene, WorldBounds, WorldBush, WorldPoint } from "./tiled/types";
import { forestBushBounds, forestBushParticles, type ForestBushBurst, type ForestBushParticle } from "./forest-bush-particles";

export type ForestBushFrame = {
  id: string; rustle: number; occlude: boolean;
  /** Encounter clock freezes with the actor, independent of the ambient scene clock. */
  elapsed?: number;
  bursts?: readonly ForestBushBurst[];
};
type TerrainSource = { image: HTMLImageElement; bounds: WorldBounds };
type BushTexture = { leaves: HTMLCanvasElement | null; bounds: WorldBounds; sources: TerrainSource[] };
const textures = new WeakMap<FixedWorldScene, WeakMap<WorldBush, BushTexture>>();
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function polygon(ctx: CanvasRenderingContext2D, points: readonly WorldPoint[]) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
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

const berryColors = [
  { shadow: "#713921", body: "#c97831", light: "#edba60" },
  { shadow: "#783326", body: "#bb5d32", light: "#e89c4b" },
  { shadow: "#75522c", body: "#c5923c", light: "#efd176" },
];

function drawParticles(ctx: CanvasRenderingContext2D, particles: readonly ForestBushParticle[]) {
  if (!particles.length) return;
  ctx.save();
  for (const particle of particles) {
    const height = Math.max(0, particle.groundY - particle.y), closeness = 1 / (1 + height * .12);
    ctx.globalAlpha = particle.opacity * (.05 + .16 * closeness);
    ctx.fillStyle = "#243319";
    ctx.beginPath(); ctx.ellipse(particle.x, particle.groundY + particle.radius * .4,
      particle.radius * (1.2 + .55 * (1 - closeness)), particle.radius * .42, 0, 0, Math.PI * 2); ctx.fill();
  }
  for (const particle of particles) {
    const { radius: r } = particle;
    ctx.save(); ctx.globalAlpha = particle.opacity; ctx.translate(particle.x, particle.y); ctx.rotate(particle.rotation);
    if (particle.kind === "leaf") {
      ctx.fillStyle = ["#9dad48", "#b3ae4c", "#7c963e"][particle.color];
      ctx.beginPath(); ctx.moveTo(-r, 0); ctx.quadraticCurveTo(-r * .2, -r * .8, r, 0);
      ctx.quadraticCurveTo(r * .2, r * .65, -r, 0); ctx.fill();
      ctx.strokeStyle = "#657a33"; ctx.lineWidth = r * .17;
      ctx.beginPath(); ctx.moveTo(-r * .8, 0); ctx.lineTo(r * .85, 0); ctx.stroke();
    } else {
      const palette = berryColors[particle.color];
      ctx.fillStyle = palette.shadow; ctx.beginPath(); ctx.ellipse(0, r * .12, r, r * 1.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = palette.body; ctx.beginPath(); ctx.ellipse(-r * .1, -r * .14, r * .85, r * .88, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = palette.light; ctx.beginPath(); ctx.ellipse(-r * .32, -r * .4, r * .26, r * .35, -.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#577432"; ctx.beginPath(); ctx.moveTo(-r * .4, -r * .78);
      ctx.lineTo(0, -r * 1.12); ctx.lineTo(r * .4, -r * .73); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
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
  const hasClock = Number.isFinite(frame.elapsed);
  const rustle = still && !hasClock ? 0 : clamp(frame.rustle);
  const time = hasClock ? frame.elapsed! : Number.isFinite(elapsed) ? elapsed : 0;
  const bush = scene.bushes?.find(item => item.id === frame.id);
  if (!bush) return;
  const bounds = forestBushBounds(bush);
  if (!bounds) return;
  const particles = forestBushParticles(bush, time, frame.bursts ?? []);
  if (!frame.occlude && !rustle && !particles.length) return;
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
  // Residual berries can settle while the actor is already leaving. They must not
  // reactivate an old foreground mask above an unrelated pose or a new route.
  if (!frame.occlude && !rustle) { drawParticles(ctx, particles); return; }
  const texture = textureFor(scene, bush, bounds, sources);
  ctx.save();
  polygon(ctx, bush.points); ctx.clip();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  // Redraw native terrain through the exact clip so entering a bush does not
  // change its sharpness. This also works without offscreen canvas or Path2D.
  paintTerrain(ctx, sources);
  if (texture && rustle > .001 && texture.leaves) {
    const area = texture.bounds;
    const amplitude = rustle * Math.min(2.1, bounds.width * .028, bounds.height * .034);
    const displacement = (y: number) => {
      const height = clamp((y - bounds.y) / bounds.height), freedom = Math.pow(1 - height, .65);
      return amplitude * freedom * (.72 * Math.sin(time * 13 + height * 2.4)
        + .28 * Math.sin(time * 21 - height * 6));
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
  drawParticles(ctx, particles);
}
