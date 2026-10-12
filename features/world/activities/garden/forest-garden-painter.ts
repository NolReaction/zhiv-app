import type { PixelDirection, PixelPose, PixelRigOptions } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { FOREST_GARDEN_LIMITS, type ForestGardenState } from "./forest-garden";
import { heroSourceAnchor, type FaunaActor, type HeroAnchorPose } from "@/features/world/scene/hero-anchors";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { forestFruitVisual } from "./forest-fruit-appearance";
import { forestBushSoilGeometry } from "./forest-bush-soil";
import { forestGardenBerryLayout, type BerryLayout } from "./forest-garden-layout";

const TAU = Math.PI * 2;
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const blend = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * unit(t), y: a.y + (b.y - a.y) * unit(t) });
type GardenBerry = WorldPoint & { radius: number; growth: number; picked: number; opacity: number;
  clusterIndex: number; foliage: readonly WorldPoint[] };
const smooth = (value: number) => { const t = unit(value); return t * t * (3 - 2 * t); };
const mixPoint = (a: WorldPoint, b: WorldPoint, progress: number) => blend(a, b, smooth(progress));
const COLLECT = { lowerEnd: .65, pickStart: .85, cycle: 1, liftStart: 4.15, end: 5 } as const;
type BasketVisual = WorldPoint & { size: number; berries: number; behind: boolean; grounded: boolean };
type GardenArm = { shoulder: WorldPoint; elbow: WorldPoint; hand: WorldPoint };
export type ForestGardenVisualFrame = {
  pose: PixelPose; direction: PixelDirection; frame: number; rig?: PixelRigOptions;
  basket: BasketVisual | null;
  can: (WorldPoint & { size: number; side: number; tilt: number; spout: WorldPoint; target: WorldPoint; pouring: boolean }) | null;
  pickedBerry: (WorldPoint & { size: number }) | null;
  arms: GardenArm[]; actor: FaunaActor;
  elapsed: number; still: boolean;
};


function harvestProgress(garden: ForestGardenState) {
  const routine = garden.routine, count = FOREST_GARDEN_LIMITS.harvest;
  if (garden.harvest?.phase === "completed") return { picked: count, putAway: 0, fade: 1 };
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
    if (!bush || !forestBushArtworkAvailable(scene, bush) || growth <= .01) continue;
    const selected = garden.routine?.bushId === plant.id || garden.harvest?.phase === "completed";
    forestGardenBerryLayout(bush, bush.entry).forEach((berry, index) => result.push({ ...berry, growth, clusterIndex: index, foliage: bush.points,
      picked: selected && index === 0 ? harvest.picked : 0,
      opacity: selected && index !== 0 ? 1 - harvest.fade : 1 }));
  }
  return result;
}

function drawBerry(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number, growth: number, clusterIndex = 0, fruitIndex = 0) {
  const visual = forestFruitVisual(growth, clusterIndex, fruitIndex), { palette } = visual;
  radius *= visual.size;
  if (visual.opacity <= 0) return;
  ctx.save(); ctx.globalAlpha *= visual.opacity;
  // Uneven warm facets keep a tiny fruit readable without a black outline or white shine.
  ctx.fillStyle = palette.shade;
  ctx.beginPath(); ctx.ellipse(point.x, point.y, radius, radius * 1.08, -.16, 0, TAU); ctx.fill();
  ctx.fillStyle = palette.body;
  ctx.beginPath(); ctx.ellipse(point.x - radius * .12, point.y - radius * .13, radius * .82, radius * .85, -.16, 0, TAU); ctx.fill();
  ctx.fillStyle = palette.light;
  ctx.beginPath(); ctx.ellipse(point.x - radius * .32, point.y - radius * .35, radius * .3, radius * .2, -.6, 0, TAU); ctx.fill();
  ctx.fillStyle = palette.detail;
  ctx.beginPath(); ctx.ellipse(point.x + radius * .32, point.y + radius * .28, radius * .12, radius * .11, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(point.x - radius * .25, point.y + radius * .5, radius * .09, radius * .08, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = palette.stem;
  ctx.beginPath(); ctx.moveTo(point.x - radius * .36, point.y - radius * .85);
  ctx.lineTo(point.x, point.y - radius * .64); ctx.lineTo(point.x + radius * .34, point.y - radius * .91);
  ctx.lineTo(point.x, point.y - radius * 1.12); ctx.closePath(); ctx.fill();
  ctx.restore();
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
    ctx.save();
    // Concave authored contours can have leaf gaps: even stems and cast shadows stay inside.
    ctx.beginPath(); berry.foliage.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath(); ctx.clip();
    for (let index = berry.picked; index < 3; index++) {
      const fruit = clusterFruit(berry, index), visual = forestFruitVisual(berry.growth, berry.clusterIndex, index);
      if (visual.opacity <= 0) continue;
      const r = fruit.size * visual.size;
      ctx.globalAlpha = alpha * berry.opacity * visual.opacity * .2;
      ctx.fillStyle = "#263c1c";
      ctx.beginPath(); ctx.ellipse(fruit.x + r * .4, fruit.y + r * .45, r * 1.15, r * .78, -.2, 0, TAU); ctx.fill();
      ctx.globalAlpha = alpha * berry.opacity * visual.opacity;
      ctx.strokeStyle = visual.palette.stem; ctx.lineWidth = berry.radius * .14; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(berry.x - berry.radius * .1, berry.y - berry.radius * 1.08);
      ctx.quadraticCurveTo(fruit.x - r * .24, fruit.y - r * 1.6, fruit.x, fruit.y - r * .86); ctx.stroke();
      ctx.globalAlpha = alpha * berry.opacity;
      drawBerry(ctx, fruit, fruit.size, berry.growth, berry.clusterIndex, index);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** A two-link paw stays bent; the wrist is the actual prop contact point. */
function gardenArm(shoulder: WorldPoint, hand: WorldPoint, side: number, size: number): GardenArm {
  const dx = hand.x - shoulder.x, dy = hand.y - shoulder.y, distance = Math.hypot(dx, dy);
  const bend = Math.min(size * .065, Math.max(size * .02, (size * .29 - distance) * .45));
  return { shoulder, hand, elbow: { x: shoulder.x + dx * .48 + side * bend * .35,
    y: shoulder.y + dy * .48 + bend } };
}
function canPoint(can: { x: number; y: number; side: number; size: number; tilt: number }, x: number, y: number) {
  const u = can.size / 14, cosine = Math.cos(can.tilt), sine = Math.sin(can.tilt);
  return { x: can.x + can.side * u * (x * cosine - y * sine), y: can.y + u * (x * sine + y * cosine) };
}

/** Stable feet, short articulated paws, and identical prop endpoints at phase boundaries. */
export function forestGardenVisualFrame(garden: ForestGardenState | undefined, actor: FaunaActor,
  motion: HeroAnchorPose, still = false): ForestGardenVisualFrame | null {
  const routine = garden?.routine ?? (garden?.basket?.held ? { kind: "harvest-berries" as const,
    bushId: "", phase: "approach-bush" as const, elapsed: 0, carryingBasket: true } : null);
  if (!garden || !routine) return null;
  const t = Number.isFinite(routine.elapsed) ? Math.max(0, routine.elapsed) : 0;
  const stationary = ["take-basket", "water", "collect", "deposit"].includes(routine.phase);
  const carries = routine.carryingBasket || routine.phase === "take-basket" || routine.phase === "deposit";
  const plant = garden.bushes.find(item => item.id === routine.bushId);
  const crownX = plant?.points.length ? plant.points.reduce((sum, point) => sum + point.x, 0) / plant.points.length : actor.x;
  const side = crownX < actor.x ? -1 : 1;
  const pose: PixelPose = stationary ? "idle" : carries ? "carry" : motion.pose;
  const frame = stationary ? 0 : motion.frame;
  const basketPoint = routine.phase === "deposit" ? garden.basket?.homePosition : garden.basket?.position;
  const direction = routine.phase === "take-basket" || routine.phase === "deposit" ? basketPoint && basketPoint.x < actor.x ? "left" : "right"
    : stationary ? side < 0 ? "left" : "right" : motion.direction;
  const crouch = routine.phase === "take-basket" ? Math.round(2 * smooth(t / .24) * (1 - smooth((t - .3) / .5)))
    : routine.phase === "deposit" ? Math.round(2 * smooth(t / .8) * (1 - smooth((t - 1.2) / .3))) : 0;
  const anchorPose = { pose, frame, direction }, rig = stationary || carries ? { gardening: true, crouch } : undefined;
  const anchor = (x: number, y: number) => heroSourceAnchor(actor, { x, y }, anchorPose);
  const walkingBob = pose === "carry" && frame % 2 ? -1 : 0;
  const shoulders = [anchor(14, 31 + walkingBob + crouch), anchor(34, 31 + walkingBob + crouch)];
  const rests = [anchor(14, 35 + walkingBob + crouch), anchor(34, 35 + walkingBob + crouch)];
  let hands = [...rests];
  // Lower than the face: the basket rests against the belly, with paws over the handle.
  const held = { x: actor.x, y: actor.y - actor.size * .15 };
  const ground = { x: actor.x - side * actor.size * .31, y: actor.y + actor.size * .035 };
  const basketSize = garden.basket?.size ?? actor.size * .28;
  const grip = (position: WorldPoint) => [
    { x: position.x - basketSize * .23, y: position.y - basketSize * 12 / 14 },
    { x: position.x + basketSize * .23, y: position.y - basketSize * 12 / 14 },
  ].map((hand, index) => {
    const offset = position.x - actor.x, near = offset < 0 ? 0 : 1;
    // The near paw grips the near end of a side handle, then both paws spread
    // onto their ordinary grip as the basket reaches the belly.
    if (index !== near) return hand;
    return { ...hand, x: hand.x - Math.sign(offset) * basketSize * .46 * smooth((Math.abs(offset) / actor.size - .08) / .2) };
  });
  // A side basket is supported by the near paw. The other joins only once the
  // handle comes within reach, instead of spanning the full width of the body.
  const basketHands = (position: WorldPoint) => grip(position).map((hand, index) => {
    const distance = Math.hypot(hand.x - shoulders[index].x, hand.y - shoulders[index].y);
    return mixPoint(rests[index], hand, 1 - unit((distance / actor.size - .21) / .045));
  });
  let basket: BasketVisual | null = null, pickedBerry: ForestGardenVisualFrame["pickedBerry"] = null;
  if (garden.basket && carries) {
    let position = held, grounded = false;
    if (routine.phase === "take-basket") {
      position = mixPoint(garden.basket.position, held, (t - .24) / .76); grounded = t <= .24;
    } else if (routine.phase === "deposit") {
      position = mixPoint(held, garden.basket.homePosition, t / 1.2); grounded = t >= 1.2;
    } else if (routine.phase === "collect") {
      position = t < COLLECT.lowerEnd ? mixPoint(held, ground, t / COLLECT.lowerEnd)
        : t > COLLECT.liftStart ? mixPoint(ground, held, (t - COLLECT.liftStart) / (COLLECT.end - COLLECT.liftStart)) : ground;
      grounded = t >= COLLECT.lowerEnd && t <= COLLECT.liftStart;
    }
    basket = { ...position, size: basketSize, berries: Math.min(garden.basket.capacity,
      (garden.production === undefined ? garden.basket.berries : 0) + harvestProgress(garden).putAway), behind: grounded ? position.y < actor.y : direction === "back", grounded };
    hands = basketHands(position);
    if (routine.phase === "take-basket" && t < .24) hands = rests.map((rest, index) => mixPoint(rest, hands[index], t / .24));
    if (routine.phase === "deposit" && t > 1.2) hands = hands.map((hand, index) => mixPoint(hand, rests[index], (t - 1.2) / .3));
    if (routine.phase === "collect" && t >= COLLECT.lowerEnd && t <= COLLECT.liftStart) {
      const groundGrip = basketHands(ground), endPick = COLLECT.pickStart + COLLECT.cycle * FOREST_GARDEN_LIMITS.harvest;
      if (t < COLLECT.pickStart) hands = groundGrip.map((hand, index) => mixPoint(hand, rests[index], (t - COLLECT.lowerEnd) / (COLLECT.pickStart - COLLECT.lowerEnd)));
      else if (t >= endPick) hands = rests.map((hand, index) => mixPoint(hand, groundGrip[index], (t - endPick) / (COLLECT.liftStart - endPick)));
      else {
        const elapsed = (t - COLLECT.pickStart) / COLLECT.cycle, index = Math.min(2, Math.floor(elapsed)), phase = elapsed - index;
        const cluster = plant ? forestGardenBerryLayout(plant, plant.position)[0] : undefined;
        const fruit = cluster ? clusterFruit(cluster, index) : { ...rests[side < 0 ? 0 : 1], size: actor.size * .016 };
        const reaching = side < 0 ? 0 : 1, lowering = 1 - reaching;
        const center = { x: actor.x, y: actor.y - actor.size * .24 };
        const rim = { x: ground.x, y: ground.y - basketSize * 8 / 14 };
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
    const soil = plant && forestBushSoilGeometry(plant.points, plant.position);
    const lift = smooth(t / .45), lower = smooth((t - 3.6) / .4);
    const tilted = smooth((t - .45) / .35) * (1 - smooth((t - 3.35) / .25));
    if (soil) {
      const position = { x: actor.x + side * actor.size * .035, y: actor.y - actor.size * (.29 + .025 * lift * (1 - lower)),
        size: actor.size * .27, side, tilt: .48 * tilted };
      can = { ...position, spout: canPoint(position, 10, -2), target: soil.wateringPoint, pouring: t >= .8 && t < 3.35 };
      const reaching = side < 0 ? 0 : 1;
      hands[reaching] = canPoint(can, 1, 5);
      hands[1 - reaching] = canPoint(can, -7, -3);
    }
  }
  return { pose, frame, direction, rig, basket, can, pickedBerry,
    arms: rig ? shoulders.map((shoulder, index) => gardenArm(shoulder, hands[index], index ? 1 : -1, actor.size)) : [],
    actor, elapsed: t, still };
}

function drawGardenArms(ctx: CanvasRenderingContext2D, frame: ForestGardenVisualFrame, paws = false) {
  const u = frame.actor.size / 48;
  const pixel = (point: WorldPoint) => ({ x: frame.actor.x + Math.round((point.x - frame.actor.x) / u) * u,
    y: frame.actor.y + Math.round((point.y - frame.actor.y) / u) * u });
  for (const arm of frame.arms) {
    if (!paws) for (const [color, width] of [["#d8bf83", 4], ["#f4e4ae", 2.5]] as const) {
      ctx.fillStyle = color;
      for (const [a, b] of [[arm.shoulder, arm.elbow], [arm.elbow, arm.hand]]) {
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / u));
        for (let step = 0; step <= steps; step++) {
          const point = pixel(blend(a, b, step / steps));
          ctx.fillRect(point.x - width * u / 2, point.y - width * u / 2, width * u, width * u);
        }
      }
    }
    if (paws) {
      const point = pixel(arm.hand);
      ctx.fillStyle = "#d8bf83"; ctx.fillRect(point.x - 2.5 * u, point.y - 2 * u, 5 * u, 4 * u);
      ctx.fillStyle = "#f4e4ae"; ctx.fillRect(point.x - 1.5 * u, point.y - 2 * u, 3 * u, 3 * u);
    }
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
  // Active props own their two draw passes; a parked basket uses its real sole.
  if (frame?.basket) return;
  if (garden.routine?.carryingBasket || garden.basket.held) return;
  const inFront = actor && garden.basket.position.y >= actor.y;
  if (Boolean(inFront) !== (layer === "front")) return;
  drawBasket(ctx, { ...garden.basket.position, size: garden.basket.size ?? size * .28,
    berries: garden.production === undefined ? garden.basket.berries : 0, behind: false, grounded: true });
}

export function drawForestGardenProps(ctx: CanvasRenderingContext2D, frame: ForestGardenVisualFrame | null, layer: "behind" | "front") {
  if (!frame) return;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  const behind = frame.direction === "back";
  if (behind === (layer === "behind")) drawGardenArms(ctx, frame);
  if (frame.basket && frame.basket.behind === (layer === "behind")) drawBasket(ctx, frame.basket);
  if (layer === "behind") { if (behind) drawGardenArms(ctx, frame, true); ctx.restore(); return; }
  if (frame.can) {
    const can = frame.can, u = can.size / 14;
    const tilt = can.tilt;
    ctx.save(); ctx.translate(can.x, can.y); ctx.scale(can.side * u, u); ctx.rotate(tilt);
    ctx.fillStyle = "#334b43"; ctx.fillRect(-6, -2, 10, 9); ctx.fillRect(-5, 7, 8, 1);
    ctx.fillRect(-8, -6, 7, 2); ctx.fillRect(-9, -4, 2, 7); ctx.fillRect(-7, 2, 2, 2);
    ctx.fillStyle = "#6f9380"; ctx.fillRect(-5, -1, 8, 7); ctx.fillRect(-7, -5, 5, 1);
    ctx.fillStyle = "#94b49a"; ctx.fillRect(-5, -1, 7, 2); ctx.fillRect(-5, 1, 1, 4);
    ctx.fillStyle = "#486657"; ctx.fillRect(3, 0, 3, 3); ctx.fillRect(5, -2, 3, 3); ctx.fillRect(7, -4, 3, 3);
    ctx.fillStyle = "#aac4aa"; ctx.fillRect(7, -4, 4, 1); ctx.fillRect(9, -3, 2, 2);
    ctx.restore();
    if (can.pouring && !frame.still) {
      const origin = can.spout;
      const alpha = ctx.globalAlpha;
      for (let index = 0; index < 10; index++) {
        const p = (frame.elapsed * 1.4 + index / 10) % 1;
        // Gravity accelerates the drop; water never arcs up into the crown.
        const point = { x: origin.x + (can.target.x - origin.x) * p,
          y: origin.y + (can.target.y - origin.y) * p * p };
        ctx.globalAlpha = alpha * (.38 + Math.sin(Math.PI * p) * .35);
        ctx.fillStyle = index % 3 ? "#b9dddc" : "#e2efdb";
        ctx.fillRect(point.x + Math.sin(index * 2.4) * p * u * 2, point.y, u * .6, u * (1 + p * .4));
      }
      ctx.globalAlpha = alpha;
    }
  }
  if (!behind) drawGardenArms(ctx, frame, true);
  if (frame.pickedBerry) drawBerry(ctx, frame.pickedBerry, frame.pickedBerry.size, 1);
  ctx.restore();
}
