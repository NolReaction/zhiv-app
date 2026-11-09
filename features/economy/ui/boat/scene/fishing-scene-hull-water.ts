import { transformFishingBoatPoint, type FishingBoatTransform } from "./fishing-scene-buoyancy";
import type { FishingScenePoint } from "./fishing-scene-types";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const clock = (time: number, still: boolean) => still || !Number.isFinite(time) ? 0 : Math.max(0, time);
// The new side hull is authored in 1600×640, then placed in the shared 1000×650 rig.
// Its protruding keel, rather than the inner planks, defines the actual wetted silhouette.
const authoredScale = .625, authoredOffsetY = 185;
const sternX = 245, flatStartX = 251, flatEndX = 1220;
// Stop before the lifted bow. Painting foam up to the tip would put water on dry wood.
const bowAmount = .45;
const bowEndX = flatEndX + 270 * bowAmount - 67 * bowAmount ** 2;
const authored = (x: number, y: number) => ({ x: x * authoredScale, y: y * authoredScale + authoredOffsetY });
const sternAmount = (-4 + Math.sqrt(16 + 60 * (sternX - 234))) / 30;
const sternY = 539 + 38 * sternAmount - 17 * sternAmount ** 2;
const bowEndY = 560 - 2 * bowAmount - 77 * bowAmount ** 2;

/** Exact lower keel in assembly space. The rig already carries the shared wave motion;
 * no second local swell is added to wood/water contact. Clock arguments retain the painter contract. */
export function fishingHullContactPoint(amount: number, time?: number, still?: boolean): FishingScenePoint {
  // Existing callers pass presentation clocks; the silhouette itself must remain attached to the hull.
  void time; void still;
  const along = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  const x = sternX + (bowEndX - sternX) * along;
  if (x < flatStartX) {
    const t = (-4 + Math.sqrt(16 + 60 * (x - 234))) / 30;
    return authored(x, 539 + 38 * t - 17 * t * t);
  }
  if (x <= flatEndX) return authored(x, 560);
  const t = (270 - Math.sqrt(270 ** 2 - 268 * (x - flatEndX))) / 134;
  return authored(x, 560 - 2 * t - 77 * t * t);
}

/** Trace the same exact two keel curves and straight bottom used by displacement. */
export function traceFishingHullContact(ctx: CanvasRenderingContext2D, _time: number, offset = 0) {
  const from = authored(sternX, sternY), sternControl = authored(236 + 15 * sternAmount, 558 + 2 * sternAmount);
  const flatStart = authored(flatStartX, 560), flatEnd = authored(flatEndX, 560);
  const bowControl = authored(flatEndX + 135 * bowAmount, 560 - bowAmount), bowEnd = authored(bowEndX, bowEndY);
  ctx.beginPath(); ctx.moveTo(from.x, from.y + offset);
  ctx.quadraticCurveTo(sternControl.x, sternControl.y + offset, flatStart.x, flatStart.y + offset);
  ctx.lineTo(flatEnd.x, flatEnd.y + offset);
  ctx.quadraticCurveTo(bowControl.x, bowControl.y + offset, bowEnd.x, bowEnd.y + offset);
}

/** A translucent wetted lip stays inside the side hull, after its front planks.
 * Only short glints touch the water outside; the motor and background are never tinted. */
export function paintFishingHullImmersion(ctx: CanvasRenderingContext2D, time: number, still = false) {
  const t = clock(time, still), start = .035, samples = 32, depth = 14;
  ctx.save(); ctx.beginPath();
  for (let index = 0; index <= samples; index++) {
    const point = fishingHullContactPoint(start + (1 - start) * index / samples);
    if (index === 0) ctx.moveTo(point.x, point.y - depth);
    else ctx.lineTo(point.x, point.y - depth);
  }
  for (let index = samples; index >= 0; index--) {
    const point = fishingHullContactPoint(start + (1 - start) * index / samples);
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
  const wet = ctx.createLinearGradient(0, 520, 0, 536);
  wet.addColorStop(0, "rgba(22,117,119,0)"); wet.addColorStop(.45, "rgba(22,117,119,.08)");
  wet.addColorStop(1, "rgba(22,117,119,.34)"); ctx.fillStyle = wet; ctx.fill();
  ctx.lineCap = "round"; ctx.lineWidth = 1.5;
  for (const [index, center] of [.075, .84, .945].entries()) {
    const half = index === 1 ? .025 : .018;
    const from = fishingHullContactPoint(center - half), mid = fishingHullContactPoint(center), to = fishingHullContactPoint(center + half);
    ctx.strokeStyle = `rgba(184,230,216,${.12 + (Math.sin(t * .72 + index * 1.9) + 1) * .035})`;
    ctx.beginPath(); ctx.moveTo(from.x, from.y + .6);
    ctx.quadraticCurveTo(mid.x, mid.y + 2.4, to.x, to.y + .6); ctx.stroke();
  }
  ctx.restore();
}

function outsideHull(amount: number, distance: number, time: number, still: boolean) {
  const point = fishingHullContactPoint(amount, time, still);
  const before = fishingHullContactPoint(amount - .002, time, still), after = fishingHullContactPoint(amount + .002, time, still);
  const dx = after.x - before.x, dy = after.y - before.y, length = Math.max(.001, Math.hypot(dx, dy));
  return { x: point.x - dy / length * distance, y: point.y + dx / length * distance };
}

export type FishingHullWaterStroke = { points: FishingScenePoint[]; opacity: number; width: number };

/** Open wavelets leave the actual displaced edge; there is no independent oval or filled hover shadow. */
export function fishingHullWaterFrame(boat: FishingBoatTransform, time: number, still = false) {
  const t = clock(time, still), at = (amount: number, distance: number) =>
    transformFishingBoatPoint(outsideHull(amount, distance, t, still), boat);
  const contact = Array.from({ length: 25 }, (_, index) => at(index / 24, 1.5));
  const ripples: FishingHullWaterStroke[] = [], reflections: FishingHullWaterStroke[] = [];
  for (let index = 0; index < 6; index++) {
    const center = .08 + index * .16;
    const phase = (t * .22 + index * .173) % 1, pulse = Math.sin(Math.PI * phase) ** .8;
    const distance = 2 + phase * 24;
    const span = .038 + phase * .025;
    const points = Array.from({ length: 7 }, (_, sample) => {
      const along = sample / 6, amount = clamp(center + (along - .5) * span * 2, 0, 1);
      return at(amount, distance + Math.sin(along * Math.PI) * (1 + phase * 3));
    });
    ripples.push({ points, opacity: pulse * (.19 + index % 2 * .025), width: 1.4 + boat.scale * 1.1 });
    for (let ribbon = 0; ribbon < 2; ribbon++) {
      const shimmer = Math.sin(t * .82 + index * 1.7 + ribbon) * 1.4;
      const reflectionSpan = .019 + index % 3 * .004;
      reflections.push({ points: [at(center - reflectionSpan, 5 + ribbon * 6 + shimmer),
        at(center, 6 + ribbon * 6 + shimmer), at(center + reflectionSpan, 5 + ribbon * 6 + shimmer)],
      opacity: (.105 + index % 3 * .017) * (ribbon ? .52 : 1), width: (ribbon ? 2.5 : 4) * boat.scale });
    }
  }
  return { contact, ripples, reflections };
}

function strokePoints(ctx: CanvasRenderingContext2D, points: readonly FishingScenePoint[]) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke();
}

/** Paint in scene coordinates before the hull. The supplied transform includes its current bob and roll. */
export function paintFishingBoatDisplacement(ctx: CanvasRenderingContext2D, boat: FishingBoatTransform, time: number, still = false) {
  if (!(boat.scale > 0) || !Number.isFinite(boat.x + boat.y + boat.scale + (boat.roll ?? 0))) return;
  const frame = fishingHullWaterFrame(boat, time, still);
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const reflection of frame.reflections) {
    ctx.strokeStyle = `rgba(132,115,67,${reflection.opacity})`; ctx.lineWidth = Math.max(1, reflection.width);
    strokePoints(ctx, reflection.points);
  }
  ctx.strokeStyle = "rgba(5,61,73,.24)"; ctx.lineWidth = Math.max(2, boat.scale * 5);
  strokePoints(ctx, frame.contact);
  for (const ripple of frame.ripples) {
    ctx.strokeStyle = `rgba(188,231,219,${ripple.opacity})`; ctx.lineWidth = ripple.width;
    strokePoints(ctx, ripple.points);
  }
  ctx.restore();
}
