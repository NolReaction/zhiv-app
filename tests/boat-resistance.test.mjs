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
const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/boat-reel-v2-vectors.json", import.meta.url), "utf8"));
const profiles = ["steady", "sprightly", "surging", "stubborn"];
const challenge = (resistance = "steady", seed = 0, difficulty = 1) => ({ ...vectors.cases[0].challenge, resistance, seed, difficulty });

function follow(attempt, everyTicks = 3) {
  let frame = physics.initialBoatReel(attempt), held = false;
  const inputs = [];
  while (frame.status === "active") {
    if (frame.tick % everyTicks === 0) {
      const next = frame.fish > frame.bar + frame.velocity * 4;
      if (next !== held) { inputs.push({ tick: frame.tick, held: next }); held = next; }
    }
    frame = physics.stepBoatReel(attempt, frame, held);
  }
  return { frame, inputs };
}

test("independent shared V2 vectors fix profile phases, unsigned seeds and terminal replay", () => {
  assert.equal(vectors.version, 2);
  for (const vector of vectors.cases) {
    const attempt = boatChallengeSchema.parse(vector.challenge);
    assert.deepEqual(physics.replayBoatReel(attempt, vector.inputs, vector.endTick), vector.expected, vector.name);
    for (const saved of vector.checkpoints) assert.deepEqual(physics.replayBoatReel(attempt,
      vector.inputs.filter(input => input.tick < saved.tick), saved.tick), saved, `${vector.name}@${saved.tick}`);
  }
});

test("four resistance profiles make different real fish paths and include slower recovery phases", () => {
  const paths = profiles.map(resistance => {
    const attempt = challenge(resistance, 3902242211, 3);
    let frame = physics.initialBoatReel(attempt); const positions = [];
    for (let tick = 0; tick < 50; tick++) { frame = physics.stepBoatReel(attempt, frame, false); positions.push(frame.fish); }
    return positions;
  });
  assert.equal(new Set(paths.map(path => path.join(","))).size, profiles.length);
  for (const profile of ["sprightly", "surging", "stubborn"]) {
    const attempt = challenge(profile, 0, 3);
    const limits = Array.from({ length: 160 }, (_, tick) => physics.boatResistanceMotion(attempt, tick).limit);
    assert.ok(Math.max(...limits) > Math.min(...limits) + 10, `${profile} gives recovery rather than an endless burst`);
  }
  for (let difficulty = 1; difficulty <= 5; difficulty++) for (let index = 0; index < 32; index++) for (const profile of profiles) {
    const attempt = challenge(profile, Math.imul(index + 1, 0x9e3779b9) >>> 0, difficulty);
    const played = follow(attempt);
    assert.equal(played.frame.status, "caught", `${profile}/${index}/${difficulty} remains catchable with 150ms input samples`);
    assert.ok(played.frame.tick <= 600 && played.inputs.length <= 600);
    assert.deepEqual(physics.replayBoatReel(attempt, played.inputs, played.frame.tick), played.frame);
  }
});

test("new profile metadata validates strictly while immutable V1 can still omit it", () => {
  const sample = challenge();
  assert.equal(boatChallengeSchema.safeParse(sample).success, true);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, resistance: undefined }).success, false);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, resistance: "unbounded" }).success, false);
  assert.equal(boatChallengeSchema.safeParse({ ...sample, rulesVersion: 5 }).success, false);
  const old = { ...sample, rulesVersion: 1, resistance: undefined };
  assert.equal(boatChallengeSchema.safeParse(old).success, true);
  const oldWithIgnoredHint = { ...old, resistance: "stubborn" };
  assert.deepEqual(follow(old).frame, follow(oldWithIgnoredHint).frame);
  assert.equal(physics.boatResistanceForClass("common", 0), "steady");
  assert.equal(physics.boatResistanceForClass("uncommon", 1), "sprightly");
  assert.equal(physics.boatResistanceForClass("rare", 1), "surging");
  assert.equal(physics.boatResistanceForClass("epic", 1), "stubborn");
  assert.equal(physics.boatResistanceForClass("legendary", 0), "stubborn");
});

test("checkpoint replay scopes V2 controls to the saved version and profile without breaking older V1 drafts", () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const attempt = challenge("surging", 4294967295, 4), played = follow(attempt), key = "test-draft";
  checkpoint.writeBoatReelCheckpoint(storage, key, attempt, played.frame, played.inputs);
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(storage, key, attempt).reel, played.frame);
  assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, { ...attempt, resistance: "steady" }).reel.tick, 0);
  assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, { ...attempt, rulesVersion: 1 }).reel.tick, 0);
  const old = { ...attempt, rulesVersion: 1, resistance: undefined }, oldTrace = follow(old);
  values.set(key, JSON.stringify({ ...checkpoint.boatReelSubmission(old, oldTrace.frame, oldTrace.inputs), seed: old.seed, startedAt: old.startedAt }));
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(storage, key, old).reel, oldTrace.frame);
  assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, attempt).reel.tick, 0);
});
