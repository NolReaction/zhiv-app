import { fishingWaterWave, transformFishingBoatPoint, FISHING_BOAT_PIVOT, type FishingBoatTransform } from "./fishing-scene-buoyancy";
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

/** Presentation draft only; gameplay still uses the same server-owned fishing rig. */
export const FISHING_BOAT_DRAFT = 18;
export type FishingHullWaterStroke = { points: FishingScenePoint[]; opacity: number; width: number };
export type FishingHullWaterSample = { local: FishingScenePoint; point: FishingScenePoint; depth: number };

/** Solve a world-space water plane against the rolling hull, rather than attaching water to wood.
 * Two iterations account for X moving a little when the hull rolls. */
export function fishingBoatWaterSample(boat: FishingBoatTransform, localX: number, time: number, still = false,
  surface = boat.y + (FISHING_BOAT_PIVOT.y - FISHING_BOAT_DRAFT) * boat.scale): FishingHullWaterSample {
  const t = clock(time, still), roll = boat.roll ?? 0, cosine = Math.cos(roll), sine = Math.sin(roll);
  let localY = FISHING_BOAT_PIVOT.y - FISHING_BOAT_DRAFT;
  for (let iteration = 0; iteration < 2; iteration++) {
    const world = transformFishingBoatPoint({ x: localX, y: localY }, boat);
    const waterY = surface + fishingWaterWave(world.x, t, still).height;
    localY = FISHING_BOAT_PIVOT.y + ((waterY - boat.y) / boat.scale - FISHING_BOAT_PIVOT.y - (localX - FISHING_BOAT_PIVOT.x) * sine) / cosine;
  }
  const local = { x: localX, y: localY }, point = transformFishingBoatPoint(local, boat);
  const nativeX = localX / authoredScale;
  const curve = nativeX <= flatEndX ? 0 : clamp((270 - Math.sqrt(Math.max(0, 270 ** 2 - 268 * (nativeX - flatEndX)))) / 134, 0, 1);
  const keelY = nativeX < flatStartX ? fishingHullContactPoint(0).y : 185 + (560 - 2 * curve - 77 * curve * curve) * authoredScale;
  return { local, point, depth: keelY - localY };
}

/** Open wavelets live on the sampled surface. A moving hull changes wetness and pressure,
 * but cannot drag a detached ring or reflection down with its bob. */
export function fishingHullWaterFrame(boat: FishingBoatTransform, time: number, still = false,
  surface?: number, activity = 0) {
  const t = clock(time, still), energy = clamp(Number.isFinite(activity) ? activity : 0, 0, 1);
  const samples = Array.from({ length: 49 }, (_, index) => fishingBoatWaterSample(boat, 153 + index / 48 * 735, t, still, surface));
  const wet = samples.filter(sample => sample.depth >= -.5);
  const contact = wet.map(sample => sample.point);
  const ripples: FishingHullWaterStroke[] = [], reflections: FishingHullWaterStroke[] = [];
  if (wet.length < 2) return { contact, ripples, reflections, samples };
  const first = wet[0].local.x, last = wet.at(-1)!.local.x;
  const at = (amount: number, distance: number) => {
    const sample = fishingBoatWaterSample(boat, first + (last - first) * clamp(amount, 0, 1), t, still, surface);
    return { x: sample.point.x, y: sample.point.y + distance * boat.scale };
  };
  for (let index = 0; index < 6; index++) {
    const center = .05 + index * .18;
    const phase = (t * .22 + index * .173) % 1, pulse = Math.sin(Math.PI * phase) ** .8;
    const distance = 1.5 + phase * (16 + energy * 12), span = .025 + phase * .03;
    const points = Array.from({ length: 7 }, (_, sample) => {
      const along = sample / 6;
      return at(center + (along - .5) * span * 2, distance + Math.sin(along * Math.PI) * (1 + phase * 2));
    });
    ripples.push({ points, opacity: pulse * (.1 + energy * .075), width: Math.max(.8, boat.scale * (1.1 + energy * .5)) });
    for (let ribbon = 0; ribbon < 2; ribbon++) {
      const shimmer = Math.sin(t * .82 + index * 1.7 + ribbon) * 1.4;
      reflections.push({ points: [at(center - .017, 3 + ribbon * 5 + shimmer), at(center, 4 + ribbon * 5 + shimmer),
        at(center + .017, 3 + ribbon * 5 + shimmer)], opacity: (.065 + index % 3 * .012) * (ribbon ? .5 : 1), width: (ribbon ? 1.5 : 2.5) * boat.scale });
    }
  }
  return { contact, ripples, reflections, samples };
}

function strokePoints(ctx: CanvasRenderingContext2D, points: readonly FishingScenePoint[]) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke();
}

/** Paint in scene coordinates before the hull. The supplied transform includes its current bob and roll. */
export function paintFishingBoatDisplacement(ctx: CanvasRenderingContext2D, boat: FishingBoatTransform, time: number, still = false, surface?: number, activity = 0) {
  if (!(boat.scale > 0) || !Number.isFinite(boat.x + boat.y + boat.scale + (boat.roll ?? 0))) return;
  const frame = fishingHullWaterFrame(boat, time, still, surface, activity);
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const reflection of frame.reflections) {
    ctx.strokeStyle = `rgba(132,115,67,${reflection.opacity})`; ctx.lineWidth = Math.max(1, reflection.width);
    strokePoints(ctx, reflection.points);
  }
  ctx.strokeStyle = "rgba(4,48,56,.28)"; ctx.lineWidth = Math.max(1.3, boat.scale * 3);
  strokePoints(ctx, frame.contact);
  for (const ripple of frame.ripples) {
    ctx.strokeStyle = `rgba(188,231,219,${ripple.opacity})`; ctx.lineWidth = ripple.width;
    strokePoints(ctx, ripple.points);
  }
  ctx.restore();
}

/** The near-side meniscus is drawn after the boat, at the water plane, with broken glints only. */
export function paintFishingBoatSurfaceContact(ctx: CanvasRenderingContext2D, boat: FishingBoatTransform, time: number,
  still = false, surface?: number, activity = 0) {
  const frame = fishingHullWaterFrame(boat, time, still, surface, activity);
  if (frame.contact.length < 2) return;
  ctx.save(); ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(5,51,59,.4)"; ctx.lineWidth = Math.max(1, boat.scale * 2.3);
  strokePoints(ctx, frame.contact);
  for (let index = 1; index < frame.contact.length - 2; index += 6) {
    ctx.strokeStyle = `rgba(188,224,211,${.12 + clamp(activity, 0, 1) * .08})`; ctx.lineWidth = Math.max(.75, boat.scale * 1.25);
    strokePoints(ctx, frame.contact.slice(index, index + 3));
  }
  ctx.restore();
}
