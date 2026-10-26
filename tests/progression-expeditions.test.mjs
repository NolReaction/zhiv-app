import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingExpectedReturn, expeditionExpectedReturns } = await vite.ssrLoadModule("/features/progression/economy-expeditions.ts");
const { planEconomyProduction } = await vite.ssrLoadModule("/features/progression/economy-plan.ts");
const { buildProgressionEconomy } = await vite.ssrLoadModule("/features/progression/economy-data.ts");

test("fishing expected value uses class odds and every actual draw without inventing a guaranteed species", () => {
  const catalog = structuredClone(economyCatalog), routeId = catalog.fishing.routeIds[0];
  const report = fishingExpectedReturn({ routeId, rodId: "reed_rod", hookId: "bare_hook", baitId: null }, catalog);
  assert(report);
  assert.equal(report.draws, catalog.fishing.collectionDrawsByRoute[routeId]);
  assert(Math.abs(report.species.reduce((sum, fish) => sum + fish.probability, 0) - 1) < 1e-12);
  assert(Math.abs(report.species.reduce((sum, fish) => sum + fish.expectedQuantity, 0) - report.draws) < 1e-12);
  assert(report.species.some(fish => fish.probability === 0));
  for (const fish of report.species) assert(Math.abs(fish.atLeastOneProbability - (1 - (1 - fish.probability) ** report.draws)) < 1e-12);
  assert.equal(report.expectedNetCoins, report.expectedGrossCoins - report.costCoins);
  assert.equal(report.expectedNetCoinsPerMinute, report.expectedNetCoins * 60 / report.seconds);
  const target = catalog.recipes.find(recipe => recipe.fishInput?.exactSpecies);
  const plan = planEconomyProduction({ targets: target.rewards }, catalog);
  assert.equal(plan.complete, false); assert.equal(plan.elapsedSeconds, null);
});

test("chance finds change expected value but never become guaranteed planner output", () => {
  const catalog = structuredClone(economyCatalog), route = catalog.explorations.find(route => !route.retired && !catalog.fishing.routeIds.includes(route.id));
  route.finds = { emptyWeight: 50, entries: [{ itemId: "ceramic_jar", quantity: 2, weight: 25 }, { itemId: "glass_bottle", quantity: 1, weight: 25 }] };
  const report = expeditionExpectedReturns(catalog).find(value => value.id === route.id);
  assert.equal(report.emptyProbability, .5); assert.equal(report.finds[0].probability, .25);
  const jar = catalog.items.find(item => item.id === "ceramic_jar"), bottle = catalog.items.find(item => item.id === "glass_bottle");
  assert.equal(report.expectedBonusCoins, .25 * (2 * jar.baseSellPrice + bottle.baseSellPrice));
  catalog.recipes = catalog.recipes.filter(recipe => !recipe.rewards.ceramic_jar);
  const plan = planEconomyProduction({ targets: { ceramic_jar: 1 } }, catalog);
  assert.equal(plan.complete, false); assert.equal(plan.elapsedSeconds, null);
  const source = buildProgressionEconomy(catalog).items.find(item => item.id === "ceramic_jar").sources.find(source => source.id.startsWith(`find:${route.id}:`));
  assert(source); assert.equal(source.guaranteed, false); assert.equal(source.rewards, undefined);
});
