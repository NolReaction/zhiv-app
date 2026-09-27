import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestBushArtworkAvailable } = await vite.ssrLoadModule("/features/world/forest-bush-artwork.ts");
const { createForestGarden, gardenActionAvailable, growForestBerries } = await vite.ssrLoadModule("/features/world/forest-garden.ts");
const { createClearingActivity, requestClearingBush } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { compileWorldInteractions } = await vite.ssrLoadModule("/features/world/interaction-navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
function pendingScene() {
  const scene = structuredClone(TILED_WORLD); scene.bushes[0].imageId = "future-independent-shrub"; return scene;
}

test("baked legacy bushes stay available; an explicit image reference requires a matching covering object", () => {
  const scene = pendingScene(), bush = scene.bushes[0];
  assert.equal(forestBushArtworkAvailable(scene, bush), false);
  const legacy = { ...bush }; delete legacy.imageId;
  assert.equal(forestBushArtworkAvailable({ terrain: [] }, legacy), true);
  const placed = withPlacedBushArtwork(scene);
  assert.equal(forestBushArtworkAvailable(placed, placed.bushes[0]), true);
  const image = placed.terrain.find(item => item.id === bush.imageId);
  image.bounds.x += 400;
  assert.equal(forestBushArtworkAvailable(placed, placed.bushes[0]), false, "a shrub elsewhere cannot activate the stale contour");
  image.bounds.x = NaN;
  assert.equal(forestBushArtworkAvailable(placed, placed.bushes[0]), false);
});

test("pending artwork retains garden metadata but disables care and both navigation modes until placed", () => {
  const scene = pendingScene(), before = structuredClone(scene);
  const garden = createForestGarden(scene), interactions = compileWorldInteractions(scene);
  assert.equal(garden.bushes.length, 1); assert.deepEqual(garden.bushes[0].position, scene.bushes[0].entry);
  assert.equal(garden.bushes[0].workPosition, null);
  assert.equal(gardenActionAvailable(garden, "water-bush"), false);
  growForestBerries(garden); assert.equal(gardenActionAvailable(garden, "harvest-berries"), false);
  assert.equal(interactions.bushes.length, 0);
  assert.equal(interactions.diagnostics.find(item => item.id === scene.bushes[0].id).reason, "missing-bush-artwork");
  for (const navigationEnabled of [true, false]) {
    const clearing = createClearingActivity(scene); clearing.navigationEnabled = navigationEnabled;
    assert.equal(requestClearingBush(clearing), false);
    assert.equal(clearing.routes.some(route => route.activity === "bush"), false);
  }
  assert.deepEqual(scene, before, "gating never rewrites authored markers");
  const placed = withPlacedBushArtwork(scene), active = createForestGarden(placed);
  assert.ok(active.bushes[0].workPosition); assert.equal(gardenActionAvailable(active, "water-bush"), true);
  growForestBerries(active); assert.equal(gardenActionAvailable(active, "harvest-berries"), true);
  assert.equal(compileWorldInteractions(placed).bushes.length, 1);
  assert.ok(createClearingActivity(placed).routes.some(route => route.activity === "bush"));
});
