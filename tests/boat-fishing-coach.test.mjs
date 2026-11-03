import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createBoatFishingCoach, boatCoachStorageKey, boatCoachInstruction } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-fishing-coach.ts");
const { initialBoatReel, stepBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const storage = () => { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };
const attempt = { id: "attempt", rulesVersion: 1, seed: 17, tickMs: 50, maxTicks: 600, zoneWidth: 3200, difficulty: 1,
  startedAt: "2026-11-03T00:00:00Z", expiresAt: "2026-11-03T00:02:00Z" };
const sample = (reel, held, stage = "reeling") => ({ challengeId: attempt.id, stage, playing: stage === "reeling", held, tick: reel.tick, bar: reel.bar });

test("lesson completes only after simulated upward hold and downward release, without changing the reel", () => {
  const saved = storage(), coach = createBoatFishingCoach("owner"); let reel = initialBoatReel(attempt);
  coach.observe(sample(reel, true), saved);
  for (let tick = 0; tick < 8; tick++) { reel = stepBoatReel(attempt, reel, true); coach.observe(sample(reel, true), saved); }
  assert.equal(coach.snapshot().learnedLift, true); assert.equal(coach.snapshot().completed, false);
  const beforeRelease = structuredClone(reel); coach.observe(sample(reel, false), saved);
  for (let tick = 0; tick < 24; tick++) { reel = stepBoatReel(attempt, reel, false); coach.observe(sample(reel, false), saved); }
  assert.equal(coach.snapshot().completed, true); assert.equal(coach.snapshot().justCompleted, true);
  coach.observe(sample(reel, false, "paused"), saved); assert.equal(coach.snapshot().justCompleted, false);
  assert.equal(saved.getItem(boatCoachStorageKey("owner")), "done");
  assert.equal(beforeRelease.tick, 8); assert.ok(reel.tick > beforeRelease.tick);
});

test("repeated snapshots, input toggles, paused releases and another attempt cannot fabricate learned movement", () => {
  const coach = createBoatFishingCoach("owner"), saved = storage();
  const initial = initialBoatReel(attempt);
  for (let index = 0; index < 30; index++) coach.observe(sample(initial, index % 2 === 0), saved);
  assert.equal(coach.snapshot().learnedLift, false);
  coach.observe(sample({ ...initial, tick: 10, bar: 6500 }, true, "paused"), saved);
  coach.observe(sample({ ...initial, tick: 11, bar: 7000 }, true), saved);
  assert.equal(coach.snapshot().learnedLift, false, "resume establishes a baseline instead of teaching a paused jump");
  coach.observe({ ...sample({ ...initial, tick: 12, bar: 8000 }, true), challengeId: "other" }, saved);
  assert.equal(coach.snapshot().completed, false); assert.equal(saved.map.size, 0);
});

test("completion is scoped per owner/device, replay is cosmetic and denied storage remains usable", () => {
  const saved = storage(); saved.setItem(boatCoachStorageKey("first"), "done");
  const first = createBoatFishingCoach("first"), second = createBoatFishingCoach("second");
  first.restore(saved); second.restore(saved);
  assert.equal(first.snapshot().completed, true); assert.equal(second.snapshot().completed, false);
  assert.equal(boatCoachInstruction(first.snapshot(), "waiting"), null);
  first.reset(saved); assert.equal(first.snapshot().completed, false); assert.equal(saved.map.size, 0);
  const denied = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => first.restore(denied)); assert.doesNotThrow(() => first.reset(denied));
  assert.match(boatCoachInstruction(first.snapshot(), "waiting"), /Забросьте/);
  assert.match(boatCoachInstruction(first.snapshot(), "soaking"), /Дождитесь/);
  assert.match(boatCoachInstruction(first.snapshot(), "bite"), /Подсечь/);
  assert.match(boatCoachInstruction(first.snapshot(), "reeling"), /Зажмите/);
});


test("falling after a pause's forced release cannot finish the lesson until a new intentional hold and release", () => {
  const coach = createBoatFishingCoach("owner"), saved = storage(), initial = initialBoatReel(attempt);
  const observe = (tick, bar, held, stage = "reeling") => coach.observe(sample({ ...initial, tick, bar }, held, stage), saved);
  observe(0, 5000, true); observe(1, 5050, true); observe(2, 5110, true);
  assert.equal(coach.snapshot().learnedLift, true);
  observe(2, 5110, false, "paused"); observe(2, 5110, false);
  observe(3, 5090, false); observe(4, 5050, false); observe(5, 5000, false);
  assert.equal(coach.snapshot().completed, false); assert.equal(saved.map.size, 0);
  observe(5, 5000, true); observe(6, 5010, true); observe(6, 5010, false);
  observe(7, 4980, false); observe(8, 4940, false);
  assert.equal(coach.snapshot().completed, true);
  assert.equal(saved.getItem(boatCoachStorageKey("owner")), "done");
});
