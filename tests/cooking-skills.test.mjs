import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts"), catalog = model.economyCatalog;
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const skills = await vite.ssrLoadModule("/features/economy/domain/craft-skill.ts");
const { publicEconomyJob } = await vite.ssrLoadModule("/features/economy/domain/public-jobs.ts");
const { heroMealWorkDuration } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { obtainableResidentOrderItems } = await vite.ssrLoadModule("/features/economy/domain/order-effort.ts");
const { unlockedEconomyItems } = await vite.ssrLoadModule("/features/economy/domain/item-unlocks.ts");
const { mergeEconomyProgression } = await vite.ssrLoadModule("/features/economy/domain/collection-progress.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-11-02T12:00:00Z");
const experiments = catalog.recipes.filter(recipe => recipe.experiment);
const recipe = id => catalog.recipes.find(row => row.id === id);
function fresh(id = "experiment_currant_fish") {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.inventory = { ...recipe(id).cost.items };
  state.wallet.coins = 100_000;
  state.itemUnlockVersion = 1;
  const level = recipe(id).experiment?.requiredCookingLevel ?? 1;
  state.progression.skills = { version: 1, cookingSeconds: catalog.skills.levels[level - 1].requiredSeconds, travelSeconds: 0 };
  return state;
}
const command = (action, targetId, extra = {}) => ({ action, targetId, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, quantity: 1, totalPrice: 0, ...extra });
const apply = (state, action, target, at = now, ticket = 0, extra = {}) => rules.applyEconomyCommand(state,
  command(action, target, extra), at, () => crypto.randomUUID(), {}, () => ticket);
const claim = state => { const job = state.jobs[0]; apply(state, "claim_job", job.id, Date.parse(job.finishesAt)); return job; };

test("skills have ten slow levels, bounded bonuses and safe legacy defaults", () => {
  assert.deepEqual(catalog.skills.levels.map(row => row.requiredSeconds / 3600), [0, 5, 15, 35, 70, 125, 210, 340, 520, 800]);
  assert.equal(skills.skillProgress({}, "cooking").level, 1);
  assert.equal(skills.experimentDiscovered({}, experiments[0]), false);
  const state = fresh();
  for (const [index, row] of catalog.skills.levels.entries()) {
    state.progression.skills = { version: 1, cookingSeconds: row.requiredSeconds, travelSeconds: row.requiredSeconds };
    assert.equal(skills.skillProgress(state, "travel").level, index + 1);
    assert.equal(skills.skillProgress(state, "cooking").level, index + 1);
    assert.ok(skills.skillProgress(state, "travel").bonusBps <= 500);
    assert.ok(skills.experimentSuccessBps(state, experiments[0]) <= 9500);
    if (index) { state.progression.skills.travelSeconds--; assert.equal(skills.skillProgress(state, "travel").level, index); }
  }
  assert.equal(model.economyProgressionSchema.parse({}).skills, undefined);
  assert.equal(model.economyProgressionSchema.safeParse({ skills: { cookingSeconds: -1 } }).success, false);
});

test("all optional experiments compensate failure at base skill without exceeding the skilled work-value cap", () => {
  assert.equal(experiments.length, 4);
  const value = items => Object.entries(items).reduce((sum, [id, count]) => sum + catalog.items.find(item => item.id === id).baseSellPrice * count, 0);
  for (const recipe of experiments) {
    const work = recipe.seconds / 60 * catalog.timeEconomy.coinsPerMinute;
    const cost = recipe.cost.coins + value(recipe.cost.items), win = value(recipe.rewards), fail = value(recipe.experiment.failureRewards);
    const base = recipe.experiment.successBps / 10000;
    assert.ok(base * win + (1 - base) * fail - cost >= work, recipe.id);
    assert.ok(base * win + (1 - base) * fail - cost < work + 1, recipe.id);
    assert.ok(.95 * win + .05 * fail - cost <= work * 1.15, recipe.id);
    assert.equal(Object.values(recipe.rewards).reduce((a, b) => a + b, 0), 1);
    assert.equal(Object.values(recipe.experiment.failureRewards).reduce((a, b) => a + b, 0), 1);
  }
});

for (const recipe of experiments) for (const successful of [false, true]) test(`${recipe.id}: ${successful ? "success discovers" : "failure retains food without discovery"} only on claim`, () => {
  const state = fresh(recipe.id), practice = state.progression.skills.cookingSeconds;
  apply(state, "start_production", recipe.id, now, successful ? 0 : 9999);
  const saved = structuredClone(state.jobs[0]);
  assert.equal(saved.cooking.successful, successful);
  assert.equal(saved.skillWorkSeconds, recipe.seconds);
  assert.equal(state.progression.skills.cookingSeconds, practice);
  assert.equal(skills.experimentDiscovered(state, recipe), false);
  const restored = JSON.parse(JSON.stringify(state));
  restored.jobs = restored.jobs.map(job => model.economyJobSchema.parse(job));
  restored.progression = model.economyProgressionSchema.parse(restored.progression);
  const ready = Date.parse(saved.finishesAt);
  assert.equal(publicEconomyJob(restored.jobs[0], ready).cooking.successful, undefined);
  assert.deepEqual(publicEconomyJob(restored.jobs[0], ready).rewards, recipe.rewards);
  assert.deepEqual(restored.jobs[0], saved, "projection never changes the private outcome");
  apply(restored, "claim_job", saved.id, ready, successful ? 9999 : 0);
  assert.deepEqual(restored.inventory, successful ? recipe.rewards : recipe.experiment.failureRewards);
  assert.equal(restored.progression.skills.cookingSeconds, practice + recipe.seconds);
  assert.equal(restored.progression.recipes[recipe.id] ?? 0, successful ? 1 : 0);
  assert.equal(skills.experimentDiscovered(restored, recipe), successful);
  assert.equal(restored.progression.skills.lastCooking.successful, successful);
  const after = structuredClone(restored);
  assert.throws(() => apply(restored, "claim_job", saved.id, ready), { code: "ECONOMY_JOB_GONE" });
  assert.deepEqual(restored, after, "a duplicate claim cannot train or award another item");
});

test("public running and ready jobs do not offer a cancellation or capacity outcome oracle", () => {
  const left = fresh(), right = fresh();
  apply(left, "start_production", experiments[0].id, now, 0);
  apply(right, "start_production", experiments[0].id, now, 9999);
  right.jobs[0].id = left.jobs[0].id;
  for (const at of [now, Date.parse(left.jobs[0].finishesAt)])
    assert.deepEqual(publicEconomyJob(left.jobs[0], at), publicEconomyJob(right.jobs[0], at));
  for (const state of [left, right]) {
    const initial = { ...experiments[0].cost.items }, initialSkills = structuredClone(state.progression.skills);
    apply(state, "cancel_production", state.jobs[0].id, now + 1);
    assert.deepEqual(state.inventory, initial);
    assert.deepEqual(state.progression.skills, initialSkills);
    assert.equal(state.progression.recipes[experiments[0].id], undefined);
  }
});

test("failed capacity claims leave private outcome, discovery and practice intact for one later claim", () => {
  for (const ticket of [0, 9999]) {
    const state = fresh(); apply(state, "start_production", experiments[0].id, now, ticket);
    state.inventory = { wood: rules.economyStorage(state).capacity };
    const saved = structuredClone(state), job = state.jobs[0], ready = Date.parse(job.finishesAt);
    assert.throws(() => apply(state, "claim_job", job.id, ready), { code: "ECONOMY_STORAGE_FULL" });
    assert.deepEqual(state, saved);
    state.inventory = {}; apply(state, "claim_job", job.id, ready, 9999 - ticket);
    assert.equal(state.progression.skills.cookingSeconds, experiments[0].seconds);
    assert.equal(state.progression.skills.lastCooking.successful, ticket === 0);
  }
});

test("ordinary cooking stays guaranteed; optional outcomes never become mandatory orders or inventory-based discoveries", () => {
  const state = fresh("cook_berry_tea");
  state.progression.skills.cookingSeconds = 2880000;
  apply(state, "start_production", "cook_berry_tea", now, 9999);
  assert.equal(state.jobs[0].cooking, undefined); claim(state);
  assert.equal(state.inventory.berry_tea, 1);
  const full = fresh(); full.progression.recipes = Object.fromEntries(catalog.recipes.filter(row => !row.experiment).map(row => [row.id, 100]));
  full.progression.routes = Object.fromEntries(catalog.explorations.map(row => [row.id, 100]));
  full.fishing.catches = { [catalog.fishing.fish[0].itemId]: 100 };
  for (const recipe of experiments) {
    const item = Object.keys(recipe.rewards)[0]; full.inventory[item] = 1;
    assert.equal(skills.experimentDiscovered(full, recipe), false);
    assert.equal(obtainableResidentOrderItems(full).has(item), false);
    assert.equal(unlockedEconomyItems(full).includes(item), false);
    full.progression.recipes[recipe.id] = 1;
    assert.equal(unlockedEconomyItems(full).includes(item), true);
    assert.equal(obtainableResidentOrderItems(full).has(item), false, "even discovered experiments do not become required random order ingredients");
  }
});

test("recipe id cannot bypass skill gate and failure cannot farm first-recipe XP", () => {
  const locked = fresh("experiment_river_aspic"); locked.progression.skills.cookingSeconds = 0;
  const before = structuredClone(locked);
  assert.throws(() => apply(locked, "start_production", "experiment_river_aspic"), { code: "ECONOMY_COOKING_SKILL" });
  assert.deepEqual(locked, before);
  const lose = fresh(), win = fresh();
  apply(lose, "start_production", experiments[0].id, now, 9999); apply(win, "start_production", experiments[0].id, now, 0);
  claim(lose); claim(win);
  assert.ok(win.progression.player.xp > lose.progression.player.xp);
});

test("travel preview matches saved duration, awards base work only on claim, and excludes the miner", () => {
  const state = fresh(); state.inventory = {}; state.progression.skills.travelSeconds = 2880000;
  const route = catalog.explorations.find(route => route.id === "forest");
  const expected = heroMealWorkDuration(state, route.seconds);
  apply(state, "start_exploration", route.id);
  const job = state.jobs[0];
  assert.equal(Date.parse(job.finishesAt) - now, expected * 1000);
  assert.equal(job.skillWorkSeconds, route.seconds);
  assert.equal(state.progression.skills.travelSeconds, 2880000);
  claim(state); assert.equal(state.progression.skills.travelSeconds, 2880000 + route.seconds);
  apply(state, "start_exploration", "quarry_stone", now + 86400000);
  assert.equal(state.jobs[0].skillWorkSeconds, undefined);
  claim(state); assert.equal(state.progression.skills.travelSeconds, 2880000 + route.seconds);
});

test("legacy batches train full paid work, merging takes maxima and drops stale result banners", () => {
  const state = fresh("cook_grilled_fish"), recipe = catalog.recipes.find(row => row.id === "cook_grilled_fish");
  state.jobs = [{ id: crypto.randomUUID(), kind: "production", targetId: "dryer", recipeId: recipe.id, startedAt: new Date(now).toISOString(),
    finishesAt: new Date(now + recipe.seconds * 3000).toISOString(), rewards: { grilled_fish: 3 }, cost: { coins: 0, items: { fish_common: 3 } }, catalogVersion: 13 }];
  state.inventory = {}; claim(state);
  assert.equal(state.progression.skills.cookingSeconds, recipe.seconds * 3);
  const merged = mergeEconomyProgression(state.progression, { ...state.progression, skills: { version: 1, cookingSeconds: 1000, travelSeconds: 2000,
    lastCooking: { jobId: crypto.randomUUID(), recipeId: experiments[0].id, successful: true, at: new Date(now).toISOString() } } });
  assert.deepEqual(merged.skills, { version: 1, cookingSeconds: 1000, travelSeconds: 2000 });
});

test("server receipts preserve the frozen private outcome and cannot double-award after reconnect", () => {
  identities.resetDevStoreForTests();
  const player = identities.createDevIdentity("Повар", crypto.randomUUID()); api.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId); row.state = fresh();
  const start = command("start_production", experiments[0].id, { ownerPublicId: player.me.user.publicId, expectedRevision: row.revision });
  const started = api.commandDevEconomy(player.token, start, now), job = row.state.jobs[0];
  assert.equal(started.state.jobs[0].cooking.successful, undefined);
  assert.equal(api.commandDevEconomy(player.token, start, now + 1).replayed, true);
  const ready = Date.parse(job.finishesAt);
  assert.equal(api.getDevEconomy(player.token, ready).jobs[0].cooking.successful, undefined);
  const payload = command("claim_job", job.id, { ownerPublicId: player.me.user.publicId, expectedRevision: row.revision });
  const first = api.commandDevEconomy(player.token, payload, ready), snapshot = structuredClone(row.state);
  const replay = api.commandDevEconomy(player.token, payload, ready + 1);
  assert.equal(replay.replayed, true); assert.deepEqual(row.state, snapshot);
  assert.deepEqual(first.state.progression.skills, replay.state.progression.skills);
  assert.equal(first.state.progression.skills.cookingSeconds, experiments[0].seconds);
});


test("bulk collection trains both outcomes once and combined meal preview matches the frozen travel job", () => {
  const state = fresh(); state.productionSlots = { dryer: 2 };
  state.inventory = { ...experiments[0].cost.items, ...recipe("experiment_berry_pastila").cost.items };
  apply(state, "start_production", experiments[0].id, now, 0);
  apply(state, "start_production", "experiment_berry_pastila", now, 9999);
  const ready = Math.max(...state.jobs.map(job => Date.parse(job.finishesAt)));
  apply(state, "claim_production", "dryer", ready);
  assert.equal(state.progression.skills.cookingSeconds, experiments[0].seconds + recipe("experiment_berry_pastila").seconds);
  assert.equal(state.progression.recipes[experiments[0].id], 1);
  assert.equal(state.progression.recipes.experiment_berry_pastila, undefined);
  assert.equal(state.jobs.length, 0);
  const work = state.progression.skills.cookingSeconds;
  assert.throws(() => apply(state, "claim_production", "dryer", ready));
  assert.equal(state.progression.skills.cookingSeconds, work);
  state.progression.skills.travelSeconds = 2880000;
  state.food = { heroMeal: "grilled_fish", builderMeal: null, heroMealEffect: { speedBps: 1000, remainingWorkSeconds: 100 } };
  const route = catalog.explorations.find(row => row.id === "forest"), seconds = heroMealWorkDuration(state, route.seconds);
  apply(state, "start_exploration", route.id, ready);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - ready, seconds * 1000);
  assert.equal(state.jobs[0].skillWorkSeconds, route.seconds);
});
