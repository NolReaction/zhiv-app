import type { BoatChallenge, BoatReelInput } from "./boat-model";
export type BoatReelState = { tick: number; bar: number; velocity: number; fish: number; progress: number; status: "active" | "caught" | "escaped" };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function boatReelHash(seed: number, segment: number): number {
  let value = (seed ^ Math.imul(segment + 1, 0x9e3779b9)) >>> 0;
  value = (value ^ value << 13) >>> 0; value = (value ^ value >>> 17) >>> 0; return (value ^ value << 5) >>> 0;
}
/** V1 integer physics is immutable: existing saved challenges retain these rules. */
export function initialBoatReel(challenge: BoatChallenge): BoatReelState {
  if (challenge.rulesVersion !== 1) throw new RangeError("Unsupported boat reel version");
  return { tick: 0, bar: 5000, velocity: 0, fish: 5000, progress: 2500, status: "active" };
}
export function stepBoatReel(challenge: BoatChallenge, state: BoatReelState, held: boolean): BoatReelState {
  if (state.status !== "active") return state;
  let velocity = clamp(Math.trunc(state.velocity * 94 / 100) + (held ? 26 : -20), -220, 220);
  const half = challenge.zoneWidth / 2, bar = clamp(state.bar + velocity, half, 10000 - half);
  if (bar !== state.bar + velocity) velocity = 0;
  const target = 500 + boatReelHash(challenge.seed, Math.floor(state.tick / (60 - 6 * challenge.difficulty))) % 9001;
  const limit = 35 + 7 * challenge.difficulty;
  const fish = clamp(state.fish + clamp(Math.trunc((target - state.fish) / 10), -limit, limit), 0, 10000);
  const progress = clamp(state.progress + (Math.abs(fish - bar) <= half ? 32 : -45), 0, 10000), tick = state.tick + 1;
  return { tick, bar, velocity, fish, progress, status: progress === 10000 ? "caught" : progress === 0 || tick >= challenge.maxTicks ? "escaped" : "active" };
}
/** Replays only legal, bounded control transitions. It does not prove human input. */
export function replayBoatReel(challenge: BoatChallenge, inputs: readonly BoatReelInput[], endTick: number): BoatReelState {
  if (!Number.isInteger(endTick) || endTick < 1 || endTick > challenge.maxTicks || inputs.length > 600
    || inputs.some((input, index) => !Number.isInteger(input.tick) || input.tick < 0 || input.tick >= endTick || typeof input.held !== "boolean"
      || index > 0 && input.tick <= inputs[index - 1].tick)) throw new RangeError("Invalid boat input trace");
  let state = initialBoatReel(challenge), held = false, inputIndex = 0;
  while (state.tick < endTick) {
    if (state.status !== "active") throw new RangeError("Boat trace continues after its result");
    if (inputs[inputIndex]?.tick === state.tick) held = inputs[inputIndex++].held;
    state = stepBoatReel(challenge, state, held);
  }
  return state;
}
