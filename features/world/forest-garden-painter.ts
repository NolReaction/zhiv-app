import type { PixelDirection, PixelPose, PixelRigOptions } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { FOREST_GARDEN_LIMITS, type ForestGardenState } from "./forest-garden";
import { heroSourceAnchor, type FaunaActor, type HeroAnchorPose } from "./hero-anchors";
import { previewPointInPolygon } from "./tiled/preview-state";

const TAU = Math.PI * 2;
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const blend = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * unit(t), y: a.y + (b.y - a.y) * unit(t) });
type GardenBerry = WorldPoint & { radius: number; growth: number; picked: number; opacity: number };
type BerryLayout = WorldPoint & { radius: number };
const berryLayouts = new WeakMap<readonly WorldPoint[], BerryLayout[]>();
const smooth = (value: number) => { const t = unit(value); return t * t * (3 - 2 * t); };
const mixPoint = (a: WorldPoint, b: WorldPoint, progress: number) => blend(a, b, smooth(progress));
const COLLECT = { lowerEnd: .65, pickStart: .85, cycle: 1, liftStart: 4.15, end: 5 } as const;
type BasketVisual = WorldPoint & { size: number; berries: number; behind: boolean; grounded: boolean };
type GardenArm = { shoulder: WorldPoint; hand: WorldPoint };
export type ForestGardenVisualFrame = {
  pose: PixelPose; direction: PixelDirection; frame: number; rig?: PixelRigOptions;
  basket: BasketVisual | null;
  can: (WorldPoint & { size: number; side: number; target: WorldPoint; pouring: boolean }) | null;
  pickedBerry: (WorldPoint & { size: number }) | null;
  arms: GardenArm[]; actor: FaunaActor;
  elapsed: number; still: boolean;
};

/** One reachable cluster and a few quiet clusters across the authored foliage. */
function berryLayout(plant: { id: string; points: WorldPoint[] }, entry: WorldPoint): BerryLayout[] {
  const cached = berryLayouts.get(plant.points);
  if (cached) return cached;
  if (plant.points.length < 3) return [];
  const xs = plant.points.map(p => p.x), ys = plant.points.map(p => p.y);
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  const radius = Math.min(1.45, Math.min(width, height) * .025);
  const accepted: BerryLayout[] = [];
  const add = (point: WorldPoint) => {
    if (![[0, 0], [-radius * 1.8, 0], [radius * 1.8, 0], [0, -radius * 1.8], [0, radius * 1.8]].every(([dx, dy]) =>
      previewPointInPolygon({ x: point.x + dx, y: point.y + dy }, plant.points))) return;
    if (accepted.some(other => Math.hypot(other.x - point.x, other.y - point.y) < radius * 7)) return;
    accepted.push({ ...point, radius });
  };
  const edge = plant.points.reduce((nearest, point) => Math.hypot(point.x - entry.x, point.y - entry.y)
    < Math.hypot(nearest.x - entry.x, nearest.y - entry.y) ? point : nearest);
  const middle = { x: left + width / 2, y: top + height / 2 };
  // Put the worked cluster beyond the near ear/cheek silhouette. A berry directly
  // above the jump entry can be geometrically reachable yet look like it came from the belly.
  add({ x: edge.x + (entry.x < middle.x ? 1 : -1) * width * .26, y: edge.y - height * .08 });
  if (!accepted.length) for (const inset of [.13, .2, .28]) { add(blend(edge, middle, inset)); if (accepted.length) break; }
  let seed = [...plant.id].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0) | 0, 13) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let attempt = 0; attempt < 90 && accepted.length < 7; attempt++) {
    add({ x: left + width * (.16 + random() * .68), y: top + height * (.19 + random() * .62) });
  }
  berryLayouts.set(plant.points, accepted);
  return accepted;
}

function harvestProgress(garden: ForestGardenState) {
  const routine = garden.routine, count = FOREST_GARDEN_LIMITS.harvest;
  if (!routine || routine.kind !== "harvest-berries") return { picked: 0, putAway: 0, fade: 0 };
  if (routine.phase === "return-basket" || routine.phase === "deposit") return { picked: count, putAway: count, fade: 1 };
  if (routine.phase !== "collect") return { picked: 0, putAway: 0, fade: 0 };
  const time = Math.max(0, routine.elapsed - COLLECT.pickStart), index = Math.min(count, Math.floor(time / COLLECT.cycle));
  const phase = time / COLLECT.cycle - index;
  return { picked: Math.min(count, index + Number(phase >= .3)), putAway: Math.min(count, index + Number(phase >= .8)),
    fade: smooth((routine.elapsed - 3.85) / .3) };
}

/** Fruit grows continuously from small green buds; no decorative flower stage. */
export function forestGardenBerries(scene: FixedWorldScene, garden: ForestGardenState | undefined): GardenBerry[] {
  if (!garden) return [];
  const result: GardenBerry[] = [], harvest = harvestProgress(garden);
  for (const plant of garden.bushes) {
    const bush = scene.bushes?.find(item => item.id === plant.id), growth = unit(plant.growth);
    if (!bush || growth <= .01) continue;
    const selected = garden.routine?.bushId === plant.id;
    berryLayout(bush, bush.entry).forEach((berry, index) => result.push({ ...berry, growth,
      picked: selected && index === 0 ? harvest.picked : 0,
      opacity: smooth(growth / .12) * (selected && index !== 0 ? 1 - harvest.fade : 1) }));
  }
  return result;
}

function colorBetween(from: string, to: string, progress: number) {
  const t = unit(progress), channels = [1, 3, 5].map(index => Math.round(parseInt(from.slice(index, index + 2), 16)
    * (1 - t) + parseInt(to.slice(index, index + 2), 16) * t));
  return `rgb(${channels.join(",")})`;
}
function drawBerry(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number, growth: number) {
  const ripe = smooth((growth - .56) / .42);
  // Colored shade and a small uneven highlight replace the dark button outline.
  ctx.fillStyle = colorBetween("#526932", "#935025", ripe);
  ctx.beginPath(); ctx.ellipse(point.x, point.y, radius, radius * 1.08, -.16, 0, TAU); ctx.fill();
  ctx.fillStyle = colorBetween("#8aa646", "#cd7d35", ripe);
  ctx.beginPath(); ctx.ellipse(point.x - radius * .12, point.y - radius * .13, radius * .82, radius * .85, -.16, 0, TAU); ctx.fill();
  ctx.fillStyle = colorBetween("#adc262", "#e7ab58", ripe);
  ctx.beginPath(); ctx.ellipse(point.x - radius * .32, point.y - radius * .35, radius * .3, radius * .2, -.6, 0, TAU); ctx.fill();
  ctx.fillStyle = colorBetween("#789143", "#b5672b", ripe);
  ctx.beginPath(); ctx.ellipse(point.x + radius * .32, point.y + radius * .28, radius * .12, radius * .11, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#677f39";
  ctx.beginPath(); ctx.moveTo(point.x - radius * .36, point.y - radius * .85);
  ctx.lineTo(point.x, point.y - radius * .64); ctx.lineTo(point.x + radius * .34, point.y - radius * .91);
  ctx.lineTo(point.x, point.y - radius * 1.12); ctx.closePath(); ctx.fill();
}
function clusterFruit(cluster: BerryLayout, index: number) {
  const offsets = [[-.48, -.08], [.48, .06], [0, .75]];
  const [dx, dy] = offsets[index];
  return { x: cluster.x + dx * cluster.radius, y: cluster.y + dy * cluster.radius, size: cluster.radius * .58 };
}

export function drawForestGardenPlants(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, garden: ForestGardenState | undefined) {
  const berries = forestGardenBerries(scene, garden);
  if (!berries.length) return;
  ctx.save(); const alpha = ctx.globalAlpha;
  for (const berry of berries) {
    if (berry.opacity <= 0 || berry.picked >= 3) continue;
    const scale = .22 + Math.sqrt(berry.growth) * .78, r = berry.radius * scale;
    ctx.globalAlpha = alpha * berry.opacity;
    ctx.strokeStyle = "#667a36"; ctx.lineWidth = r * .23; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(berry.x - r * .12, berry.y - r * 1.15);
    ctx.quadraticCurveTo(berry.x + r * .1, berry.y - r * .58, berry.x, berry.y + r * .6); ctx.stroke();
    for (let index = berry.picked; index < 3; index++) {
      const fruit = clusterFruit({ ...berry, radius: r }, index);
      drawBerry(ctx, fruit, fruit.size, berry.growth);
    }
  }
  ctx.restore();
}

/** Stationary body, continuous arms, and identical basket endpoints at phase boundaries. */
export function forestGardenVisualFrame(garden: ForestGardenState | undefined, actor: FaunaActor,
  motion: HeroAnchorPose, still = false): ForestGardenVisualFrame | null {
  const routine = garden?.routine;
  if (!garden || !routine) return null;
  const t = Number.isFinite(routine.elapsed) ? Math.max(0, routine.elapsed) : 0;
  const stationary = ["take-basket", "water", "collect", "deposit"].includes(routine.phase);
  const carries = routine.carryingBasket || routine.phase === "take-basket" || routine.phase === "deposit";
  const plant = garden.bushes.find(item => item.id === routine.bushId);
  const crownX = plant?.points.length ? plant.points.reduce((sum, point) => sum + point.x, 0) / plant.points.length : actor.x;
  const side = crownX < actor.x ? -1 : 1;
  const pose: PixelPose = stationary ? "idle" : carries ? "carry" : motion.pose;
  const frame = stationary ? 0 : motion.frame;
  const direction = stationary ? side < 0 ? "left" : "right" : motion.direction;
  const anchorPose = { pose, frame, direction }, rig = stationary || carries ? { gardening: true } : undefined;
  const anchor = (x: number, y: number) => heroSourceAnchor(actor, { x, y }, anchorPose);
  const walkingBob = pose === "carry" && frame % 2 ? -1 : 0;
  const shoulders = [anchor(14, 31 + walkingBob), anchor(34, 31 + walkingBob)];
  const rests = [anchor(14, 34), anchor(34, 34)];
  let hands = [...rests];
  const held = { x: actor.x, y: actor.y - actor.size * .19 };
  const ground = { x: actor.x - side * actor.size * .36, y: actor.y + actor.size * .035 };
  const grip = (position: WorldPoint) => [
    { x: position.x - actor.size * .085, y: position.y - actor.size * .165 },
    { x: position.x + actor.size * .085, y: position.y - actor.size * .165 },
  ];
  let basket: BasketVisual | null = null, pickedBerry: ForestGardenVisualFrame["pickedBerry"] = null;
  if (garden.basket && carries) {
    let position = held, grounded = false;
    if (routine.phase === "take-basket") { position = mixPoint(garden.basket.position, held, t); grounded = t <= 0; }
    else if (routine.phase === "deposit") { position = mixPoint(held, garden.basket.homePosition, t / 1.5); grounded = t >= 1.5; }
    else if (routine.phase === "collect") {
      position = t < COLLECT.lowerEnd ? mixPoint(held, ground, t / COLLECT.lowerEnd)
        : t > COLLECT.liftStart ? mixPoint(ground, held, (t - COLLECT.liftStart) / (COLLECT.end - COLLECT.liftStart)) : ground;
      grounded = t >= COLLECT.lowerEnd && t <= COLLECT.liftStart;
    }
    basket = { ...position, size: actor.size * .32, berries: Math.min(garden.basket.capacity,
      garden.basket.berries + harvestProgress(garden).putAway), behind: direction === "back", grounded };
    hands = grip(position);
    if (routine.phase === "collect" && t >= COLLECT.lowerEnd && t <= COLLECT.liftStart) {
      const groundGrip = grip(ground), endPick = COLLECT.pickStart + COLLECT.cycle * FOREST_GARDEN_LIMITS.harvest;
      if (t < COLLECT.pickStart) hands = groundGrip.map((hand, index) => mixPoint(hand, rests[index], (t - COLLECT.lowerEnd) / (COLLECT.pickStart - COLLECT.lowerEnd)));
      else if (t >= endPick) hands = rests.map((hand, index) => mixPoint(hand, groundGrip[index], (t - endPick) / (COLLECT.liftStart - endPick)));
      else {
        const elapsed = (t - COLLECT.pickStart) / COLLECT.cycle, index = Math.min(2, Math.floor(elapsed)), phase = elapsed - index;
        const cluster = plant ? berryLayout(plant, plant.position)[0] : undefined;
        const fruit = cluster ? clusterFruit(cluster, index) : { ...rests[side < 0 ? 0 : 1], size: actor.size * .016 };
        const reaching = side < 0 ? 0 : 1, lowering = 1 - reaching;
        const center = { x: actor.x, y: actor.y - actor.size * .27 };
        const rim = { x: ground.x, y: ground.y - actor.size * .19 };
        hands = [...rests];
        hands[reaching] = phase < .25 ? mixPoint(rests[reaching], fruit, phase / .25) : phase < .35 ? fruit
          : phase < .6 ? mixPoint(fruit, center, (phase - .35) / .25) : mixPoint(center, rests[reaching], (phase - .6) / .2);
        hands[lowering] = phase < .35 ? rests[lowering] : phase < .6 ? mixPoint(rests[lowering], center, (phase - .35) / .25)
          : phase < .8 ? mixPoint(center, rim, (phase - .6) / .2) : mixPoint(rim, rests[lowering], (phase - .8) / .2);
        if (phase >= .3 && phase < .8) pickedBerry = { ...hands[phase < .6 ? reaching : lowering], size: fruit.size };
      }
    }
  }
  let can: ForestGardenVisualFrame["can"] = null;
  if (routine.kind === "water-bush" && routine.phase === "water") {
    const nearest = plant?.points.reduce<WorldPoint | null>((best, point) => !best
      || Math.hypot(point.x - actor.x, point.y - actor.y) < Math.hypot(best.x - actor.x, best.y - actor.y) ? point : best, null);
    const hand = anchor(24, 29);
    if (nearest) can = { ...hand, size: actor.size * .3, side, target: nearest, pouring: t > .5 && t < 3.6 };
    hands = [{ x: hand.x - actor.size * .07, y: hand.y + actor.size * .04 },
      { x: hand.x + actor.size * .07, y: hand.y + actor.size * .04 }];
  }
  return { pose, frame, direction, rig, basket, can, pickedBerry,
    arms: rig ? shoulders.map((shoulder, index) => ({ shoulder, hand: hands[index] })) : [], actor, elapsed: t, still };
}

function drawGardenArms(ctx: CanvasRenderingContext2D, frame: ForestGardenVisualFrame) {
  const u = frame.actor.size / 48;
  const pixel = (point: WorldPoint) => ({ x: frame.actor.x + Math.round((point.x - frame.actor.x) / u) * u,
    y: frame.actor.y + Math.round((point.y - frame.actor.y) / u) * u });
  for (const arm of frame.arms) {
    const steps = Math.max(1, Math.ceil(Math.hypot(arm.hand.x - arm.shoulder.x, arm.hand.y - arm.shoulder.y) / u));
    for (const [color, width] of [["#d8bf83", 4], ["#f4e4ae", 2.5]] as const) {
      ctx.fillStyle = color;
      for (let step = 0; step <= steps; step++) {
        const point = pixel(blend(arm.shoulder, arm.hand, step / steps));
        ctx.fillRect(point.x - width * u / 2, point.y - width * u / 2, width * u, width * u);
      }
    }
    const point = pixel(arm.hand);
    ctx.fillStyle = "#d8bf83"; ctx.fillRect(point.x - 2.5 * u, point.y - 2 * u, 5 * u, 4 * u);
    ctx.fillStyle = "#f4e4ae"; ctx.fillRect(point.x - 1.5 * u, point.y - 2 * u, 3 * u, 3 * u);
  }
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
  ctx.fillRect(-5, -12, 10, 2); ctx.fillRect(-7, -10, 2, 5); ctx.fillRect(5, -10, 2, 5);
  ctx.fillStyle = "#c69a57"; ctx.fillRect(-4, -12, 8, 1); ctx.fillRect(-6, -10, 1, 4);
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
  size: number, frame: ForestGardenVisualFrame | null, actor?: WorldPoint, layer: "behind" | "front" = "behind") {
  if (!garden?.basket) return;
  // An active basket is drawn with its hands in the actor foreground, never hidden behind its body.
  if (frame?.basket) return;
  if (garden.routine?.carryingBasket) return;
  const nearFeet = actor && Math.hypot(garden.basket.position.x - actor.x, garden.basket.position.y - actor.y) < size * .43
    && garden.basket.position.y >= actor.y - size * .2;
  if (Boolean(nearFeet) !== (layer === "front")) return;
  drawBasket(ctx, { ...garden.basket.position, size: size * .32, berries: garden.basket.berries, behind: false, grounded: true });
}

export function drawForestGardenProps(ctx: CanvasRenderingContext2D, frame: ForestGardenVisualFrame | null, layer: "behind" | "front") {
  if (!frame) return;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  const behind = frame.direction === "back";
  if (behind === (layer === "behind")) drawGardenArms(ctx, frame);
  if (frame.basket && frame.basket.behind === (layer === "behind")) drawBasket(ctx, frame.basket);
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
