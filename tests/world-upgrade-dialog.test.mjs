import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { worldUpgradeUnlocks } = await vite.ssrLoadModule("/features/economy/world-upgrade-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
after(() => vite.close());

function unlocks(stationId, level, catalog = economyCatalog) {
  const target = catalog.buildings.find(building => building.id === stationId).levels.find(target => target.level === level);
  return worldUpgradeUnlocks({ catalog }, stationId, target);
}

test("house 2 explains the mine, workshop kiln, exploration and player market together", () => {
  const result = unlocks("home", 2);
  assert.ok(result.upgrades.some(target => target.stationId === "quarry" && target.level === 1));
  assert.ok(result.upgrades.some(target => target.stationId === "kiln" && target.level === 1));
  assert.ok(result.recipes.some(recipe => recipe.id === "smelt_iron"));
  assert.ok(result.routes.some(route => route.id === "cave"));
  assert.equal(result.market, true);
  assert.ok(!result.upgrades.some(target => target.stationId === "home"));
  assert.ok(!result.upgrades.some(target => target.level === 3));
  assert.equal(unlocks("home", 3).market, false);
});

test("equipment upgrades include their recipes and dependent world progression", () => {
  const result = unlocks("workshop", 2);
  assert.deepEqual(result.recipes.map(recipe => recipe.id), ["make_metal_parts", "weave_cloth", "workshop_overnight"]);
  assert.ok(result.routes.some(route => route.id === "old_woodland"));
  assert.ok(result.upgrades.some(target => target.stationId === "home" && target.level === 3));
  assert.equal(result.market, false);
  assert.deepEqual(unlocks("garden", 2).recipes.map(recipe => recipe.id), ["grow_berries_large", "garden_fiber"]);
});

test("pantry development has real dependent upgrades even though it has no recipes", () => {
  const result = unlocks("warehouse", 2);
  assert.equal(result.recipes.length, 0);
  assert.equal(result.routes.length, 0);
  assert.ok(result.upgrades.some(target => target.stationId === "home" && target.level === 3));
  assert.ok(!result.upgrades.some(target => target.stationId === "warehouse"));
});

test("the highest catalog requirement wins, so a recipe is not promised one level too early", () => {
  const catalog = structuredClone(economyCatalog);
  const recipe = catalog.recipes.find(recipe => recipe.id === "grow_berries_large");
  recipe.requiredBuildings.home = 3;
  assert.ok(!unlocks("home", 2, catalog).recipes.some(entry => entry.id === recipe.id));
  assert.ok(unlocks("home", 3, catalog).recipes.some(entry => entry.id === recipe.id));
});
