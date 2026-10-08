import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestPersistenceOverridden } = await vite.ssrLoadModule("/features/world/dev/forest-dev-memory.ts");
const { WORLD_DEV_DEFAULTS } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");

test("cooking rehearsal suspends account memory without changing the saved scene or default controls", () => {
  const original = structuredClone(WORLD_DEV_DEFAULTS);
  assert.equal(forestPersistenceOverridden(undefined, original.levels), false);
  assert.equal(forestPersistenceOverridden(WORLD_DEV_DEFAULTS, original.levels), false);
  for (const action of ["sequence", "prepare", "stir", "taste", "serve"]) {
    const dev = { ...WORLD_DEV_DEFAULTS, cookingPreview: Object.freeze({ id: 1, action, repeat: false }) };
    assert.equal(forestPersistenceOverridden(dev, original.levels), true, `${action} is never an account activity`);
    assert.equal(forestPersistenceOverridden({ ...dev, cookingPreview: null }, original.levels), false);
  }
  assert.deepEqual(WORLD_DEV_DEFAULTS, original);
});

test("water decoration and inspection preferences do not replace the actor's real memories", () => {
  const dev = { ...WORLD_DEV_DEFAULTS, waterFish: "on", waterBreeze: false, debugWater: true,
    debugNavigation: true, cameraEvent: { id: 1, action: "overview" } };
  assert.equal(forestPersistenceOverridden(dev, WORLD_DEV_DEFAULTS.levels), false);
  assert.equal(forestPersistenceOverridden({ ...dev, weather: "downpour" }, WORLD_DEV_DEFAULTS.levels), true,
    "forced conditions that change the actor's decisions still suspend memory");
});


test("builder animation cannot save synthetic memories; camera and direction alone are inspection", () => {
  const inspection = { ...WORLD_DEV_DEFAULTS, builderDirection: "back", cameraEvent: { id: 1, action: "builder" } };
  assert.equal(forestPersistenceOverridden(inspection, WORLD_DEV_DEFAULTS.levels), false);
  assert.equal(forestPersistenceOverridden({ ...inspection,
    builderPreview: { id: 1, action: "finish", direction: "back", repeat: true } }, WORLD_DEV_DEFAULTS.levels), true);
});
