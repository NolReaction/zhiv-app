import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { residentNightRest, residentEveningActive } = await vite.ssrLoadModule("/features/world/characters/resident-evening-routine.ts");
const { habitatLocalHour } = await vite.ssrLoadModule("/features/mochlik/lighting.ts");
const { forestLighthouseFrame } = await vite.ssrLoadModule("/features/world/environment/lighting/forest-lighthouse.ts");
const ids = ["lopukh", "kamneshmyg", "leaftail", "plesk", "builder"];

test("profile hours are quantized in the selected timezone, including midnight and DST", () => {
  assert.equal(habitatLocalHour(Date.parse("2026-10-18T18:01:00Z"), "Europe/Moscow"), 21);
  assert.equal(habitatLocalHour(Date.parse("2026-10-18T18:59:59Z"), "Europe/Moscow"), 21);
  assert.equal(habitatLocalHour(Date.parse("2026-10-18T21:00:00Z"), "Europe/Moscow"), 0);
  assert.equal(habitatLocalHour(Date.parse("2026-11-01T05:30:00Z"), "America/New_York"), 1);
  assert.equal(habitatLocalHour(Date.parse("2026-11-01T06:30:00Z"), "America/New_York"), 1);
});

test("evening rests are staggered, substantial and deterministic throughout repeated seven-minute cycles", () => {
  const outside = Object.fromEntries(ids.map(id => [id, 0]));
  const transitions = Object.fromEntries(ids.map(id => [id, 0]));
  for (let elapsed = 0; elapsed < 840; elapsed++) {
    const resting = ids.map(id => residentNightRest(id, elapsed, 1, 21));
    assert.ok(resting.some(value => !value), `at ${elapsed}s someone is free for outdoor activity`);
    ids.forEach((id, index) => {
      assert.equal(resting[index], residentNightRest(id, elapsed + 840, 1, 21), "reading/repeating a clock never changes the plan");
      assert.equal(residentEveningActive(id, elapsed, 1, 21), !resting[index]);
      if (!resting[index]) outside[id]++;
      if (elapsed > 0 && resting[index] !== residentNightRest(id, elapsed - 1, 1, 21)) transitions[id]++;
    });
  }
  for (const id of ids) {
    assert.ok(outside[id] >= 360 && outside[id] <= 600, `${id} has real outdoor time and rest`);
    assert.equal(transitions[id], 4, `${id} changes plan only four times in fourteen minutes`);
    for (const hour of [0, 2, 5, 6]) assert.equal(residentNightRest(id, 0, 1, hour), true, "deep night keeps sleep");
    assert.equal(residentNightRest(id, 0, 1), true, "explicit night simulations retain night behaviour");
    assert.equal(residentNightRest(id, 200, 0, 21), false, "day preview does not inherit an evening rest");
  }
});

test("beacon holds its heading, fades before a hidden return and uses an occasional weaker counterbeam", () => {
  assert.equal(forestLighthouseFrame(29, false).angle, forestLighthouseFrame(35, false).angle);
  assert.equal(forestLighthouseFrame(69, false).angle, forestLighthouseFrame(75, false).angle);
  assert.equal(forestLighthouseFrame(43, false).strength, 0);
  assert.equal(forestLighthouseFrame(83, false).strength, 0);
  assert.ok(forestLighthouseFrame(12, false).counter > 0);
  assert.equal(forestLighthouseFrame(56, false).counter, 0);
  let previous = forestLighthouseFrame(0, false);
  for (let index = 1; index <= 8400; index++) {
    const frame = forestLighthouseFrame(index / 100, false);
    assert.ok(Math.abs(frame.strength - previous.strength) < .004);
    assert.ok(Math.abs(frame.counter - previous.counter) < .004);
    assert.ok(Math.abs(frame.angle - previous.angle) < .02, "heading also remains continuous during the dark return");
    assert.ok(frame.strength >= 0 && frame.strength <= .82);
    assert.ok(frame.counter <= frame.strength);
    previous = frame;
  }
  assert.deepEqual(forestLighthouseFrame(0, false), forestLighthouseFrame(84, false));
  assert.deepEqual(forestLighthouseFrame(12, false), forestLighthouseFrame(12, false), "pause is a read of the same frame");
  assert.deepEqual(forestLighthouseFrame(12, true), forestLighthouseFrame(500, true), "reduced motion has no sweep, fade or flashing");
  assert.deepEqual(forestLighthouseFrame(Infinity, false), forestLighthouseFrame(0, true));
});
