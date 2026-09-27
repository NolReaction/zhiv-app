import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldBush, WorldPoint } from "./tiled/types";
import { FOREST_GARDEN_LIMITS, type ForestGardenState } from "./forest-garden";
import { heroSourceAnchor, type FaunaActor, type HeroAnchorPose } from "./hero-anchors";
import { previewPointInPolygon } from "./tiled/preview-state";

const TAU = Math.PI * 2;
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const blend = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * unit(t), y: a.y + (b.y - a.y) * unit(t) });
type GardenBerry = WorldPoint & { radius: number; growth: number };
const berryLayouts = new WeakMap<WorldBush, Array<WorldPoint & { radius: number }>>();
type BasketVisual = WorldPoint & { size: number; berries: number; behind: boolean; grounded: boolean };
export type ForestGardenVisualFrame = {
  pose: PixelPose; direction: PixelDirection; frame: number;
  basket: BasketVisual | null;
  can: (WorldPoint & { size: number; side: number; target: WorldPoint; pouring: boolean }) | null;
  pickedBerry: (WorldPoint & { size: number }) | null;
  elapsed: number; still: boolean;
};

/** Stable scatter within the authored leaves; neither the terrain nor its silhouette is replaced. */
export function forestGardenBerries(scene: FixedWorldScene, garden: ForestGardenState | undefined): GardenBerry[] {
  if (!garden) return [];
  const result: GardenBerry[] = [];
  for (const plant of garden.bushes) {
    const bush = scene.bushes?.find(item => item.id === plant.id), growth = unit(plant.growth);
    if (!bush || bush.points.length < 3 || growth < .15) continue;
    const cached = berryLayouts.get(bush);
    if (cached) { result.push(...cached.map(berry => ({ ...berry, growth }))); continue; }
    const xs = bush.points.map(p => p.x), ys = bush.points.map(p => p.y);
    const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const radius = Math.min(1.6, Math.min(width, height) * .027);
    let seed = [...plant.id].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0) | 0, 13) >>> 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
    const accepted: Array<WorldPoint & { radius: number }> = [];
    for (let attempt = 0; attempt < 80 && accepted.length < 11; attempt++) {
      const point = { x: left + width * (.16 + random() * .68), y: top + height * (.19 + random() * .62) };
      if (![[0, 0], [-radius * 2, 0], [radius * 2, 0], [0, -radius * 2], [0, radius * 2]].every(([dx, dy]) =>
        previewPointInPolygon({ x: point.x + dx, y: point.y + dy }, bush.points))) continue;
      if (accepted.some(other => Math.hypot(other.x - point.x, other.y - point.y) < radius * 6)) continue;
      accepted.push({ ...point, radius });
    }
    berryLayouts.set(bush, accepted);
    result.push(...accepted.map(berry => ({ ...berry, growth })));
  }
  return result;
}

function drawBerry(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number, growth: number) {
  const ripe = growth >= .98, coloring = growth > .76;
  ctx.fillStyle = ripe ? "#693426" : coloring ? "#697433" : "#395b2b";
  ctx.beginPath(); ctx.ellipse(point.x, point.y, radius, radius * 1.1, -.18, 0, TAU); ctx.fill();
  ctx.fillStyle = ripe ? "#ce7538" : coloring ? "#b69b41" : "#88a54a";
  ctx.beginPath(); ctx.ellipse(point.x - radius * .13, point.y - radius * .18, radius * .78, radius * .82, -.18, 0, TAU); ctx.fill();
  ctx.fillStyle = ripe ? "#f0bb70" : "#bcce70";
  ctx.fillRect(point.x - radius * .42, point.y - radius * .55, radius * .38, radius * .38);
  ctx.fillStyle = "#537637"; ctx.fillRect(point.x - radius * .3, point.y - radius * 1.28, radius * .5, radius * .48);
}

/** Repaint after an occupied bush's foreground mask; otherwise draw behind the actor. */
export function drawForestGardenPlants(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, garden: ForestGardenState | undefined) {
  const berries = forestGardenBerries(scene, garden);
  if (!berries.length) return;
  ctx.save();
  for (const berry of berries) {
    if (berry.growth < .4) {
      const r = berry.radius * .62;
      ctx.fillStyle = "#e3dec0";
      for (let petal = 0; petal < 4; petal++) {
        const angle = petal * Math.PI / 2;
        ctx.beginPath(); ctx.ellipse(berry.x + Math.cos(angle) * r * .8, berry.y + Math.sin(angle) * r * .65,
          r * .65, r * .52, angle, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = "#c8b45c"; ctx.fillRect(berry.x - r * .35, berry.y - r * .35, r * .7, r * .7);
    } else drawBerry(ctx, berry, berry.radius * (.55 + unit((berry.growth - .4) / .58) * .45), berry.growth);
  }
  ctx.restore();
}

/** Pure rig sampling uses the routine clock, never a second camera's wall clock. */
export function forestGardenVisualFrame(garden: ForestGardenState | undefined, actor: FaunaActor,
  motion: HeroAnchorPose, still = false): ForestGardenVisualFrame | null {
  const routine = garden?.routine;
  if (!garden || !routine) return null;
  const t = Number.isFinite(routine.elapsed) ? Math.max(0, routine.elapsed) : 0;
  const working = routine.phase === "water" || routine.phase === "collect";
  const lowering = routine.phase === "take-basket" || routine.phase === "deposit";
  const plant = garden.bushes.find(item => item.id === routine.bushId);
  const crownX = plant?.points.length ? plant.points.reduce((sum, point) => sum + point.x, 0) / plant.points.length : actor.x;
  const pose: PixelPose = working ? routine.phase === "water" ? "hold" : "reach"
    : lowering ? "reach" : routine.carryingBasket ? "carry" : motion.pose;
  const frame = working ? routine.phase === "water" ? 3 : Math.floor(t * 2) % 4
    : lowering ? Math.min(3, Math.floor(t * 3)) : motion.frame;
  const direction = working ? crownX < actor.x ? "left" : "right" : lowering ? "front" : motion.direction;
  const anchorPose = { pose, frame, direction };
  const hand = heroSourceAnchor(actor, { x: 24, y: pose === "hold" ? 29 : pose === "reach" ? 35 + frame : 30 - frame % 2 }, anchorPose);
  let basket: BasketVisual | null = null;
  if (garden.basket && (routine.carryingBasket || lowering)) {
    let position = { x: hand.x, y: hand.y + actor.size * .13 }, grounded = false;
    const ground = { x: actor.x + actor.size * .24, y: actor.y + actor.size * .035 };
    if (routine.phase === "collect") {
      const lift = unit((t - 4.2) / .8);
      position = blend(ground, position, lift); grounded = lift === 0;
    }
    else if (routine.phase === "take-basket") position = blend(garden.basket.position, position, t);
    else if (routine.phase === "deposit") position = blend(position, garden.basket.homePosition, t / 1.5);
    const picked = routine.phase === "return-basket" || routine.phase === "deposit" ? FOREST_GARDEN_LIMITS.harvest
      : routine.phase === "collect" ? Math.floor(unit(t / 5) * FOREST_GARDEN_LIMITS.harvest) : 0;
    basket = { ...position, size: actor.size * .32, berries: Math.min(garden.basket.capacity, garden.basket.berries + picked),
      behind: direction === "back" && !grounded, grounded };
  }
  let can: ForestGardenVisualFrame["can"] = null;
  if (routine.kind === "water-bush" && routine.phase === "water") {
    const nearest = plant?.points.reduce<WorldPoint | null>((best, point) => !best
      || Math.hypot(point.x - actor.x, point.y - actor.y) < Math.hypot(best.x - actor.x, best.y - actor.y) ? point : best, null);
    if (nearest) can = { x: hand.x, y: hand.y, size: actor.size * .3, side: nearest.x < hand.x ? -1 : 1,
      target: nearest, pouring: t > .5 && t < 3.6 };
  }
  const pickedBerry = routine.phase === "collect" && (t * 1.1) % 1 > .45
    ? { ...hand, size: actor.size * .033 } : null;
  return { pose, frame, direction, basket, can, pickedBerry, elapsed: t, still };
}

function drawBasket(ctx: CanvasRenderingContext2D, basket: BasketVisual) {
  const u = basket.size / 14, { x, y } = basket;
  ctx.save(); ctx.translate(x, y); ctx.scale(u, u);
  const alpha = ctx.globalAlpha;
  if (basket.grounded) {
    ctx.globalAlpha *= .16; ctx.fillStyle = "#253719";
    ctx.beginPath(); ctx.ellipse(0, .2, 7.5, 2.1, 0, 0, TAU); ctx.fill(); ctx.globalAlpha = alpha;
  }
  ctx.fillStyle = "#62462b";
  ctx.fillRect(-5, -14, 10, 2); ctx.fillRect(-7, -12, 2, 7); ctx.fillRect(5, -12, 2, 7);
  ctx.fillStyle = "#c69a57"; ctx.fillRect(-4, -14, 8, 1); ctx.fillRect(-6, -12, 1, 6);
  ctx.fillStyle = "#523d26"; ctx.fillRect(-7, -8, 14, 7); ctx.fillRect(-6, -1, 12, 1);
  ctx.fillStyle = "#966c37"; ctx.fillRect(-6, -7, 12, 6);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
    ctx.fillStyle = (row + col) % 2 ? "#b68a49" : "#c29b60";
    ctx.fillRect(-6 + col * 2.4 + row % 2 * .5, -6 + row * 1.9, 1.6, .8);
  }
  ctx.fillStyle = "#694526"; ctx.fillRect(-7, -8, 14, 2);
  const count = Math.max(0, Math.min(7, Math.ceil(basket.berries / 2)));
  for (let index = 0; index < count; index++) drawBerry(ctx,
    { x: -4.8 + index % 4 * 3.1 + (index >= 4 ? 1.1 : 0), y: -8.2 - (index >= 4 ? 1.6 : 0) }, 1.2, 1);
  ctx.fillStyle = "#d2ad6c"; ctx.fillRect(-7, -7, 14, 1);
  ctx.restore();
}

/** A parked basket remains attached to its safe ground point after cancellation. */
export function drawForestGardenGround(ctx: CanvasRenderingContext2D, garden: ForestGardenState | undefined,
  size: number, frame: ForestGardenVisualFrame | null) {
  if (!garden?.basket) return;
  if (frame?.basket) {
    if (frame.basket.grounded) drawBasket(ctx, frame.basket);
    return;
  }
  if (garden.routine?.carryingBasket) return;
  drawBasket(ctx, { ...garden.basket.position, size: size * .32, berries: garden.basket.berries, behind: false, grounded: true });
}

export function drawForestGardenProps(ctx: CanvasRenderingContext2D, frame: ForestGardenVisualFrame | null, layer: "behind" | "front") {
  if (!frame) return;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  if (frame.basket && !frame.basket.grounded && frame.basket.behind === (layer === "behind")) drawBasket(ctx, frame.basket);
  if (layer === "behind") { ctx.restore(); return; }
  if (frame.can) {
    const can = frame.can, u = can.size / 14;
    const tilt = unit(Math.min(frame.elapsed / .5, (4 - frame.elapsed) / .4)) * .22;
    ctx.save(); ctx.translate(can.x, can.y); ctx.scale(can.side * u, u); ctx.rotate(tilt);
    ctx.fillStyle = "#334b43"; ctx.fillRect(-6, -2, 10, 9); ctx.fillRect(-5, 7, 8, 1);
    ctx.fillRect(-8, -6, 7, 2); ctx.fillRect(-9, -4, 2, 7); ctx.fillRect(-7, 2, 2, 2);
    ctx.fillStyle = "#6f9380"; ctx.fillRect(-5, -1, 8, 7); ctx.fillRect(-7, -5, 5, 1);
    ctx.fillStyle = "#94b49a"; ctx.fillRect(-5, -1, 7, 2); ctx.fillRect(-5, 1, 1, 4);
    ctx.fillStyle = "#486657"; ctx.fillRect(3, 0, 3, 3); ctx.fillRect(5, -2, 3, 3); ctx.fillRect(7, -4, 3, 3);
    ctx.fillStyle = "#aac4aa"; ctx.fillRect(7, -4, 4, 1); ctx.fillRect(9, -3, 2, 2);
    ctx.restore();
    if (can.pouring && !frame.still) {
      const origin = { x: can.x + can.side * u * (10 * Math.cos(tilt) + 2 * Math.sin(tilt)),
        y: can.y + u * (10 * Math.sin(tilt) - 2 * Math.cos(tilt)) };
      const alpha = ctx.globalAlpha;
      for (let index = 0; index < 10; index++) {
        const p = (frame.elapsed * 1.4 + index / 10) % 1;
        const point = blend(origin, can.target, p);
        point.y -= Math.sin(Math.PI * p) * can.size * .18;
        ctx.globalAlpha = alpha * (.38 + Math.sin(Math.PI * p) * .35);
        ctx.fillStyle = index % 3 ? "#b9dddc" : "#e2efdb";
        ctx.fillRect(point.x + Math.sin(index * 2.4) * p * u * 2, point.y, u * .6, u * (1 + p * .4));
      }
      ctx.globalAlpha = alpha;
    }
  }
  if (frame.pickedBerry) drawBerry(ctx, frame.pickedBerry, frame.pickedBerry.size, 1);
  ctx.restore();
}
