import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const stock = await vite.ssrLoadModule("/features/economy/domain/fish-stock.ts");
const { orderEffort, obtainableResidentOrderItems } = await vite.ssrLoadModule("/features/economy/domain/order-effort.ts");
const { publicEconomyJob } = await vite.ssrLoadModule("/features/economy/domain/public-jobs.ts");
const { drawExpeditionFinds } = await vite.ssrLoadModule("/features/economy/domain/expedition-finds.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-10-26T12:00:00Z"), catalog = model.economyCatalog;
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const command = (action, targetId, extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: "AAAA-0000-0001", expectedRevision: 0,
  quantity: 1, totalPrice: 0, action, targetId, ...extra });
const apply = (state, action, targetId, at = now, extra = {}, random = () => 0) => rules.applyEconomyCommand(state, command(action, targetId, extra), at, () => crypto.randomUUID(), {}, random);
const route = { id: "v14_runtime_route", name: "Test", description: "", requiredHomeLevel: 1, requiredBuildings: {}, seconds: 180,
  cost: { coins: 0, items: {} }, rewards: { wood: 1 }, finds: { emptyWeight: 50, entries: [{ itemId: "stone", quantity: 2, weight: 30 }, { itemId: "clay", quantity: 1, weight: 20 }] } };
catalog.explorations.push(route);
const recipe = { ...catalog.recipes.find(row => row.id === "cook_grilled_fish"), id: "v14_runtime_recipe", baseCampfire: undefined,
  fishInput: { itemIds: ["fish_silverfin"], exactSpecies: true }, cost: { coins: 0, items: { fish_silverfin: 2, wood: 1 } }, rewards: { grilled_fish: 1 } };
catalog.recipes.push(recipe);
const meal = catalog.food.meals.find(row => row.itemId === "grilled_fish");
Object.assign(meal, { heroWorkSeconds: 600, heroSpeedBps: 5000, builderSpeedBps: 2500 });

test("strict recipe rejects unidentified or wrong same-class fish, preserves exact debit/refund through reload", () => {
  const state = fresh(); state.buildings.dryer = 1; state.inventory = { fish_common: 4, wood: 1 };
  state.fishing.stock = { fish_rudd: 4 };
  const before = structuredClone(state);
  assert.throws(() => apply(state, "start_production", recipe.id), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
  assert.deepEqual(state, before);
  state.fishing.stock = { fish_silverfin: 2, fish_rudd: 2 };
  assert.throws(() => apply(state, "start_production", recipe.id, now, { fishSelection: { fish_rudd: 2 } }), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
  apply(state, "start_production", recipe.id);
  assert.equal(state.inventory.fish_common, 2);
  assert.deepEqual(state.fishing.stock, { fish_rudd: 2 });
  assert.deepEqual(state.jobs[0].fishStockCost, { fish_silverfin: 2 });
  state.jobs = JSON.parse(JSON.stringify(state.jobs)).map(job => model.economyJobSchema.parse(job));
  apply(state, "cancel_production", state.jobs[0].id, now + 1);
  assert.equal(state.inventory.fish_common, 4);
  assert.deepEqual(state.fishing.stock, { fish_silverfin: 2, fish_rudd: 2 });
  assert.equal(state.inventory.wood, 1);
});

test("mixed exact and generic requirements cannot double spend a species", () => {
  const state = fresh(); state.inventory = { fish_common: 3 }; state.fishing.stock = { fish_silverfin: 2, fish_rudd: 1 };
  assert.deepEqual(stock.autoFillFishSelection(state, { fish_silverfin: 2, fish_common: 1 }), { fish_silverfin: 2, fish_rudd: 1 });
  assert.equal(stock.fishSelectionMatches(state, { fish_silverfin: 2, fish_common: 1 }, { fish_silverfin: 2 }), false);
  assert.equal(stock.fishSelectionMatches(state, { fish_silverfin: 2 }, { fish_common: 2 }), false);
});

test("meal work is frozen, spans short trips, partially boosts long trip, and never refunds cancelled work", () => {
  const state = fresh(); state.inventory.grilled_fish = 1;
  apply(state, "eat_food", "grilled_fish");
  assert.deepEqual(state.food.heroMealEffect, { remainingWorkSeconds: 600, totalWorkSeconds: 600, speedBps: 5000 });
  apply(state, "start_exploration", route.id);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - now, 120_000);
  assert.equal(state.jobs[0].meal.workSeconds, 180);
  assert.equal(state.food.heroMealEffect.remainingWorkSeconds, 420);
  apply(state, "cancel_exploration", state.jobs[0].id, now + 1);
  assert.equal(state.food.heroMealEffect.remainingWorkSeconds, 420);
  state.food = model.economyFoodSchema.parse(JSON.parse(JSON.stringify(state.food)));
  assert.equal(food.heroMealWorkDuration(state, 600), 180 + 280);
  apply(state, "cancel_meal", "hero", now + 2);
  assert.equal(state.food.heroMeal, null); assert.equal(state.food.heroMealEffect, undefined);
  assert.equal(state.inventory.grilled_fish, undefined, "a partly spent serving cannot become a fresh item");
});

test("untouched food returns once; old pending servings preserve v13 speed and one-job life", () => {
  const state = fresh(); state.inventory.grilled_fish = 1;
  apply(state, "eat_food", "grilled_fish"); apply(state, "cancel_meal", "hero");
  assert.equal(state.inventory.grilled_fish, 1);
  assert.throws(() => apply(state, "cancel_meal", "hero"), { code: "ECONOMY_MEAL_UNAVAILABLE" });
  state.food = { heroMeal: "grilled_fish", builderMeal: "grilled_fish" };
  assert.equal(food.pendingMeal(state, "hero").heroSpeedBps, 1000);
  assert.equal(food.pendingMeal(state, "builder").builderSpeedBps, 1000);
  apply(state, "start_exploration", route.id);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - now, Math.ceil(180 / 1.1) * 1000);
  assert.equal(state.food.heroMeal, null); assert.equal(state.food.builderMeal, "grilled_fish");
});

test("blocked departure preserves the entire food budget", () => {
  const state = fresh(); state.inventory.grilled_fish = 1; apply(state, "eat_food", "grilled_fish");
  apply(state, "start_exploration", route.id);
  const before = structuredClone(state);
  assert.throws(() => apply(state, "start_exploration", route.id)); assert.deepEqual(state, before);
});

test("find weights include empty outcome and reject untrusted random values", () => {
  assert.deepEqual(drawExpeditionFinds(route.finds, () => 49), {});
  assert.deepEqual(drawExpeditionFinds(route.finds, () => 50), { stone: 2 });
  assert.deepEqual(drawExpeditionFinds(route.finds, () => 80), { clay: 1 });
  assert.throws(() => drawExpeditionFinds(route.finds, () => 100));
});

test("private find is frozen once, hidden even ready, survives full-warehouse retry and credits once", () => {
  const state = fresh(); let draws = 0;
  apply(state, "start_exploration", route.id, now, {}, () => { draws++; return 50; });
  assert.equal(draws, 1); const job = state.jobs[0];
  assert.deepEqual(job.expeditionFinds, { stone: 2 });
  for (const at of [now, now + 1_000_000]) assert.equal(publicEconomyJob(job, at).expeditionFinds, undefined);
  assert.deepEqual(job.expeditionFinds, { stone: 2 });
  state.jobs = [model.economyJobSchema.parse(JSON.parse(JSON.stringify(job)))];
  state.inventory = { wood: rules.economyStorage(state).capacity - 1 };
  const before = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", job.id, now + 1_000_000), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, before);
  state.inventory = {};
  apply(state, "claim_job", job.id, now + 1_000_000, {}, () => { throw Error("must not reroll at claim"); });
  assert.deepEqual(state.inventory, { wood: 1, stone: 2 });
  assert.equal(state.jobs.length, 0);
  assert.throws(() => apply(state, "claim_job", job.id, now + 1_000_001), { code: "ECONOMY_JOB_GONE" });
  assert.deepEqual(state.inventory, { wood: 1, stone: 2 });
});

test("old saved job claims exactly original guaranteed delivery", () => {
  const state = fresh(); apply(state, "start_exploration", route.id); const job = state.jobs[0]; delete job.expeditionFinds;
  state.inventory = {}; apply(state, "claim_job", job.id, now + 1_000_000);
  assert.deepEqual(state.inventory, { wood: 1 });
});

test("API snapshot and command receipt always redact saved finds, replay does not repeat claim", () => {
  identities.resetDevStoreForTests(); api.resetDevEconomyStoreForTests();
  const player = identities.createDevIdentity("Private finds", crypto.randomUUID());
  const read = at => api.getDevEconomy(player.token, at);
  const send = (action, targetId, at) => api.commandDevEconomy(player.token,
    { ...command(action, targetId), ownerPublicId: player.me.user.publicId, expectedRevision: read(at).revision }, at);
  const started = send("start_exploration", route.id, now);
  const state = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId).state;
  assert.equal(started.state.jobs[0].expeditionFinds, undefined);
  assert.ok(state.jobs[0].expeditionFinds);
  state.jobs[0].expeditionFinds = { stone: 2 };
  assert.equal(read(now + 1_000_000).jobs[0].expeditionFinds, undefined);
  const request = { ...command("claim_job", state.jobs[0].id), ownerPublicId: player.me.user.publicId, expectedRevision: read(now + 1_000_000).revision };
  const first = api.commandDevEconomy(player.token, request, now + 1_000_000);
  const inventory = structuredClone(read(now + 1_000_000).inventory);
  const repeated = api.commandDevEconomy(player.token, request, now + 1_000_001);
  assert.equal(repeated.replayed, true); assert.deepEqual(repeated.state.inventory, first.state.inventory); assert.deepEqual(read(now + 1_000_001).inventory, inventory);
});


test("species planning uses catchable owned tackle and includes the extra species search work", () => {
  const state = fresh(); state.buildings.dryer = 1;
  const reachable = obtainableResidentOrderItems(state);
  assert.ok(reachable.has("fish_silverfin")); assert.equal(reachable.has("fish_shark"), false);
  const exact = orderEffort(state, { fish_silverfin: 2 }), generic = orderEffort(state, { fish_common: 2 });
  assert.equal(exact.obtainable, true); assert.equal(exact.fishingUncertain, true);
  assert.ok(exact.effortSeconds > generic.effortSeconds);
});

test("unaffordable or impossible-capacity departure never draws or spends food", () => {
  const state = fresh(); state.inventory.grilled_fish = 1; apply(state, "eat_food", "grilled_fish");
  const blocked = { ...route, id: "v14_blocked_route", cost: { coins: 1, items: {} } };
  catalog.explorations.push(blocked); state.wallet.coins = 0; state.buildings.home = 3;
  const before = structuredClone(state), noDraw = () => { throw Error("rejected command must not draw"); };
  assert.throws(() => apply(state, "start_exploration", blocked.id, now, {}, noDraw), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(state, before);
  blocked.cost.coins = 0; blocked.finds = { emptyWeight: 99, entries: [{ itemId: "wood", quantity: rules.economyStorage(state).capacity, weight: 1 }] };
  assert.throws(() => apply(state, "start_exploration", blocked.id, now, {}, noDraw), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, before);
});


test("protocol rejects client-authored private loot and orphaned food metadata", () => {
  assert.equal(model.economyCommandSchema.safeParse({ ...command("start_exploration", route.id), expeditionFinds: { stone: 99 } }).success, false);
  assert.equal(model.economyFoodSchema.safeParse({ heroMeal: null, builderMeal: null,
    heroMealEffect: { remainingWorkSeconds: 10, totalWorkSeconds: 10, speedBps: 1000 } }).success, false);
  assert.equal(model.economyFoodSchema.safeParse({ heroMeal: null, builderMeal: null, builderMealSpeedBps: 1000 }).success, false);
});
