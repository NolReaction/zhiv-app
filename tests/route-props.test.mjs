import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { ROUTE_TORCHES, ROUTE_SEGMENTS, TORCH_RADIUS, drawRouteLights } = await vite.ssrLoadModule("/features/world/route-props.ts");
const { HOME_AREA, MAP_SIZE, mapPlaceAt } = await vite.ssrLoadModule("/features/world/map-layout.ts");

test("route markers stay on land and torch light does not clip at the home tile", () => {
  for (const at of ROUTE_SEGMENTS.flat()) {
    assert.ok(at.x >= 0 && at.y >= 0 && at.x <= MAP_SIZE && at.y <= MAP_SIZE);
    assert.notEqual(mapPlaceAt(at), "fishing", "route ends on the bank");
  }
  for (const at of ROUTE_TORCHES) {
    assert.notEqual(mapPlaceAt(at), "fishing");
    const dx = Math.max(HOME_AREA.x - at.x, 0, at.x - HOME_AREA.x - HOME_AREA.size);
    const dy = Math.max(HOME_AREA.y - (at.y - 20), 0, at.y - 20 - HOME_AREA.y - HOME_AREA.size);
    assert.ok(Math.hypot(dx, dy) > TORCH_RADIUS, "torch pool remains outside detailed tile");
  }
});

test("daytime torches emit nothing; reduced motion draws identical still flames", () => {
  const render = (night, time, reduced) => {
    const draws = [];
    const ctx = new Proxy({ fillRect: (...args) => draws.push(args), createRadialGradient: () => ({ addColorStop() {} }) },
      { get: (object, key) => key in object ? object[key] : () => {} });
    drawRouteLights(ctx, night, time, reduced); return draws;
  };
  assert.deepEqual(render(0, 20, false), []);
  assert.ok(render(1, 20, true).length > 0);
  assert.deepEqual(render(1, 20, true), render(1, 123, true));
});
