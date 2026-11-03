import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const physics = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { boatChallengeSchema } = await vite.ssrLoadModule("/features/economy/domain/boat-model.ts");
const checkpoint = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");
const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/boat-reel-v4-vectors.json", import.meta.url), "utf8"));
const sample = vectors.cases[0].challenge;
const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
const profiles = ["steady", "sprightly", "surging", "stubborn"];
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

test("V4 independent integer vectors cover inertial control, lower rebound, public fish motion and terminal results", () => {
  assert.equal(vectors.version, 4);
  for (const vector of vectors.cases) {
    const challenge = boatChallengeSchema.parse(vector.challenge);
    assert.deepEqual(physics.replayBoatReel(challenge, vector.inputs, vector.endTick), vector.expected, vector.name);
    for (const saved of vector.checkpoints) assert.deepEqual(physics.replayBoatReel(challenge,
      vector.inputs.filter(input => input.tick < saved.tick), saved.tick), saved, `${vector.name}@${saved.tick}`);
  }
  for (const vector of vectors.controlSamples) assert.deepEqual(
    physics.stepBoatReel(boatChallengeSchema.parse(vector.challenge), vector.before, vector.held), vector.expected, vector.name);
});

test("V4 control has real momentum, a bounded lower rebound, settled slow contact and no upper rebound", () => {
  for (const zoneWidth of [3200, 4000]) {
    const challenge = { ...sample, zoneWidth }, half = zoneWidth / 2;
    const drop = { tick: 20, bar: half + 2, velocity: -220, fish: 5000, progress: 5000, status: "active" };
    const bounced = physics.stepBoatReel(challenge, drop, false);
    assert.equal(bounced.bar, half); assert.ok(bounced.velocity > 0 && bounced.velocity < 100);
    let frame = bounced, peak = frame.bar;
    for (let tick = 0; tick < 18; tick++) { frame = physics.stepBoatReel(challenge, frame, false); peak = Math.max(peak, frame.bar); }
    assert.ok(peak > half && peak < half + 300, "the lower bounce is visible but never a violent launch");
    assert.equal(frame.bar, half); assert.equal(frame.velocity, 0, "release comes to rest rather than perpetually micro-bouncing");
    const slow = physics.stepBoatReel(challenge, { ...drop, velocity: -15 }, false);
    assert.equal(slow.bar, half); assert.equal(slow.velocity, 0);
    const top = physics.stepBoatReel(challenge, { ...drop, bar: 10000 - half - 2, velocity: 220 }, true);
    assert.equal(top.bar, 10000 - half); assert.equal(top.velocity, 0);
    const rising = physics.stepBoatReel(challenge, { ...drop, bar: 5000, velocity: 180 }, false);
    assert.ok(rising.bar > 5000 && rising.velocity > 0 && rising.velocity < 180, "release brakes an upward zone before it falls");
    const falling = physics.stepBoatReel(challenge, { ...drop, bar: 5000, velocity: -180 }, true);
    assert.ok(falling.bar < 5000 && falling.velocity < 0 && falling.velocity > -180, "holding first brakes downward momentum");
  }
});

test("V4 reuses V3 fish targets and resistance phases while saved V1/V2/V3 retain their original controls", () => {
  for (const resistance of profiles) for (const fishRarity of rarities) {
    const modern = { ...sample, resistance, fishRarity, rulesVersion: 4 };
    for (let tick = 0; tick < 600; tick++) {
      const frame = { tick, bar: 5000, velocity: -80, fish: 3500, progress: 5000, status: "active" };
      assert.equal(physics.stepBoatReel(modern, frame, true).fish,
        physics.stepBoatReel({ ...modern, rulesVersion: 3 }, frame, true).fish);
      assert.equal(physics.boatReelResistancePhase(modern, tick), physics.boatReelResistancePhase({ ...modern, rulesVersion: 3 }, tick));
    }
  }
  const frame = { tick: 12, bar: 5000, velocity: 120, fish: 5000, progress: 5000, status: "active" };
  const oldControls = [1, 2, 3].map(rulesVersion => physics.stepBoatReel({ ...sample, rulesVersion }, frame, false));
  assert.deepEqual(oldControls.map(value => [value.bar, value.velocity]), [[5092, 92], [5092, 92], [5092, 92]]);
  assert.notDeepEqual([physics.stepBoatReel(sample, frame, false).bar, physics.stepBoatReel(sample, frame, false).velocity], [5092, 92]);
});

test("V4 public-class validation and checkpoints isolate the new rules without discarding valid saved V3", () => {
  assert.equal(boatChallengeSchema.safeParse(sample).success, true);
  for (const altered of [{ ...sample, fishRarity: undefined }, { ...sample, resistance: undefined }, { ...sample, rulesVersion: 5 }])
    assert.equal(boatChallengeSchema.safeParse(altered).success, false);
  assert.throws(() => physics.initialBoatReel({ ...sample, fishRarity: undefined }), /public boat fish class/);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const key = "v4-checkpoint", run = follow(sample, 6);
  checkpoint.writeBoatReelCheckpoint(storage, key, sample, run.frame, run.inputs);
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(storage, key, sample), { reel: run.frame, inputs: run.inputs });
  for (const altered of [{ ...sample, rulesVersion: 3 }, { ...sample, resistance: "surging" }, { ...sample, fishRarity: "rare" }])
    assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, altered).reel.tick, 0);
  const old = { ...sample, rulesVersion: 3 }, oldRun = follow(old, 6);
  checkpoint.writeBoatReelCheckpoint(storage, key, old, oldRun.frame, oldRun.inputs);
  assert.deepEqual(checkpoint.readBoatReelCheckpoint(storage, key, old), { reel: oldRun.frame, inputs: oldRun.inputs });
  assert.equal(checkpoint.readBoatReelCheckpoint(storage, key, sample).reel.tick, 0);
});

test("V4 reference input remains catchable at 150ms and 300ms across realistic class, difficulty and unsigned seeds", () => {
  // A deterministic control regression, not a claim about human play or device latency.
  for (const everyTicks of [3, 6]) for (let rank = 0; rank < rarities.length; rank++)
    for (let difficulty = rank + 1; difficulty <= Math.min(5, rank + 2); difficulty++) for (let index = 0; index < 64; index++) {
      const seed = Math.imul(index + 1, 0x9e3779b9) >>> 0;
      const challenge = { ...sample, seed, difficulty, fishRarity: rarities[rank], resistance: physics.boatResistanceForClass(rarities[rank], seed) };
      const { frame, inputs } = follow(challenge, everyTicks);
      assert.equal(frame.status, "caught", `${rarities[rank]}/${difficulty}/${index}/${everyTicks}`);
      assert.deepEqual(physics.replayBoatReel(challenge, inputs, frame.tick), frame);
    }
});
