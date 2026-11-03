import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingWaterEvents, paintFishingWaterEvents } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-water-events.ts");
const { fishingSceneGeometry, fishingSceneSceneryExclusions } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
const { fishingIslandLayout } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-islands.ts");
const noon = { now: Date.UTC(2026, 10, 4, 12), timeZone: "UTC" };
const night = { now: Date.UTC(2026, 10, 4, 23), timeZone: "UTC" };
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test("water events are sparse, repeatable and start promptly without consulting any fishing draw", () => {
  const kinds = new Set(), starts = [];
  for (let voyage = 0; voyage < 20; voyage++) {
    const key = `river-${voyage}`, found = [];
    for (let time = 0; time <= 200; time += .2) {
      const events = fishingWaterEvents(1600, 900, time, key, noon);
      assert.ok(events.length <= 1); assert.deepEqual(events, fishingWaterEvents(1600, 900, time, key, noon));
      if (events.length) { kinds.add(events[0].kind); found.push(time); }
    }
    starts.push(found[0]); assert.ok(found[0] >= 8 && found[0] <= 12.2);
    assert.ok(found.length < 220, "most of the river time remains quiet");
  }
  assert.equal(kinds.size, 4); assert.ok(new Set(starts.map(value => Math.round(value))).size >= 3);
  assert.deepEqual(fishingWaterEvents(1600, 900, 0, "river", noon), []);
});

test("whole event paths avoid controls, hull and shore instead of clipping only a current point", () => {
  const excluded = [{ x: 0, y: 0, width: 1600, height: 140 }, { x: 200, y: 200, width: 700, height: 340 },
    { x: 1050, y: 180, width: 220, height: 420 }, { x: 450, y: 650, width: 700, height: 250 }];
  let visible = 0, activeTime;
  for (let time = 0; time < 300; time += .5) for (const event of fishingWaterEvents(1600, 900, time, "protected", noon, excluded)) {
    visible++; activeTime = time;
    assert.ok(event.bounds.x >= 0 && event.bounds.y >= 0 && event.bounds.x + event.bounds.width <= 1600 && event.bounds.y + event.bounds.height <= 900);
    for (const rect of excluded) assert.equal(overlaps(event.bounds, rect), false);
  }
  assert.ok(visible > 20);
  assert.ok(fishingWaterEvents(1600, 900, activeTime, "protected", noon).length > 0);
  assert.deepEqual(fishingWaterEvents(1600, 900, activeTime, "protected", noon, [{ x: 0, y: 0, width: 1600, height: 900 }]), []);
});

test("night has no sun dart and invalid/static clocks cannot produce malformed decoration", () => {
  let nightCount = 0, changed = false;
  for (let time = 0; time < 250; time += .5) {
    const dayEvents = fishingWaterEvents(1000, 2164, time, "night-river", noon);
    const nightEvents = fishingWaterEvents(1000, 2164, time, "night-river", night);
    for (const event of nightEvents) { nightCount++; assert.notEqual(event.kind, "sun-dart"); }
    changed ||= JSON.stringify(dayEvents) !== JSON.stringify(nightEvents);
  }
  assert.ok(nightCount > 0 && changed);
  for (const value of [NaN, Infinity, -1]) {
    assert.deepEqual(fishingWaterEvents(1600, 900, value, "invalid", noon), []);
    assert.deepEqual(fishingWaterEvents(value, 900, 10, "invalid", noon), []);
    assert.deepEqual(fishingWaterEvents(1600, value, 10, "invalid", noon), []);
  }
  assert.deepEqual(fishingWaterEvents(50, 50, 10, "small", noon), []);
});

test("all event painters stay finite, bounded and preserve their public inputs", () => {
  const calls = [], ctx = new Proxy({ globalAlpha: 1 }, { get(value, key) { return key in value ? value[key] : (...args) => calls.push({ key, args }); } });
  const excluded = [{ x: 0, y: 0, width: 100, height: 100 }], before = structuredClone({ noon, excluded });
  for (let time = 0; time < 220; time += .25) paintFishingWaterEvents(ctx, 1600, 900, time, "paint-river", noon, excluded);
  assert.deepEqual({ noon, excluded }, before); assert.ok(calls.some(call => call.key === "ellipse"));
  assert.ok(calls.length < 100000);
  for (const call of calls) for (const arg of call.args) if (typeof arg === "number") assert.ok(Number.isFinite(arg));
});

test("real voyage geometry leaves visible nature events on phone, short landscape and desktop", () => {
  for (const [width, height] of [[320, 568], [390, 844], [820, 390], [1280, 720], [1920, 1080]]) {
    for (let voyage = 0; voyage < 5; voyage++) {
      const sceneKey = `voyage-${voyage}`, frame = { stage: "waiting", sceneKey, held: false,
        boat: { repaired: true, upgrades: [] }, ambience: noon };
      const visual = { elapsed: 0, castElapsed: 2, stageElapsed: 2, still: false };
      const geometry = fishingSceneGeometry(width, height, frame, visual), blocked = fishingSceneSceneryExclusions(geometry);
      const islands = fishingIslandLayout(geometry.width, geometry.height, sceneKey, blocked.islands);
      const excluded = [...blocked.life, blocked.play, ...islands];
      let visible = 0, previous = null;
      for (let elapsed = 0; elapsed <= 120; elapsed += .5) {
        const events = fishingWaterEvents(geometry.width, geometry.height, elapsed, sceneKey, noon, excluded);
        assert.ok(events.length <= 1);
        if (!events.length) previous = null;
        for (const event of events) {
          for (const rect of excluded) assert.equal(overlaps(event.bounds, rect), false);
          if (event.opacity > .1) visible++;
          if (previous) {
            assert.equal(event.kind, previous.kind); assert.deepEqual(event.bounds, previous.bounds);
            assert.equal(event.size, previous.size);
          }
          previous = event;
        }
      }
      assert.ok(visible >= 3, `${width}x${height}, ${sceneKey} has a readable event within two minutes`);
    }
  }
});
