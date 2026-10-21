import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { earthMapAvailable } = await vite.ssrLoadModule("/features/app/earth-map-availability.ts");
after(() => vite.close());

test("the public map survives gameplay reconnection and browser visibility changes", () => {
  for (const mode of ["active", "connecting", "offline", "error", "hidden"]) {
    assert.equal(earthMapAvailable({ mode, startupActive: false, covered: false }), true, mode);
  }
});

test("startup, an explicit AFK pause and covering game screens still release the map", () => {
  assert.equal(earthMapAvailable({ mode: "away", startupActive: false, covered: false }), false);
  for (const mode of ["active", "connecting", "offline", "error", "hidden", "away"]) {
    assert.equal(earthMapAvailable({ mode, startupActive: true, covered: false }), false);
    assert.equal(earthMapAvailable({ mode, startupActive: false, covered: true }), false);
  }
});
