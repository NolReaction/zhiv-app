import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const physics = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { boatChallengeSchema } = await vite.ssrLoadModule("/features/economy/domain/boat-model.ts");
const checkpoint = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");
const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/boat-reel-v3-vectors.json", import.meta.url), "utf8"));
const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
const profiles = ["steady", "sprightly", "surging", "stubborn"];
const sample = vectors.cases[0].challenge;
function follow(challenge, everyTicks) {
  let frame = physics.initialBoatReel(challenge), held = false; const inputs = [];
  while (frame.status === "active") {
    if (frame.tick % everyTicks === 0) {
      const next = frame.fish > frame.bar + frame.velocity * 4;
      if (next !== held) { inputs.push({ tick: frame.tick, held: next }); held = next; }
    }
    frame = physics.stepBoatReel(challenge, frame, held);
  }
  return { frame, inputs };
}

test("independent V3 shared vectors fix public class scaling, phases, unsigned seeds and terminal replay", () => {
  assert.equal(vectors.version, 3);
  for (const vector of vectors.cases) {
    const challenge = boatChallengeSchema.parse(vector.challenge);
    assert.deepEqual(physics.replayBoatReel(challenge, vector.inputs, vector.endTick), vector.expected, vector.name);
    for (const saved of vector.checkpoints) assert.deepEqual(physics.replayBoatReel(challenge,
      vector.inputs.filter(input => input.tick < saved.tick), saved.tick), saved, `${vector.name}@${saved.tick}`);
  }
  for (const vector of vectors.phases) for (const sample of vector.samples) {
    assert.equal(physics.boatReelResistancePhase(vector.challenge, sample.tick), sample.phase, `${vector.challenge.resistance}@${sample.tick}`);
  }
});

test("V3 fast phases have readable preparation and at least one second of recovery; phase feedback is observational", () => {
  for (const vector of vectors.phases) {
    const { challenge, period } = vector;
    const phases = Array.from({ length: period }, (_, tick) => physics.boatReelResistancePhase(challenge, tick));
    assert.ok(phases.filter(phase => phase === "recovering").length >= 20);
    if (challenge.resistance !== "steady") {
      assert.ok(phases.filter(phase => phase === "preparing").length >= 12);
      const burst = phases.indexOf("surging");
      assert.equal(phases[burst - 1], "preparing");
    }
    const before = JSON.stringify(challenge);
    const first = follow(challenge, 3);
    phases.forEach((_, tick) => physics.boatReelResistancePhase(challenge, tick));
    assert.deepEqual(follow(challenge, 3), first);
    assert.equal(JSON.stringify(challenge), before);
  }
});

test("rarer public classes increase motion pressure while common fish retain gentle drift and V1/V2 ignore the new display class", () => {
  for (const resistance of profiles) {
    const common = { ...sample, resistance, fishRarity: "common", difficulty: 3 };
    const rare = { ...common, fishRarity: "legendary" };
    const maxLimit = challenge => Math.max(...Array.from({ length: 240 }, (_, tick) => physics.boatResistanceMotionV3(challenge, tick).limit));
    assert.ok(maxLimit(rare) > maxLimit(common), resistance);
    assert.ok(maxLimit(rare) < 160, "fish bursts stay below maximum controllable bar speed");
    const commonTrace = follow(common, 6), rareTrace = follow(rare, 6);
    assert.notDeepEqual(commonTrace, rareTrace);
    for (const rulesVersion of [1, 2]) {
      assert.deepEqual(follow({ ...common, rulesVersion }, 6), follow({ ...rare, rulesVersion }, 6), `V${rulesVersion} remains class independent`);
      assert.equal(physics.boatReelResistancePhase({ ...common, rulesVersion }, 45), "cruising");
    }
  }
  assert.ok(physics.boatResistanceMotionV3(sample, 0).limit <= 40);
});

test("V3 stays catchable with 150ms and 300ms sampled reference input across actual class and weight difficulty ranges", () => {
  // This is a repeatable control-contract check, not a human reaction or device playtest.
  for (const everyTicks of [3, 6]) for (let rank = 0; rank < rarities.length; rank++) {
    for (let difficulty = rank + 1; difficulty <= Math.min(5, rank + 2); difficulty++) for (let index = 0; index < 64; index++) {
      const seed = Math.imul(index + 1, 0x9e3779b9) >>> 0;
      const challenge = { ...sample, seed, difficulty, fishRarity: rarities[rank], resistance: physics.boatResistanceForClass(rarities[rank], seed) };
      const { frame, inputs } = follow(challenge, everyTicks);
      assert.equal(frame.status, "caught", `${rarities[rank]}/${difficulty}/${index}/${everyTicks}`);
      assert.deepEqual(physics.replayBoatReel(challenge, inputs, frame.tick), frame);
    }
  }
});

test("V3 validates its public class and restores checkpoints only for the same version, profile and class", () => {
  assert.equal(boatChallengeSchema.safeParse(sample).success, true);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, fishRarity: undefined }).success, false);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, fishRarity: "invented" }).success, false);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, resistance: undefined }).success, false);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, rulesVersion: 5 }).success, false);
  for (const rulesVersion of [1, 2]) assert.equal(boatChallengeSchema.safeParse({ ...sample, rulesVersion, fishRarity: undefined }).success, true);
  assert.throws(() => physics.initialBoatReel({ ...sample, fishRarity: undefined }), /public boat fish class/);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const { frame, inputs } = follow(sample, 6), key = "v3-checkpoint";
  checkpoint.writeBoatReelCheckpoint(storage, key, sample, frame, inputs);
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(storage, key, sample), { reel: frame, inputs });
  for (const altered of [{ ...sample, rulesVersion: 2 }, { ...sample, resistance: "surging" }, { ...sample, fishRarity: "rare" }]) {
    assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, altered).reel.tick, 0);
  }
  const old = { ...sample, rulesVersion: 2, fishRarity: undefined }, oldRun = follow(old, 6);
  checkpoint.writeBoatReelCheckpoint(storage, key, old, oldRun.frame, oldRun.inputs);
  assert.equal(JSON.parse(values.get(key)).fishRarity, undefined, "existing V2 metadata stays compatible");
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(storage, key, old).reel, oldRun.frame);
  assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, sample).reel.tick, 0);
});
