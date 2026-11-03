import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingUnderwaterLife, paintFishingUnderwaterLife } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-schools.ts");
const { fishingSceneGeometry, fishingSceneSceneryExclusions } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
const { fishingIslandLayout } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-islands.ts");
const frame = { stage: "soaking", sceneKey: "voyage-river-12", castKey: "cast-2", fishRarity: "rare", biteLeadSeconds: 3,
  held: false, boat: { repaired: true, upgrades: [] }, ambience: { now: Date.UTC(2026, 10, 4, 12), timeZone: "UTC" } };
const visual = { elapsed: 12, stageElapsed: 2, still: false };
const geometry = { fish: { x: 1320, y: 290 }, hook: { x: 1300, y: 320 }, waterTop: 80, waterBottom: 640 };
const life = (changes = {}, view = visual, g = geometry, exclusions = []) => fishingUnderwaterLife(1600, 900, { ...frame, ...changes }, view, g, exclusions);

test("underwater shoals remain bounded, deterministic and tied to the voyage rather than the cast or reward", () => {
  const original = life(), repeated = life();
  assert.deepEqual(repeated, original); assert.ok(original.schools.length >= 6 && original.schools.length <= 18);
  assert.deepEqual(life({ castKey: "other-cast", biteLeadSeconds: 8 }).schools, original.schools);
  assert.notDeepEqual(life({ sceneKey: "another-voyage" }).schools, original.schools);
  assert.notDeepEqual(life({}, { ...visual, elapsed: 20 }).schools, original.schools);
  assert.deepEqual(life({ fishId: "fish_shark", fishSizeScale: 5, seed: 123, privateDraw: ["fish_shark"] }), original);
  for (const fish of original.schools) {
    assert.ok(Object.values(fish).every(Number.isFinite));
    assert.ok(fish.x > 0 && fish.x < 1600 && fish.y > 26 && fish.y < 874);
    assert.ok(fish.size >= 11.25 && fish.size <= 19 && fish.opacity > 0 && fish.opacity <= .5);
    assert.ok(Math.abs(fish.tail) <= .42);
  }
});

test("members follow a coherent shared heading, without decorative silhouettes entering the real target corridor or obstacles", () => {
  const clearGeometry = { ...geometry, hook: { x: 800, y: 320 } };
  const result = life({}, visual, clearGeometry, [{ x: 20, y: 120, width: 450, height: 450 }]);
  assert.ok(result.schools.length > 0);
  for (const fish of result.schools) {
    assert.ok(fish.x > 470 + fish.size * .82 || fish.y < 120 - fish.size * .82 || fish.y > 570 + fish.size * .82);
    assert.ok(fish.x < clearGeometry.hook.x - 86 - fish.size * .82 || fish.x > clearGeometry.hook.x + 86 + fish.size * .82);
    const siblings = result.schools.filter(value => value.school === fish.school);
    for (const sibling of siblings) {
      assert.ok(Math.abs(sibling.angle - fish.angle) < .06);
      assert.ok(Math.hypot(sibling.x - fish.x, sibling.y - fish.y) < 145);
    }
  }
  assert.equal(life({}, visual, geometry, [{ x: 0, y: 0, width: 1600, height: 900 }]).schools.length, 0);
});

test("the anonymous approaching fish meets the public target at the bite and never duplicates the hooked fish", () => {
  assert.equal(life({ biteLeadSeconds: 7 }).approach, null);
  assert.equal(life({ biteLeadSeconds: 4.8 }).approach, null);
  let previousDistance = Infinity;
  for (const lead of [4.5, 3.5, 2.5, 1.5, .5, 0]) {
    const approach = life({ biteLeadSeconds: lead }).approach;
    assert.ok(approach && approach.opacity > 0 && approach.opacity <= 1);
    const distance = Math.hypot(approach.point.x - geometry.fish.x, approach.point.y - geometry.fish.y);
    assert.ok(distance < previousDistance); previousDistance = distance;
  }
  assert.deepEqual(life({ biteLeadSeconds: 0 }).approach.point, geometry.fish);
  for (const stage of ["waiting", "casting", "bite", "reeling", "paused", "caught", "landed", "escaped", "pending", "expired"])
    assert.equal(life({ stage, biteLeadSeconds: 0 }).approach, null);
  assert.equal(life({ castKey: undefined }).approach, null);
  assert.equal(life({ biteLeadSeconds: undefined }).approach, null);
  assert.equal(life({ biteLeadSeconds: Number.NaN }).approach, null);
  assert.equal(life({ biteLeadSeconds: -1 }).approach, null);
  assert.equal(life({}, visual, geometry, [{ x: 1200, y: 80, width: 300, height: 560 }]).approach, null);
});

test("day and evening produce gradual differences in shoal visibility while reduced motion freezes all swimming", () => {
  const noon = life({ biteLeadSeconds: 8 }), sunset = life({ biteLeadSeconds: 8, ambience: { now: Date.UTC(2026, 10, 4, 18, 30), timeZone: "UTC" } });
  assert.ok(sunset.schools.some(fish => fish.school === 2)); assert.ok(!noon.schools.some(fish => fish.school === 2));
  assert.notDeepEqual(noon.schools, sunset.schools);
  const still = life({}, { ...visual, still: true });
  assert.deepEqual(life({}, { ...visual, still: true, elapsed: 1234, stageElapsed: 500 }), still);
  assert.ok(still.schools.every(fish => fish.tail === 0)); assert.deepEqual(still.approach.point, geometry.fish);
  assert.deepEqual(fishingUnderwaterLife(0, 900, frame, visual, geometry), { schools: [], approach: null });
  assert.deepEqual(fishingUnderwaterLife(1600, 900, frame, visual, { ...geometry, waterBottom: -1 }), { schools: [], approach: null });
});

test("painting decorative life preserves inputs and never reads a hidden exact species", () => {
  const calls = [], context = new Proxy({ globalAlpha: 1 }, { get(value, key) { return key in value ? value[key] : (...args) => calls.push({ key, args }); } });
  const input = { ...frame, fishId: "fish_shark", fishSizeScale: 5 }, before = structuredClone({ input, visual, geometry });
  paintFishingUnderwaterLife(context, 1600, 900, input, visual, geometry);
  assert.deepEqual({ input, visual, geometry }, before);
  assert.ok(calls.some(call => call.key === "ellipse"));
  for (const call of calls) for (const arg of call.args) if (typeof arg === "number") assert.ok(Number.isFinite(arg));
  const paint = fishRarity => {
    const output = [], ctx = new Proxy({ globalAlpha: 1 }, { get(value, key) { return key in value ? value[key] : (...args) => output.push({ key, args }); } });
    paintFishingUnderwaterLife(ctx, 1600, 900, { ...input, fishRarity }, visual, geometry);
    return output;
  };
  assert.deepEqual(paint("common"), paint("legendary"), "neither the school nor approaching shadow can disclose the hooked class");
});

test("the anonymous approach dives briefly at the bite and is hidden for the whole reel", () => {
  const first = life({ stage: "bite" }, { ...visual, stageElapsed: 0 }).approach;
  const sinking = life({ stage: "bite" }, { ...visual, stageElapsed: .25 }).approach;
  assert.ok(first && sinking); assert.deepEqual(first.point, geometry.fish);
  assert.ok(sinking.point.y > first.point.y); assert.ok(sinking.opacity < first.opacity);
  assert.equal(life({ stage: "bite" }, { ...visual, stageElapsed: .45 }).approach, null);
  assert.equal(life({ stage: "reeling" }, { ...visual, stageElapsed: .1 }).approach, null);
  assert.equal(life({ stage: "bite" }, { ...visual, stageElapsed: .1, still: true }).approach, null);
});


test("the real voyage layouts keep the approach visible beside the hull across phone and desktop compositions", () => {
  for (const [width, height] of [[320, 568], [390, 844], [1280, 720], [1920, 1080]]) {
    for (let voyage = 0; voyage < 12; voyage++) {
      const value = { ...frame, sceneKey: `voyage-${voyage}`, biteLeadSeconds: 0,
        reel: { bar: 5000, fish: 5000, progress: 2500, zoneWidth: 3200 } };
      const g = fishingSceneGeometry(width, height, value, visual), excluded = fishingSceneSceneryExclusions(g);
      const islands = fishingIslandLayout(g.width, g.height, value.sceneKey, excluded.islands);
      const life = fishingUnderwaterLife(g.width, g.height, value, visual, g, [...excluded.life, ...islands], [...excluded.hud, ...islands]);
      assert.ok(life.approach, `the bite approach exists at ${width}x${height}, voyage ${voyage}`);
      assert.equal(life.approach.opacity, 1, `the hull's padded envelope cannot fade the endpoint at ${width}x${height}, voyage ${voyage}`);
      assert.deepEqual(life.approach.point, g.fish);
      assert.ok(life.schools.length >= 4, `a complete visible shoal remains at ${width}x${height}, voyage ${voyage}`);
      const minimumBodyWidth = width >= 700 ? 14 : 8;
      const readable = life.schools.filter(shadow => shadow.opacity >= .22 && shadow.size * g.scale * 1.28 >= minimumBodyWidth);
      assert.ok(readable.length >= 4, `at least one shoal is readable in CSS pixels at ${width}x${height}, voyage ${voyage}`);
      for (const shadow of life.schools) {
        const rect = excluded.boat, extent = shadow.size * .82;
        assert.ok(shadow.x < rect.x - extent || shadow.x > rect.x + rect.width + extent || shadow.y < rect.y - extent || shadow.y > rect.y + rect.height + extent);
      }
    }
  }
});

test("separate approach exclusions do not disable land protection or change the school output", () => {
  const boatEnvelope = [{ x: 1200, y: 200, width: 250, height: 300 }];
  const defaultProtected = fishingUnderwaterLife(1600, 900, { ...frame, biteLeadSeconds: 0 }, visual, geometry, boatEnvelope);
  const besideHull = fishingUnderwaterLife(1600, 900, { ...frame, biteLeadSeconds: 0 }, visual, geometry, boatEnvelope, []);
  assert.equal(defaultProtected.approach, null);
  assert.equal(besideHull.approach.opacity, 1); assert.deepEqual(besideHull.schools, defaultProtected.schools);
  const landProtected = fishingUnderwaterLife(1600, 900, { ...frame, biteLeadSeconds: 0 }, visual, geometry, boatEnvelope,
    [{ x: 1250, y: 200, width: 160, height: 160 }]);
  assert.equal(landProtected.approach, null); assert.deepEqual(landProtected.schools, besideHull.schools);
});


test("actual poster compositions preserve a visible complete shoal throughout its swim, across civil-time moods", () => {
  for (const [width, height] of [[320, 568], [390, 844], [1280, 720], [1920, 1080]]) {
    for (const [sceneKey, hour] of [["voyage-day-variant", 12], ["voyage-evening-variant", 18.5], ["voyage-night-variant", 22]]) {
      const value = { ...frame, stage: "waiting", sceneKey, biteLeadSeconds: undefined,
        ambience: { now: Date.UTC(2026, 10, 4, Math.floor(hour), hour % 1 * 60), timeZone: "UTC" } };
      for (const elapsed of [0, 4.7, 13.1, 18.3, 900]) {
        const v = { ...visual, elapsed }, g = fishingSceneGeometry(width, height, value, v), excluded = fishingSceneSceneryExclusions(g);
        const islands = fishingIslandLayout(g.width, g.height, sceneKey, excluded.islands);
        const result = fishingUnderwaterLife(g.width, g.height, value, v, g, [...excluded.life, ...islands], [...excluded.hud, ...islands]);
        const counts = new Map();
        for (const fish of result.schools) counts.set(fish.school, (counts.get(fish.school) ?? 0) + 1);
        assert.ok([...counts.values()].some(count => count >= 4), `${sceneKey}, ${width}x${height}, t=${elapsed} has a full visible shoal`);
        assert.ok(result.schools.length <= 15);
      }
    }
  }
});

test("actual scene shoals travel visibly at CSS scale rather than appearing stationary between casts", () => {
  for (const [width, height] of [[320, 568], [390, 844], [1280, 720], [1920, 1080]]) {
    const value = { ...frame, stage: "waiting", sceneKey: "visible-swim", biteLeadSeconds: undefined };
    const g = fishingSceneGeometry(width, height, value, visual), excluded = fishingSceneSceneryExclusions(g);
    const islands = fishingIslandLayout(g.width, g.height, value.sceneKey, excluded.islands), positions = [];
    for (const elapsed of [0, 2, 4, 6, 8, 10]) {
      const result = fishingUnderwaterLife(g.width, g.height, value, { ...visual, elapsed }, g,
        [...excluded.life, ...islands], [...excluded.hud, ...islands]);
      const fish = result.schools.find(shadow => shadow.school === 0 && shadow.member === 0);
      assert.ok(fish); positions.push(fish.x * g.scale);
    }
    assert.ok(Math.max(...positions) - Math.min(...positions) >= 8, `a shoal crosses a visible body length at ${width}x${height}`);
  }
});
