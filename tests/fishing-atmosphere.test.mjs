import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { atmosphereAtHour, fishingSceneAtmosphere, fishingAmbientEvents, paintFishingAtmosphere, paintFishingSceneTint } =
  await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-atmosphere.ts");

const clock = hour => ({ now: Date.parse("2026-11-03T00:00:00Z") + hour * 3600000, timeZone: "UTC" });

test("river moods follow the profile timezone and blend continuously through every hour and midnight", () => {
  assert.equal(fishingSceneAtmosphere(clock(6.5)).phase, "dawn");
  assert.equal(fishingSceneAtmosphere(clock(12)).phase, "day");
  assert.equal(fishingSceneAtmosphere(clock(18.5)).phase, "sunset");
  assert.equal(fishingSceneAtmosphere(clock(23)).phase, "night");
  assert.equal(fishingSceneAtmosphere({ ...clock(3.5), timeZone: "Europe/Moscow" }).phase, "dawn");
  assert.equal(fishingSceneAtmosphere({ ...clock(3.5), timeZone: "invalid/zone" }).phase, "night");
  assert.equal(fishingSceneAtmosphere().phase, "day");
  for (let minute = 0; minute < 1440; minute++) {
    const first = atmosphereAtHour(minute / 60), next = atmosphereAtHour((minute + 1) / 60);
    assert.ok(Math.abs(first.dawn + first.day + first.sunset + first.night - 1) < 1e-10);
    for (const key of ["dawn", "day", "sunset", "night"]) {
      assert.ok(first[key] >= 0 && first[key] <= 1);
      assert.ok(Math.abs(next[key] - first[key]) < .022, `${key} cannot jump at an hour boundary`);
    }
  }
});

test("ambient events are sparse deterministic decorations outside gameplay and boat exclusions", () => {
  const exclusions = [{ x: 400, y: 250, width: 600, height: 300 }, { x: 1000, y: 400, width: 280, height: 260 }];
  const kinds = new Set(); let dayCount = 0;
  for (let tick = 0; tick < 1600; tick++) {
    const time = tick / 4, events = fishingAmbientEvents(1600, 900, time, clock(12), exclusions);
    assert.ok(events.length <= 4);
    dayCount += events.length;
    assert.deepEqual(events, fishingAmbientEvents(1600, 900, time, clock(12), exclusions));
    for (const event of events) {
      kinds.add(event.kind);
      assert.ok(Number.isFinite(event.x) && Number.isFinite(event.y) && event.opacity >= 0 && event.opacity <= 1);
      assert.ok(event.x >= 0 && event.x <= 1600 && event.y >= 0 && event.y <= 900);
      for (const rect of exclusions) assert.ok(event.x < rect.x || event.x > rect.x + rect.width || event.y < rect.y || event.y > rect.y + rect.height);
      assert.notEqual(event.kind, "firefly");
    }
    const night = fishingAmbientEvents(1600, 900, time, clock(23));
    for (const event of night) { kinds.add(event.kind); assert.notEqual(event.kind, "dragonfly"); }
  }
  assert.ok(dayCount / 1600 < .8, "decorations are not a constant particle field");
  assert.deepEqual([...kinds].sort(), ["bubbles", "distant-ripple", "dragonfly", "firefly", "leaf"]);
  assert.deepEqual(fishingAmbientEvents(100, 100, 50, clock(12), [{ x: -100, y: -100, width: 400, height: 400 }]), []);
  assert.deepEqual(fishingAmbientEvents(1600, 900, 0, clock(12)), [], "static reduced-motion clock has no scheduled event");
});

test("atmosphere painting is bounded and identical with a frozen scene clock", () => {
  const paint = (hour, time) => {
    const calls = [], gradient = { addColorStop(...args) { calls.push(["stop", ...args]); } };
    const context = new Proxy({ globalAlpha: 1 }, { get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") return (...args) => { calls.push([key, ...args]); return gradient; };
      return (...args) => calls.push([key, ...args]);
    } });
    paintFishingAtmosphere(context, 1600, 900, time, clock(hour));
    paintFishingSceneTint(context, 1600, 900, clock(hour));
    return calls;
  };
  for (const hour of [6.5, 12, 18.5, 23]) for (const time of [0, 17, 24, 33, 80]) {
    const calls = paint(hour, time);
    assert.ok(calls.length < 200);
    assert.deepEqual(calls, paint(hour, time));
    assert.ok(calls.flat().every(value => typeof value !== "number" || Number.isFinite(value)));
  }
  assert.notDeepEqual(paint(6.5, 0), paint(12, 0));
  assert.notDeepEqual(paint(18.5, 0), paint(23, 0));
});
