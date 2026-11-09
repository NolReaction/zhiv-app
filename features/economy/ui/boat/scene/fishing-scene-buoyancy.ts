import type { FishingSceneBoatMotion, FishingScenePoint } from "./fishing-scene-types";

export const FISHING_BOAT_PIVOT = { x: 500, y: 535 } as const;
export type FishingBoatTransform = { x: number; y: number; scale: number; roll?: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
const rest = (): FishingSceneBoatMotion => ({ bob: 0, roll: 0, surge: 0 });

/** Shared presentation field. x/height/drift are logical scene pixels; time already includes the voyage's water phase. */
export function fishingWaterWave(x: number, time: number, still = false) {
  if (still || !Number.isFinite(x) || !Number.isFinite(time)) return { height: 0, slope: 0, drift: 0 };
  const t = Math.max(0, time), long = x * .0036 - t * .82, short = x * .0081 + t * .61 + .7;
  return { height: Math.sin(long) * 8.8 + Math.sin(short) * 3.1,
    slope: Math.cos(long) * 8.8 * .0036 + Math.cos(short) * 3.1 * .0081,
    drift: Math.cos(long) * 2.8 + Math.cos(short) * .8 };
}

/** Two support points let the hull settle onto the same water field instead of bobbing on an unrelated sine. */
export function fishingBoatMotion(time: number, still: boolean, centerX = 500, supportSpan = 440): FishingSceneBoatMotion {
  if (still || !Number.isFinite(time)) return rest();
  const center = finite(centerX, 500), span = clamp(finite(supportSpan, 440), 220, 680);
  const left = fishingWaterWave(center - span / 2, time), right = fishingWaterWave(center + span / 2, time);
  return { bob: (left.height + right.height) / 2,
    roll: clamp(Math.atan2(right.height - left.height, span) * .7, -.032, .032),
    surge: (left.drift + right.drift) / 2 };
}

type SpringAxis = { value: number; velocity: number };
export type FishingBoatInertia = { bob: SpringAxis; roll: SpringAxis; surge: SpringAxis; ready: boolean };
export type FishingBoatInertiaInput = { time: number; centerX?: number; supportSpan?: number; effort?: number; still?: boolean };

export function createFishingBoatInertia(): FishingBoatInertia {
  return { bob: { value: 0, velocity: 0 }, roll: { value: 0, velocity: 0 }, surge: { value: 0, velocity: 0 }, ready: false };
}

export function fishingBoatInertiaMotion(state: FishingBoatInertia, still = false): FishingSceneBoatMotion {
  return still ? rest() : { bob: state.bob.value, roll: state.roll.value, surge: state.surge.value };
}

/** Only a genuinely new visible action may add an impulse; replay suppression belongs to the scene runtime. */
export function disturbFishingBoat(state: FishingBoatInertia, action: "cast" | "bite") {
  if (!state.ready) return;
  const kick = action === "cast" ? { bob: 6.5, roll: .014, surge: -4.5 } : { bob: 4, roll: .021, surge: 5.5 };
  state.bob.velocity = clamp(state.bob.velocity + kick.bob, -16, 16);
  state.roll.velocity = clamp(state.roll.velocity + kick.roll, -.065, .065);
  state.surge.velocity = clamp(state.surge.velocity + kick.surge, -12, 12);
}

function spring(axis: SpringAxis, target: number, frequency: number, damping: number, step: number, limit: number) {
  axis.velocity += ((target - axis.value) * frequency * frequency - 2 * damping * frequency * axis.velocity) * step;
  axis.value += axis.velocity * step;
  if (Math.abs(axis.value) > limit) {
    axis.value = clamp(axis.value, -limit, limit);
    if (Math.sign(axis.value) === Math.sign(axis.velocity)) axis.velocity = 0;
  }
}

/** Presentation-only damped buoyancy. Small integration steps keep response consistent at 30/60/120 Hz. */
export function advanceFishingBoatInertia(state: FishingBoatInertia, seconds: number, input: FishingBoatInertiaInput): FishingSceneBoatMotion {
  if (input.still) return rest();
  const effort = clamp(finite(input.effort, 0), 0, 1.2);
  const targetAt = (time: number) => {
    const wave = fishingBoatMotion(time, false, input.centerX, input.supportSpan);
    return { bob: wave.bob + effort * 1.1, roll: wave.roll + effort * .0045, surge: wave.surge + effort * 1.8 };
  };
  const time = finite(input.time, 0);
  if (!state.ready) {
    const target = targetAt(time);
    state.bob.value = target.bob; state.roll.value = target.roll; state.surge.value = target.surge;
    state.ready = true;
  }
  const duration = clamp(finite(seconds, 0), 0, .1);
  if (duration === 0) return fishingBoatInertiaMotion(state);
  const steps = Math.max(1, Math.ceil(duration * 120)), step = duration / steps;
  for (let index = 0; index < steps; index++) {
    const target = targetAt(Math.max(0, time - duration + (index + 1) * step));
    spring(state.bob, target.bob, 2.65, .7, step, 14);
    spring(state.roll, target.roll, 2.9, .72, step, .045);
    spring(state.surge, target.surge, 2.05, .8, step, 9);
  }
  return fishingBoatInertiaMotion(state);
}

/** Must match the painter's translate / scale / pivot / rotate order. */
export function transformFishingBoatPoint(point: FishingScenePoint, boat: FishingBoatTransform): FishingScenePoint {
  const roll = boat.roll ?? 0, dx = point.x - FISHING_BOAT_PIVOT.x, dy = point.y - FISHING_BOAT_PIVOT.y;
  return { x: boat.x + (FISHING_BOAT_PIVOT.x + dx * Math.cos(roll) - dy * Math.sin(roll)) * boat.scale,
    y: boat.y + (FISHING_BOAT_PIVOT.y + dx * Math.sin(roll) + dy * Math.cos(roll)) * boat.scale };
}
