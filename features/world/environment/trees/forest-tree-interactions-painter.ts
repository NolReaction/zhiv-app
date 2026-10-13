import { forestOcclusionTexture, type ForestOcclusionContour } from "@/features/world/scene/forest-occlusion-mask";
import type { WorldImage } from "@/features/world/tiled/types";
import type { ForestTreeCrown, ForestTreeInteractions } from "./forest-tree-interactions";

type TreePaintOptions = { reducedMotion?: boolean; dusk?: number };
type Surface = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
const surfaces = new WeakMap<CanvasRenderingContext2D, Surface>();
const contours = new WeakMap<ForestTreeCrown, ForestOcclusionContour>();
const palette = [
  { body: "#8b9d4f", edge: "#4b6940", fold: "#c0bf75" },
  { body: "#b39853", edge: "#716544", fold: "#d8bd77" },
  { body: "#769357", edge: "#466743", fold: "#abb976" },
];

function crownTexture(crown: ForestTreeCrown) {
  let contour = contours.get(crown);
  if (!contour) {
    contour = { points: crown.points, left: crown.left, top: crown.top, right: crown.right, bottom: crown.bottom };
    contours.set(crown, contour);
  }
  // Texture bookkeeping belongs to the painter; the interaction model never
  // gains DOM nodes, circular owners or writes caused by drawing another view.
  return forestOcclusionTexture(contour);
}

function localSurface(ctx: CanvasRenderingContext2D): Surface | null {
  if (typeof document === "undefined") return null;
  let surface = surfaces.get(ctx);
  if (!surface) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) return null;
    surface = { canvas, ctx: context }; surfaces.set(ctx, surface);
  }
  // One reusable local surface per camera. At most 512² pixels; no full-world
  // framebuffer copies, source readback, filters or per-frame allocation.
  return surface;
}

/** Animate the painted canopy itself immediately after the backdrop. Only its
 * interior pixels sway; a narrow inward feather preserves the original outer
 * silhouette and trunk, so no duplicate tree or rectangular ground patch moves. */
export function drawForestTreeCrownMotion(ctx: CanvasRenderingContext2D, state: ForestTreeInteractions | undefined,
  image: HTMLImageElement | HTMLCanvasElement, terrain: WorldImage, options: TreePaintOptions = {}) {
  if (!state?.bursts.length || options.reducedMotion || terrain.imagePlacement && terrain.imagePlacement.rotation % 360 !== 0) return;
  const imageWidth = "naturalWidth" in image ? image.naturalWidth : image.width;
  const imageHeight = "naturalHeight" in image ? image.naturalHeight : image.height;
  const source = terrain.imagePlacement ?? terrain.bounds;
  if (!imageWidth || !imageHeight || source.width <= 0 || source.height <= 0) return;
  const sx = imageWidth / source.width, sy = imageHeight / source.height;
  for (const burst of state.bursts) {
    const motion = Math.sin(burst.age * 19) * Math.exp(-burst.age * 4.3) * burst.direction;
    if (Math.abs(motion) < .002) continue;
    const crown = burst.tree, texture = crownTexture(crown); if (!texture) continue;
    const dx = motion * 1.4 * state.scale, dy = motion * .28 * state.scale;
    const sampleX = texture.x + dx - source.x, sampleY = texture.y + dy - source.y;
    if (sampleX < 0 || sampleY < 0 || sampleX + texture.width > source.width || sampleY + texture.height > source.height) continue;
    const scale = Math.min(2, 512 / Math.max(texture.width, texture.height));
    const width = Math.max(1, Math.ceil(texture.width * scale)), height = Math.max(1, Math.ceil(texture.height * scale));
    const surface = localSurface(ctx); if (!surface) continue;
    const target = surface.ctx;
    target.setTransform(1, 0, 0, 1, 0, 0); target.clearRect(0, 0, width, height);
    target.globalAlpha = 1; target.globalCompositeOperation = "source-over"; target.imageSmoothingEnabled = true;
    target.drawImage(image, sampleX * sx, sampleY * sy, texture.width * sx, texture.height * sy, 0, 0, width, height);
    target.globalCompositeOperation = "destination-in";
    target.drawImage(texture.canvas, 0, 0, width, height);
    target.globalCompositeOperation = "source-over";
    ctx.save(); ctx.imageSmoothingEnabled = true;
    ctx.drawImage(surface.canvas, 0, 0, width, height, texture.x, texture.y, texture.width, texture.height); ctx.restore();
  }
}

function blade(ctx: CanvasRenderingContext2D, lobed: boolean) {
  ctx.beginPath(); ctx.moveTo(-.7, 0);
  if (lobed) {
    ctx.quadraticCurveTo(-.65, -.35, -.2, -.4);
    ctx.quadraticCurveTo(-.08, -.69, .16, -.44);
    ctx.quadraticCurveTo(.52, -.46, .58, -.21);
    ctx.lineTo(.98, -.08);
    ctx.quadraticCurveTo(.54, .07, .45, .37);
    ctx.quadraticCurveTo(.18, .24, -.04, .47);
    ctx.quadraticCurveTo(-.47, .39, -.7, 0);
  } else {
    ctx.bezierCurveTo(-.44, -.45, .23, -.55, .98, -.08);
    ctx.bezierCurveTo(.33, .05, -.16, .63, -.7, 0);
  }
  ctx.closePath();
}

/** Render falling, tumbling pointed leaves before scene lighting. Particle
 * motion is owned by the interaction clock, never advanced by a second draw. */
export function drawForestTreeLeaves(ctx: CanvasRenderingContext2D, state: ForestTreeInteractions | undefined,
  options: TreePaintOptions = {}) {
  if (!state?.leaves.length || options.reducedMotion) return;
  const dusk = Number.isFinite(options.dusk) ? Math.max(0, Math.min(1, options.dusk!)) : 0;
  for (const leaf of state.leaves) {
    if (leaf.opacity <= .001) continue;
    const colour = palette[leaf.shape], roll = Math.cos(leaf.phase + leaf.age * 5.4);
    ctx.save(); ctx.translate(leaf.x, leaf.y); ctx.rotate(leaf.rotation);
    ctx.scale(leaf.size, leaf.size * (.22 + Math.abs(roll) * .65));
    ctx.globalAlpha *= leaf.opacity * (1 - dusk * .24);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = colour.edge; ctx.lineWidth = .075;
    ctx.beginPath(); ctx.moveTo(-1.05, .18); ctx.quadraticCurveTo(-.89, .13, -.65, -.01); ctx.stroke();
    blade(ctx, leaf.shape === 1); ctx.fillStyle = roll < 0 ? colour.fold : colour.body; ctx.fill(); ctx.stroke();
    ctx.strokeStyle = colour.fold; ctx.lineWidth = .05;
    ctx.beginPath(); ctx.moveTo(-.67, .02); ctx.quadraticCurveTo(.05, -.13, .83, -.08);
    ctx.moveTo(-.3, -.01); ctx.lineTo(-.13, -.29); ctx.moveTo(-.08, -.06); ctx.lineTo(.15, .23);
    ctx.stroke(); ctx.restore();
  }
}
