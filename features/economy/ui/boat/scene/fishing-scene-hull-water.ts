import { transformFishingBoatPoint, type FishingBoatTransform } from "./fishing-scene-buoyancy";
import type { FishingScenePoint } from "./fishing-scene-types";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const clock = (time: number, still: boolean) => still || !Number.isFinite(time) ? 0 : Math.max(0, time);
const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
// Lower silhouette sampled from the existing hull's crop/box, not the earlier line inside the wooden side.
const edge = [[124, 564], [180, 566], [250, 563], [350, 558], [450, 550], [550, 541],
  [650, 529], [750, 510], [834, 466], [880, 418], [920, 363], [946, 322]] as const;

/** Both the wet lip and displacement share one authored hull edge in 1000×650 assembly space. */
export function fishingHullWaterSwell(time: number, still = false) {
  const t = clock(time, still);
  return Math.sin(t * 1.05) * 1.15 + Math.sin(t * .57 + .7) * .35;
}

function contactSegment(index: number, time: number, still: boolean, offset = 0) {
  const previous = edge[Math.max(0, index - 1)], start = edge[index], end = edge[index + 1], next = edge[Math.min(edge.length - 1, index + 2)];
  const swell = fishingHullWaterSwell(time, still) + offset;
  return { start: { x: start[0], y: start[1] + swell }, end: { x: end[0], y: end[1] + swell },
    control1: { x: start[0] + (end[0] - previous[0]) / 6, y: start[1] + (end[1] - previous[1]) / 6 + swell },
    control2: { x: end[0] - (next[0] - start[0]) / 6, y: end[1] - (next[1] - start[1]) / 6 + swell } };
}

export function fishingHullContactPoint(amount: number, time: number, still = false): FishingScenePoint {
  const position = clamp(Number.isFinite(amount) ? amount : 0, 0, 1) * (edge.length - 1);
  const index = Math.min(edge.length - 2, Math.floor(position)), t = position - index;
  const { start, control1, control2, end } = contactSegment(index, time, still);
  return { x: cubic(start.x, control1.x, control2.x, end.x, t), y: cubic(start.y, control1.y, control2.y, end.y, t) };
}

/** Local-space tracing uses the same continuous silhouette as world-space displacement. */
export function traceFishingHullContact(ctx: CanvasRenderingContext2D, time: number, offset = 0) {
  ctx.beginPath();
  for (let index = 0; index < edge.length - 1; index++) {
    const { start, control1, control2, end } = contactSegment(index, time, false, offset);
    if (index === 0) ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(control1.x, control1.y, control2.x, control2.y, end.x, end.y);
  }
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
