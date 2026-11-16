import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog, economyCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { recipeUnlockRequirements, recipeUnlocksMet, personallyCaughtFish } = await vite.ssrLoadModule("/features/economy/domain/recipe-unlock.ts");
const { obtainableResidentOrderItems } = await vite.ssrLoadModule("/features/economy/domain/order-effort.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const unlocks = {
  grow_strawberries: { cook_compote: 1 },
  cook_fish_soup: { cook_grilled_fish: 1 },
};
const recipe = id => catalog.recipes.find(row => row.id === id);
const mastered = field => catalog.recipes.reduce((all, row) => {
  for (const [id, count] of Object.entries(row[field] ?? {})) all[id] = Math.max(all[id] ?? 0, count);
  return all;
}, {});
const apply = (state, action, targetId, at = now, quantity = 1) => rules.applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
  action, targetId, quantity, totalPrice: 0,
}, at, () => crypto.randomUUID());
const supplied = (target, prerequisite = null, count = 1) => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.inventory = Object.fromEntries(catalog.items.map(item => [item.id, 4]));
  state.wallet.coins = 100_000;
  // Every other condition is met; this particular skill still needs one claimed result.
  state.progression.recipes = { ...mastered("requiredRecipes"), ...(prerequisite ? { [prerequisite]: count - 1 } : {}) };
  state.progression.routes = mastered("requiredExplorations");
  state.fishing.catches = { [catalog.fishing.fish[0].itemId]: recipe(target).requiredFishCaught };
  return state;
};
const locked = (state, target, at = now) => {
  const before = structuredClone(state);
  assert.throws(() => apply(state, "start_production", target, at), { code: "ECONOMY_RECIPE_REQUIRED" });
  assert.deepEqual(state, before, "a locked recipe spends nothing and does not alter active jobs");
};

for (const [target, required] of Object.entries(unlocks)) for (const [prerequisite, count] of Object.entries(required)) {
  test(`${target} opens only after personally claiming ${prerequisite}`, () => {
    const state = supplied(target, prerequisite, count);
    assert.deepEqual(recipe(target).requiredRecipes, required);
    // The inventory already contains every output: buying or receiving it is not mastery.
    locked(state, target);
    apply(state, "start_production", prerequisite);
    const job = state.jobs[0], readyAt = Date.parse(job.finishesAt);
    locked(state, target, readyAt);
    apply(state, "claim_job", job.id, readyAt);
    assert.equal(state.progression.recipes[prerequisite], count);
    const restored = JSON.parse(JSON.stringify(state));
    apply(restored, "start_production", target, readyAt);
    assert.equal(restored.jobs[0].recipeId, target, "a claimed unlock survives persistence");
  });

  test(`cancelling ${prerequisite} does not open ${target}`, () => {
    const state = supplied(target, prerequisite, count);
    apply(state, "start_production", prerequisite);
    apply(state, "cancel_production", state.jobs[0].id, now + 1);
    assert.equal(state.progression.recipes[prerequisite] ?? 0, count - 1);
    locked(state, target, now + 1);
  });
}

test("only strawberries require compote while all other berries open at their level", () => {
  for (const crop of catalog.recipes.filter(row => row.buildingId === "garden" && row.id !== "grow_strawberries")) assert.deepEqual(crop.requiredRecipes, {}, crop.id);
  assert.deepEqual(recipe("cook_strawberry_compote").requiredRecipes, {});
  for (const crop of catalog.recipes.filter(row => row.buildingId === "garden" && row.collection && !row.retired && row.id !== "grow_strawberries")) {
    const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
    state.buildings.home = crop.requiredHomeLevel;
    state.buildings.garden = crop.buildingLevel;
    assert.deepEqual(state.progression.recipes, {});
    apply(state, "start_production", crop.id);
    assert.equal(state.jobs[0].recipeId, crop.id, "the advertised crop level is sufficient without a kitchen");
  }
});

test("every expedition lesson requires delivered work and every other practice condition", () => {
  for (const target of catalog.recipes.filter(row => Object.keys(row.requiredExplorations).length)) {
    for (const [routeId, required] of Object.entries(target.requiredExplorations)) {
      const state = supplied(target.id);
      state.progression.routes[routeId] = required - 1;
      assert.equal(recipeUnlocksMet(state, target), false);
      locked(state, target.id);
      apply(state, "start_exploration", routeId);
      const job = state.jobs[0], readyAt = Date.parse(job.finishesAt);
      locked(state, target.id, readyAt);
      assert.equal(state.progression.routes[routeId], required - 1, "timer completion is not delivery");
      apply(state, "claim_job", job.id, readyAt);
      assert.equal(state.progression.routes[routeId], required);
      assert.equal(recipeUnlocksMet(state, target), true);
      assert.equal(obtainableResidentOrderItems(state).has(Object.keys(target.rewards)[0]), true, target.id);
      for (const [otherRoute, count] of Object.entries(target.requiredExplorations).filter(([id]) => id !== routeId)) {
        state.progression.routes[otherRoute] = count - 1;
        locked(state, target.id, readyAt);
        state.progression.routes[otherRoute] = count;
      }
      if (target.requiredFishCaught) {
        const saved = state.fishing.catches;
        state.fishing.catches = {};
        locked(state, target.id, readyAt);
        state.fishing.catches = saved;
      }
      apply(state, "start_production", target.id, readyAt);
      assert.equal(state.jobs[0].recipeId, target.id);
    }
  }
});

test("partial and full clay claims preserve counters but cannot substitute for exploration practice", () => {
  const target = recipe("make_ceramic_jar");
  const state = supplied(target.id);
  state.progression.routes = {};
  apply(state, "start_exploration", "quarry_clay", now, 2);
  const id = state.jobs[0].id, readyAt = Date.parse(state.jobs[0].finishesAt), all = structuredClone(state);
  apply(state, "claim_mining_batch", id, readyAt, 1);
  assert.equal(state.progression.routes.quarry_clay, 1);
  assert.equal(recipeUnlocksMet(state, target), false);
  apply(state, "claim_mining_batch", id, readyAt, 1);
  apply(all, "claim_job", id, readyAt);
  assert.equal(state.progression.routes.quarry_clay, 2);
  assert.deepEqual(state.progression.routes, all.progression.routes);
  assert.equal(recipeUnlocksMet(state, target), false);
  assert.equal(recipeUnlocksMet(all, target), false);
});

test("personal fishing lesson counts both fishing routes only after claim, never bought stock", () => {
  const target = recipe("cook_fish_soup");
  for (const routeId of catalog.fishing.routeIds) {
    const state = supplied(target.id, "cook_grilled_fish", 2);
    state.fishing.catches = {};
    const fishId = catalog.fishing.fish[0].itemId;
    state.fishingShop = { id: "test-catch-shop", openedAt: new Date(now).toISOString(), refreshAt: new Date(now + 86_400_000).toISOString(),
      refreshPricePearls: 1, offers: [{ id: "fish-offer", kind: "fish", itemId: fishId, unitPrice: 1, remaining: 4 }] };
    rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), action: "buy_fishing_item", targetId: "fish-offer", quantity: 4, totalPrice: 4 }, now, () => crypto.randomUUID());
    assert.equal(personallyCaughtFish(state), 0);
    locked(state, target.id);
    let clock = now;
    while (personallyCaughtFish(state) < target.requiredFishCaught) {
      apply(state, "start_fishing", routeId, clock);
      const job = state.jobs[0], before = personallyCaughtFish(state);
      clock = Date.parse(job.finishesAt);
      assert.equal(personallyCaughtFish(state), before);
      locked(state, target.id, clock);
      apply(state, "claim_job", job.id, clock);
      assert.equal(personallyCaughtFish(state), before + catalog.fishing.collectionDrawsByRoute[routeId]);
    }
    assert.equal(recipeUnlocksMet(state, target), true);
    apply(state, "start_production", target.id, clock);
    assert.equal(state.jobs[0].recipeId, target.id);
  }
});

test("unlock schema defaults and progress ignore class counters and unrelated fish ids", () => {
  const legacy = structuredClone(catalog);
  for (const recipe of legacy.recipes) { delete recipe.requiredExplorations; delete recipe.requiredFishCaught; delete recipe.unlockTitle; }
  const parsed = economyCatalogSchema.parse(legacy);
  assert.ok(parsed.recipes.every(recipe => recipe.requiredFishCaught === 0 && Object.keys(recipe.requiredExplorations).length === 0));
  const state = supplied("cook_fish_soup", "cook_grilled_fish", 2);
  state.fishing.catches = { fish_common: 100, unknown_fish: 100, [catalog.fishing.fish[0].itemId]: 3 };
  assert.equal(personallyCaughtFish(state), 3);
  assert.deepEqual(recipeUnlockRequirements(state, recipe("cook_fish_soup")).map(row => [row.kind, row.current, row.required, row.completed]),
    [["recipe", 1, 1, true], ["fishing", 3, recipe("cook_fish_soup").requiredFishCaught, false]]);
  const invalid = structuredClone(catalog);
  invalid.recipes[0].requiredExplorations = { missing_route: 1 };
  assert.equal(economyCatalogSchema.safeParse(invalid).success, false);
});


test("new item lessons explore distinct places without repeating the target ingredient recipe", () => {
  const expected = {
    make_trade_crate: { forest: 2, old_woodland: 1 },
    make_ceramic_jar: { forest: 2 },
    make_glass_bottle: { coastal_deposits: 2 },
    make_tools: { old_woodland: 2, coastal_deposits: 1 },
    grind_lens: { coastal_deposits: 2, far_bank_path: 1 },
    assemble_field_kit: { far_bank_path: 2, far_bank_grove: 1 },
  };
  for (const [id, routes] of Object.entries(expected)) {
    const target = recipe(id);
    assert.deepEqual(target.requiredExplorations, routes);
    assert.deepEqual(target.requiredRecipes, {}, `${id}: obtaining its ingredients is not a separate unlock lesson`);
    for (const routeId of Object.keys(routes)) {
      const route = catalog.explorations.find(entry => entry.id === routeId);
      assert.ok(route.requiredHomeLevel <= target.requiredHomeLevel, `${id}: route must exist at this house tier`);
      assert.ok(!Object.keys(route.cost.items).some(itemId => target.rewards[itemId]), `${id}: its lesson cannot consume its own output`);
    }
  }
  assert.equal(recipe("make_ceramic_jar").requiredFishCaught, 6);
  assert.equal(recipe("make_glass_bottle").requiredFishCaught, 8);
});


test("claimed ordinary recipes survive redesigned practice requirements without treating stock as learning", () => {
  for (const target of ["make_trade_crate", "grind_lens", "cook_fish_soup"]) {
    const state = supplied(target);
    state.progression.recipes = {};
    state.progression.routes = {};
    state.fishing.catches = {};
    state.unlockedItems = Object.keys(recipe(target).rewards);
    locked(state, target);
    state.progression.recipes[target] = 1;
    const restored = JSON.parse(JSON.stringify(state));
    assert.equal(recipeUnlocksMet(restored, recipe(target)), true);
    assert.deepEqual(recipeUnlockRequirements(restored, recipe(target)), []);
    apply(restored, "start_production", target);
    assert.equal(restored.jobs[0].recipeId, target);
  }
});
