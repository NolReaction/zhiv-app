import type { BoatChallenge, BoatReelInput, BoatResistance } from "./boat-model";
export type BoatReelState = { tick: number; bar: number; velocity: number; fish: number; progress: number; status: "active" | "caught" | "escaped" };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function boatReelHash(seed: number, segment: number): number {
  let value = (seed ^ Math.imul(segment + 1, 0x9e3779b9)) >>> 0;
  value = (value ^ value << 13) >>> 0; value = (value ^ value >>> 17) >>> 0; return (value ^ value << 5) >>> 0;
}
/** V1 integer physics is immutable: existing saved challenges retain these rules. */
export function initialBoatReel(challenge: BoatChallenge): BoatReelState {
  if (challenge.rulesVersion !== 1 && challenge.rulesVersion !== 2) throw new RangeError("Unsupported boat reel version");
  if (challenge.rulesVersion === 2 && !challenge.resistance) throw new RangeError("Missing boat resistance profile");
  return { tick: 0, bar: 5000, velocity: 0, fish: 5000, progress: 2500, status: "active" };
}
/** A public class selects a motion profile, without disclosing species or weight. */
export function boatResistanceForClass(rarity: string | undefined, seed: number): BoatResistance {
  const alternate = (seed & 1) === 1;
  if (rarity === "uncommon") return alternate ? "sprightly" : "steady";
  if (rarity === "rare") return alternate ? "surging" : "sprightly";
  if (rarity === "epic") return alternate ? "stubborn" : "surging";
  if (rarity === "legendary") return alternate ? "surging" : "stubborn";
  return "steady";
}

/** V2 changes only fish motion. Each burst has an authored recovery phase. All arithmetic is integer. */
export function boatResistanceMotion(challenge: BoatChallenge, tick: number) {
  const difficulty = challenge.difficulty;
  switch (challenge.resistance) {
    case "steady": {
      const segment = Math.floor(tick / 96);
      return { target: 1300 + boatReelHash(challenge.seed, segment) % 7401, limit: 26 + 3 * difficulty, divisor: 14 };
    }
    case "sprightly": {
      const segment = Math.floor(tick / 54), resting = tick % 54 >= 36;
      return { target: 1100 + boatReelHash(challenge.seed, segment) % 7801,
        limit: resting ? 20 + 2 * difficulty : 52 + 3 * difficulty, divisor: resting ? 14 : 8 };
    }
    case "surging": {
      const segment = Math.floor(tick / 108), phase = tick % 108;
      const hash = boatReelHash(challenge.seed, segment), base = 1700 + hash % 6601;
      const bursting = phase >= 40 && phase < 78;
      return { target: bursting ? clamp(base + ((hash & 1) ? 2200 : -2200), 900, 9100) : base,
        limit: bursting ? 70 + 3 * difficulty : phase < 40 ? 22 + 2 * difficulty : 28 + 2 * difficulty,
        divisor: bursting ? 7 : phase < 40 ? 14 : 12 };
    }
    case "stubborn": {
      const segment = Math.floor(tick / 144), resting = tick % 144 >= 96;
      return { target: resting ? 2500 + boatReelHash(challenge.seed ^ 0xa341316c, segment) % 5001
        : 900 + boatReelHash(challenge.seed, segment) % 8201,
        limit: resting ? 18 + 2 * difficulty : 38 + 3 * difficulty, divisor: resting ? 15 : 10 };
    }
    default: throw new RangeError("Unknown boat resistance profile");
  }
}

export function stepBoatReel(challenge: BoatChallenge, state: BoatReelState, held: boolean): BoatReelState {
  if (state.status !== "active") return state;
  let velocity = clamp(Math.trunc(state.velocity * 94 / 100) + (held ? 26 : -20), -220, 220);
  const half = challenge.zoneWidth / 2, bar = clamp(state.bar + velocity, half, 10000 - half);
  if (bar !== state.bar + velocity) velocity = 0;
  const motion = challenge.rulesVersion === 2 ? boatResistanceMotion(challenge, state.tick) : {
    target: 500 + boatReelHash(challenge.seed, Math.floor(state.tick / (60 - 6 * challenge.difficulty))) % 9001,
    limit: 35 + 7 * challenge.difficulty, divisor: 10,
  };
  const fish = clamp(state.fish + clamp(Math.trunc((motion.target - state.fish) / motion.divisor), -motion.limit, motion.limit), 0, 10000);
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
