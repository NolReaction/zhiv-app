import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { FISH_PATROLS, WATER_RIPPLES, fishPose } = await vite.ssrLoadModule("/features/world/water-ambience.ts");
const { mapPlaceAt } = await vite.ssrLoadModule("/features/world/map-layout.ts");

test("fish bodies and fins stay underwater for their entire patrol", () => {
  for (const patrol of FISH_PATROLS) {
    for (let step = 0; step <= 360; step++) {
      const pose = fishPose(patrol, patrol.period * step / 360);
      for (const x of [-10, 0, 7]) for (const y of [-5, 0, 5]) {
        const point = { x: pose.x + (x * Math.cos(pose.angle) - y * Math.sin(pose.angle)) * patrol.scale,
          y: pose.y + (x * Math.sin(pose.angle) + y * Math.cos(pose.angle)) * patrol.scale };
        assert.equal(mapPlaceAt(point), "fishing", `patrol ${patrol.x},${patrol.y}, step ${step}`);
      }
    }
    const first = fishPose(patrol, 0), last = fishPose(patrol, patrol.period);
    assert.ok(Math.hypot(first.x - last.x, first.y - last.y) < 1e-8, "no teleport at loop boundary");
  }
});

test("expanding ripples remain inside the shoreline", () => {
  for (const ripple of WATER_RIPPLES) for (let step = 0; step < 36; step++) {
    const angle = step * Math.PI / 18;
    assert.equal(mapPlaceAt({ x: ripple.x + Math.cos(angle) * 14, y: ripple.y + Math.sin(angle) * 5 }), "fishing");
  }
});
