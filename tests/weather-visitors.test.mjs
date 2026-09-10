import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { weatherVisitorsAt, drawWeatherGround, drawWeatherAir } = await vite.ssrLoadModule("/features/world/weather-visitors.ts");
const { RAIN_END_SECONDS, RAIN_PERIOD_SECONDS, rainAt } = await vite.ssrLoadModule("/features/mochlik/habitat.ts");
const { FOREST_MAP } = await vite.ssrLoadModule("/features/world/map-manifest.ts");
const { pointInPolygon, homeToWorld, worldToHome } = await vite.ssrLoadModule("/features/world/map-layout.ts");
const stateAt = (ecologyTime, overrides = {}) => ({ elapsed: ecologyTime, ecologyTime, rain: rainAt(ecologyTime), dusk: 0, ...overrides });
const empty = { snail: null, frog: null, moths: [] };

test("rain visitors occur briefly after rain and retain the same poses in later weather cycles", () => {
  for (const time of [0, 100, RAIN_END_SECONDS - 10, RAIN_END_SECONDS, RAIN_END_SECONDS + 44, 500]) {
    assert.deepEqual(weatherVisitorsAt(stateAt(time)), empty, `quiet at ${time}`);
  }
  const time = RAIN_END_SECONDS + 20;
  const visitors = weatherVisitorsAt(stateAt(time));
  assert.ok(visitors.snail?.opacity > 0 && visitors.frog?.opacity > 0);
  assert.deepEqual(weatherVisitorsAt(stateAt(time + RAIN_PERIOD_SECONDS)), visitors);
  assert.deepEqual(weatherVisitorsAt(stateAt(time, { rain: .4 })), empty, "no post-rain wildlife while rain is visible");
  for (const age of [18.35, 25.35]) assert.ok(weatherVisitorsAt(stateAt(RAIN_END_SECONDS + age)).frog.lift > 3);
});

test("ground visitors remain on their authored grass and river bank and convert between cameras", () => {
  for (let age = 0; age < 44; age += .1) {
    const { snail, frog } = weatherVisitorsAt(stateAt(RAIN_END_SECONDS + age));
    if (snail) {
      assert.ok(pointInPolygon(snail, FOREST_MAP.clearing.walkable));
      const home = worldToHome(snail), restored = homeToWorld(home);
      assert.ok(Math.hypot(restored.x - snail.x, restored.y - snail.y) < 1e-8);
      assert.ok(Math.hypot(home.x - .5, home.y - .5) < .45, "snail is safely inside the home circle");
    }
    if (frog) for (const dx of [-4, 0, 4]) {
      assert.equal(pointInPolygon({ x: frog.x + dx, y: frog.y }, FOREST_MAP.water.hitArea), false, "frog feet stay on the river bank");
      assert.ok(frog.x >= 838 && frog.x <= 852 && frog.y >= 929 && frog.y <= 931);
    }
  }
});

test("moths visit only in brief dry-night windows and reduced motion omits every visitor", () => {
  const night = stateAt(100, { elapsed: 54, dusk: 1 });
  assert.equal(weatherVisitorsAt(night).moths.length, 2);
  for (const overrides of [{ elapsed: 30 }, { elapsed: 68 }, { dusk: 0 }, { dusk: .6 }, { rain: .1 }]) {
    assert.deepEqual(weatherVisitorsAt({ ...night, ...overrides }), empty);
  }
  for (const time of [100, RAIN_END_SECONDS + 20]) {
    const state = stateAt(time, { elapsed: 54, dusk: 1 });
    assert.deepEqual(weatherVisitorsAt(state, true), empty);
    const ctx = new Proxy({}, { get: () => () => assert.fail("reduced motion should not draw transient visitors") });
    drawWeatherGround(ctx, state, true); drawWeatherAir(ctx, state, true);
  }
  const lamp = FOREST_MAP.house.lamp;
  for (let elapsed = 48; elapsed < 66; elapsed += .1) for (const moth of weatherVisitorsAt({ ...night, elapsed }).moths) {
    assert.ok(moth.y < lamp.y - 2 || moth.x > lamp.x + lamp.width + 1, "moths orbit outside the lamp glass");
    assert.ok(pointInPolygon(moth, FOREST_MAP.house.hitArea), "night visitors stay near the house");
  }
});
