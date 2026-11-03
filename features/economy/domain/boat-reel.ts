import type { BoatChallenge, BoatReelInput, BoatResistance } from "./boat-model";
export type BoatReelState = { tick: number; bar: number; velocity: number; fish: number; progress: number; status: "active" | "caught" | "escaped" };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function boatReelHash(seed: number, segment: number): number {
  let value = (seed ^ Math.imul(segment + 1, 0x9e3779b9)) >>> 0;
  value = (value ^ value << 13) >>> 0; value = (value ^ value >>> 17) >>> 0; return (value ^ value << 5) >>> 0;
}
/** V1 integer physics is immutable: existing saved challenges retain these rules. */
export function initialBoatReel(challenge: BoatChallenge): BoatReelState {
  if (![1, 2, 3, 4].includes(challenge.rulesVersion)) throw new RangeError("Unsupported boat reel version");
  if (challenge.rulesVersion >= 2 && !challenge.resistance) throw new RangeError("Missing boat resistance profile");
  if (challenge.rulesVersion >= 3 && !challenge.fishRarity) throw new RangeError("Missing public boat fish class");
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

export type BoatResistancePhase = "cruising" | "preparing" | "surging" | "recovering";

/** V3: class-scaled movement, readable preparation and at least one second of recovery. */
export function boatResistanceMotionV3(challenge: BoatChallenge, tick: number) {
  const difficulty = challenge.difficulty;
  const rank = ["common", "uncommon", "rare", "epic", "legendary"].indexOf(challenge.fishRarity ?? "common") + 1;
  switch (challenge.resistance) {
    case "steady": {
      const segment = Math.floor(tick / 96), resting = tick % 96 >= 64;
      return { target: 1300 + boatReelHash(challenge.seed, segment) % 7401,
        limit: resting ? 20 + 2 * difficulty : 32 + 4 * difficulty + 2 * rank,
        divisor: resting ? 15 : 11, phase: resting ? "recovering" : "cruising" } as const;
    }
    case "sprightly": {
      const segment = Math.floor(tick / 80), phase = tick % 80;
      const base = 1300 + boatReelHash(challenge.seed, segment) % 7401;
      if (phase >= 60) return { target: 4300 + boatReelHash(challenge.seed ^ 0xa341316c, segment) % 1401,
        limit: 22 + 2 * difficulty, divisor: 15, phase: "recovering" } as const;
      if (phase >= 42) return { target: 10000 - base, limit: 66 + 5 * difficulty + 7 * rank, divisor: 6, phase: "surging" } as const;
      if (phase >= 30) return { target: base, limit: 20 + 2 * difficulty, divisor: 16, phase: "preparing" } as const;
      return { target: base, limit: 44 + 3 * difficulty + 3 * rank, divisor: 9, phase: "cruising" } as const;
    }
    case "surging": {
      const segment = Math.floor(tick / 100), phase = tick % 100;
      const hash = boatReelHash(challenge.seed, segment), base = 1900 + hash % 6201;
      if (phase >= 72) return { target: 4200 + boatReelHash(challenge.seed ^ 0xa341316c, segment) % 1601,
        limit: 26 + 2 * difficulty, divisor: 14, phase: "recovering" } as const;
      if (phase >= 38) return { target: clamp(base + ((hash & 1) ? 1 : -1) * (1700 + 200 * rank), 800, 9200),
        limit: 76 + 5 * difficulty + 8 * rank, divisor: 6, phase: "surging" } as const;
      if (phase >= 24) return { target: base, limit: 18 + 2 * difficulty, divisor: 16, phase: "preparing" } as const;
      return { target: base, limit: 34 + 3 * difficulty + 3 * rank, divisor: 11, phase: "cruising" } as const;
    }
    case "stubborn": {
      const segment = Math.floor(tick / 120), phase = tick % 120;
      const hash = boatReelHash(challenge.seed, segment);
      const target = ((hash & 1) ? 7100 : 1200) + hash % 1701;
      if (phase >= 88) return { target: 3800 + boatReelHash(challenge.seed ^ 0xa341316c, segment) % 2401,
        limit: 18 + 2 * difficulty, divisor: 16, phase: "recovering" } as const;
      if (phase < 16) return { target, limit: 18 + 2 * difficulty, divisor: 16, phase: "preparing" } as const;
      return { target, limit: 70 + 4 * difficulty + 9 * rank, divisor: 8, phase: "surging" } as const;
    }
    default: throw new RangeError("Unknown boat resistance profile");
  }
}

/** Presentation can describe current public motion; it cannot advance or alter replay. */
export function boatReelResistancePhase(challenge: BoatChallenge, tick: number): BoatResistancePhase {
  return challenge.rulesVersion >= 3 ? boatResistanceMotionV3(challenge, Math.max(0, Math.trunc(tick))).phase : "cruising";
}

export function stepBoatReel(challenge: BoatChallenge, state: BoatReelState, held: boolean): BoatReelState {
  if (state.status !== "active") return state;
  const modernControl = challenge.rulesVersion === 4;
  let velocity = clamp(Math.trunc(state.velocity * (modernControl ? 96 : 94) / 100)
    + (held ? modernControl ? 22 : 26 : modernControl ? -18 : -20), -220, 220);
  const half = challenge.zoneWidth / 2, freeBar = state.bar + velocity, bar = clamp(freeBar, half, 10000 - half);
  // A dropped V4 zone rebounds gently from the bottom. Slow contacts settle; the upper stop never bounces.
  if (bar !== freeBar) velocity = modernControl && freeBar < half && velocity < -40 ? Math.trunc(-velocity * 40 / 100) : 0;
  const motion = challenge.rulesVersion >= 3 ? boatResistanceMotionV3(challenge, state.tick) : challenge.rulesVersion === 2 ? boatResistanceMotion(challenge, state.tick) : {
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
