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
  state.progression.skills = { version: 1, buildingHistoryVersion: 1, cookingSeconds: catalog.skills.levels[level - 1].requiredSeconds, travelSeconds: 0 };
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
    state.progression.skills = { version: 1, buildingHistoryVersion: 1, cookingSeconds: row.requiredSeconds, travelSeconds: row.requiredSeconds };
    assert.equal(skills.skillProgress(state, "travel").level, index + 1);
    assert.equal(skills.skillProgress(state, "cooking").level, index + 1);
    assert.ok(skills.skillProgress(state, "travel").bonusBps <= 500);
    assert.ok(skills.experimentSuccessBps(state, experiments[0]) <= 9500);
    if (index) { state.progression.skills.travelSeconds--; assert.equal(skills.skillProgress(state, "travel").level, index); }
  }
  assert.equal(model.economyProgressionSchema.parse({}).skills, undefined);
  assert.equal(model.economyProgressionSchema.safeParse({ skills: { cookingSeconds: -1 } }).success, false);
});

test("all optional experiments compensate failure at base skill without exceeding the skilled gross-value cap", () => {
  assert.equal(experiments.length, 7);
  const value = items => Object.entries(items).reduce((sum, [id, count]) => sum + catalog.items.find(item => item.id === id).baseSellPrice * count, 0);
  for (const recipe of experiments) {
    const work = recipe.seconds / 60 * catalog.timeEconomy.coinsPerMinute;
    const cost = recipe.cost.coins + value(recipe.cost.items), win = value(recipe.rewards), fail = value(recipe.experiment.failureRewards);
    const base = recipe.experiment.successBps / 10000;
    assert.ok(base * win + (1 - base) * fail - cost >= work, recipe.id);
    assert.ok(base * win + (1 - base) * fail - cost < work + 1, recipe.id);
    assert.ok(.95 * win + .05 * fail <= (cost + work) * 1.12 + 1, recipe.id);
    assert.equal(Object.values(recipe.rewards).reduce((a, b) => a + b, 0), 1);
    assert.equal(Object.values(recipe.experiment.failureRewards).reduce((a, b) => a + b, 0), 0);
  }
});

test("the first experiment runs at the starter fire and only unlocks its result after collection", () => {
  const starter = experiments.find(recipe => recipe.experiment.initialFire);
  const state = fresh(starter.id);
  state.buildings = { home: 1, dryer: 0, warehouse: 1 };
  apply(state, "start_production", starter.id, now, 0);
  assert.equal(skills.experimentDiscovered(state, starter), false);
  claim(state);
  assert.equal(skills.experimentDiscovered(state, starter), true);
  assert.deepEqual(state.inventory, starter.rewards);
});

for (const recipe of experiments) for (const successful of [false, true]) test(`${recipe.id}: ${successful ? "success discovers" : "failure consumes ingredients without discovery"} only on claim`, () => {
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
  for (const ticket of [0]) {
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
  assert.equal(state.jobs[0].skillWorkSeconds, catalog.explorations.find(route => route.id === "quarry_stone").seconds);
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
  assert.deepEqual(merged.skills, model.economyProgressionSchema.parse({ skills: { version: 1, cookingSeconds: 1000, travelSeconds: 2000 } }).skills);
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


test("nine skills preserve old careers, scale construction fairly and reject forged counters", () => {
  const old = model.economyProgressionSchema.parse({ skills: { cookingSeconds: 18000, travelSeconds: 54000 } });
  assert.equal(old.skills.cookingSeconds, 18000); assert.equal(old.skills.travelSeconds, 54000);
  for (const id of skills.craftSkillIds) {
    const state = fresh(); state.progression = structuredClone(old);
    if (!["cooking", "travel"].includes(id)) assert.equal(state.progression.skills[`${id}Seconds`], 0);
    const max = catalog.skills.levels.at(-1).requiredSeconds / (id === "building" ? catalog.skills.buildingPracticeDivisor : 1);
    state.progression.skills[`${id}Seconds`] = max;
    assert.equal(skills.skillProgress(state, id).level, 10);
    assert.ok(skills.skillProgress(state, id).bonusBps <= (id === "cooking" ? 1000 : id === "travel" ? 500 : 300));
    const merged = mergeEconomyProgression(old, state.progression);
    assert.equal(merged.skills[`${id}Seconds`], max);
    assert.equal(model.economyProgressionSchema.safeParse({ skills: { [`${id}Seconds`]: -1 } }).success, false);
    assert.equal(model.economyProgressionSchema.safeParse({ skills: { [`${id}Seconds`]: 31_536_001 } }).success, false);
  }
});

test("each production station trains only its own claimed base work and cancels without practice", () => {
  for (const building of ["workshop", "kiln", "garden", "woodlot"]) {
    const row = catalog.recipes.find(row => row.buildingId === building && !row.retired && !row.experiment);
    const state = fresh(row.id), skill = skills.skillForProduction(building), max = catalog.skills.levels.at(-1).requiredSeconds;
    state.progression.skills = model.economyProgressionSchema.parse({ skills: { buildingHistoryVersion: 1, [`${skill}Seconds`]: max } }).skills;
    state.progression.recipes = Object.fromEntries(catalog.recipes.map(row => [row.id, 100]));
    apply(state, "start_production", row.id);
    const job = state.jobs[0];
    assert.ok(Date.parse(job.finishesAt) - now < row.seconds * 1000, building);
    assert.equal(job.skillWorkSeconds, row.seconds);
    const cancelled = structuredClone(state); apply(cancelled, "cancel_production", job.id, now + 1);
    assert.equal(cancelled.progression.skills[`${skill}Seconds`], max);
    if (job.collection) {
      apply(state, "start_collection", job.id, Date.parse(job.finishesAt));
      apply(state, "claim_job", job.id, Date.parse(job.collection.finishesAt));
    } else claim(state);
    assert.equal(state.progression.skills[`${skill}Seconds`], max + row.seconds);
    for (const other of skills.craftSkillIds.filter(id => id !== skill)) assert.equal(state.progression.skills[`${other}Seconds`], 0);
  }
});

test("fishing trains its own career, preserves previous travel and previews the correct speed", () => {
  const state = fresh(); state.inventory = {}; state.progression.skills = model.economyProgressionSchema.parse({ skills: { buildingHistoryVersion: 1, travelSeconds: 2880000, fishingSeconds: 2880000 } }).skills;
  const route = catalog.explorations.find(route => route.id === "shore");
  assert.equal(skills.skillForExploration(route), "fishing");
  apply(state, "start_exploration", route.id);
  const job = state.jobs[0]; assert.equal(Date.parse(job.finishesAt) - now, heroMealWorkDuration(state, route.seconds, "fishing") * 1000);
  claim(state); assert.equal(state.progression.skills.fishingSeconds, 2880000 + route.seconds);
  assert.equal(state.progression.skills.travelSeconds, 2880000);
});

test("partial mining claims equal a full batch and stopping unfinished units cannot train them", () => {
  const start = () => { const state = fresh(); state.inventory = {}; apply(state, "start_exploration", "quarry_stone", now, 0, { quantity: 3 }); return state; };
  const full = start(), partial = structuredClone(full), job = full.jobs[0], route = catalog.explorations.find(route => route.id === job.targetId);
  const ready = Date.parse(job.finishesAt);
  apply(full, "claim_job", job.id, ready);
  for (let index = 0; index < 3; index++) apply(partial, "claim_mining_batch", job.id, ready, 0, { quantity: 1 });
  assert.equal(full.progression.skills.miningSeconds, route.seconds * 3);
  assert.deepEqual(partial.progression.skills, full.progression.skills);
  const stopped = start(), saved = stopped.jobs[0];
  apply(stopped, "cancel_exploration", saved.id, now + saved.miningBatch.unitSeconds * 1000);
  assert.equal(stopped.progression.skills?.miningSeconds ?? 0, 0);
  apply(stopped, "claim_job", saved.id, now + saved.miningBatch.unitSeconds * 1000);
  assert.equal(stopped.progression.skills.miningSeconds, route.seconds);
});

test("construction learns completed baseline work with a frozen small speed bonus", () => {
  const state = fresh(); state.buildings.warehouse = 1;
  state.progression.skills = model.economyProgressionSchema.parse({ skills: { buildingHistoryVersion: 1, buildingSeconds: 360000 } }).skills;
  const target = catalog.buildings.find(row => row.id === "warehouse").levels.find(row => row.level === 2);
  state.inventory = { ...target.cost.items };
  apply(state, "start_construction", "warehouse");
  const job = state.jobs[0]; assert.equal(job.skillSpeedBps, 300); assert.equal(job.skillWorkSeconds, target.seconds);
  assert.equal(Date.parse(job.finishesAt) - now, skills.skillWorkDuration(state, "building", target.seconds) * 1000);
  claim(state); assert.equal(state.progression.skills.buildingSeconds, 360000 + target.seconds);
});

test("an empty failed experiment claims at full storage without refund and cannot be cancelled or repeated", () => {
  const state = fresh(); apply(state, "start_production", experiments[0].id, now, 9999);
  const job = state.jobs[0], ready = Date.parse(job.finishesAt);
  assert.deepEqual(job.rewards, {}); state.inventory = { wood: rules.economyStorage(state).capacity };
  assert.throws(() => apply(state, "cancel_production", job.id, ready));
  apply(state, "claim_job", job.id, ready);
  assert.deepEqual(state.inventory, { wood: rules.economyStorage(state).capacity });
  assert.equal(state.progression.skills.lastCooking.successful, false);
  assert.equal(state.progression.skills.cookingSeconds, experiments[0].seconds);
  assert.throws(() => apply(state, "claim_job", job.id, ready));
});

test("instant tutorial harvest and its repeated collection cannot mint gardening practice", () => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  apply(state, "start_tutorial_harvest", "grow_berries");
  const job = state.jobs[0]; assert.equal(job.skillWorkSeconds, 0);
  apply(state, "start_collection", job.id, now + 1);
  const ready = Date.parse(job.collection.finishesAt); apply(state, "claim_job", job.id, ready);
  assert.equal(state.progression.skills?.gatheringSeconds ?? 0, 0);
  assert.throws(() => apply(state, "claim_job", job.id, ready));
  assert.throws(() => apply(state, "start_tutorial_harvest", "grow_berries", ready));
});


function legacyForest() {
  const state = fresh(); state.workshopStarterClaimed = true;
  delete state.progression.skills; return state;
}
const historicalSeconds = state => catalog.buildings.reduce((sum, row) => sum + row.levels.filter(level =>
  level.level <= (state.buildings[row.id] ?? 0) && !(level.level === 1 && (["home", "garden", "warehouse"].includes(row.id)
    || row.id === "workshop" && state.workshopStarterClaimed))).reduce((total, level) => total + level.seconds, 0), 0);

test("legacy completed forest immediately projects earned construction skill without mutating saved progress", () => {
  const state = legacyForest(), before = structuredClone(state), expected = historicalSeconds(state);
  assert.equal(expected, 474600);
  assert.equal(skills.skillProgress(state, "building").level, 10);
  assert.equal(skills.skillProgress(state, "building").workSeconds, expected);
  const projected = skills.effectiveCraftSkills(state);
  assert.equal(projected.buildingHistoryVersion, 1);
  assert.equal(projected.buildingSeconds, expected);
  assert.deepEqual(state, before, "a displayed legacy skill must not alter state or rewards");
  state.progression.skills = { ...skills.newCraftSkills(), buildingHistoryVersion: undefined, buildingSeconds: expected + 100 };
  assert.equal(skills.effectiveCraftSkills(state).buildingSeconds, expected + 100, "use maximum, never add history twice");
  const altered = structuredClone(catalog); altered.buildings.forEach(building => building.levels.forEach(level => level.seconds *= 2));
  const normalized = { ...state, progression: { ...state.progression, skills: projected } };
  assert.equal(skills.effectiveCraftSkills(normalized, altered).buildingSeconds, expected, "sealed histories do not reprice on catalog updates");
});

test("new and reset careers start sealed at zero while an imported established house retains its history", () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
    assert.equal(state.progression.skills.buildingHistoryVersion, 1);
    assert.equal(state.progression.skills.buildingSeconds, 0);
    state.buildings.warehouse = 15;
    assert.equal(skills.effectiveCraftSkills(state).buildingSeconds, 0, "later grants cannot masquerade as old completed work");
  }
  const imported = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 1 });
  assert.equal(imported.progression.skills.buildingHistoryVersion, 1);
  assert.equal(imported.progression.skills.buildingSeconds, 9300);
  const free = legacyForest(); free.buildings = { home: 1, garden: 1, warehouse: 1, workshop: 1, dryer: 0 };
  assert.equal(skills.effectiveCraftSkills(free).buildingSeconds, 0);
  free.buildings.dryer = 1;
  assert.equal(skills.effectiveCraftSkills(free).buildingSeconds, 180, "dryer1 is a paid upgrade, the free campfire is dryer0");
});

test("history excludes a pending construction and records its claim exactly once", () => {
  const state = legacyForest(); state.buildings.warehouse = 13;
  const target = catalog.buildings.find(row => row.id === "warehouse").levels.find(row => row.level === 14);
  const beforeWork = historicalSeconds(state), job = { id: crypto.randomUUID(), kind: "construction", targetId: "warehouse", recipeId: null,
    targetLevel: 14, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + target.seconds * 1000).toISOString(),
    rewards: {}, cost: target.cost, catalogVersion: 15 };
  state.jobs = [job]; const saved = structuredClone(state);
  assert.equal(skills.effectiveCraftSkills(state).buildingSeconds, beforeWork);
  assert.throws(() => apply(state, "claim_job", job.id, now), { code: "ECONOMY_JOB_NOT_READY" });
  assert.deepEqual(state, saved, "a rejected command must not persist the projection");
  claim(state);
  assert.equal(state.progression.skills.buildingSeconds, beforeWork + target.seconds);
  assert.equal(state.progression.skills.buildingHistoryVersion, 1);
  assert.equal(skills.effectiveCraftSkills(state).buildingSeconds, beforeWork + target.seconds);
  const claimed = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", job.id, Date.parse(job.finishesAt)));
  assert.deepEqual(state, claimed);
});

test("paid and ready construction completion train like claiming without crediting other active jobs", () => {
  for (const ready of [false, true]) {
    const state = fresh(); state.buildings.warehouse = 1; state.wallet.pearls = 50000;
    const target = catalog.buildings.find(row => row.id === "warehouse").levels.find(row => row.level === 2);
    state.inventory = { ...target.cost.items }; apply(state, "start_construction", "warehouse");
    const job = state.jobs[0], snapshot = structuredClone(state.progression.player);
    apply(state, "speedup_construction", job.id, ready ? Date.parse(job.finishesAt) : now + 1, 0, { totalPrice: ready ? 0 : 50000 });
    assert.equal(state.progression.skills.buildingSeconds, target.seconds);
    assert.equal(state.buildings.warehouse, 2);
    assert.deepEqual(state.progression.player, snapshot, "construction compatibility does not change player XP");
    const saved = structuredClone(state);
    assert.throws(() => apply(state, "speedup_construction", job.id, now + target.seconds * 1000, 0, { totalPrice: 50000 }));
    assert.deepEqual(state, saved);
  }
});

test("each merging legacy career normalizes separately before maximum without repricing the combined forest", () => {
  const left = legacyForest(), right = legacyForest();
  left.buildings.warehouse = 13; right.buildings.garden = 1;
  const a = historicalSeconds(left), b = historicalSeconds(right);
  const merged = mergeEconomyProgression(left.progression, right.progression, left, right);
  assert.equal(merged.skills.buildingHistoryVersion, 1);
  assert.equal(merged.skills.buildingSeconds, Math.max(a, b));
  const combined = { ...left, buildings: Object.fromEntries(catalog.buildings.map(row => [row.id, Math.max(left.buildings[row.id], right.buildings[row.id])])), progression: merged };
  assert.equal(skills.effectiveCraftSkills(combined).buildingSeconds, Math.max(a, b));
  assert.equal(mergeEconomyProgression(merged, merged, combined, combined).skills.buildingSeconds, Math.max(a, b));
});

test("public DEV snapshots project history immediately and an accepted receipt persists it only once", () => {
  identities.resetDevStoreForTests();
  const player = identities.createDevIdentity("Строитель", crypto.randomUUID()); api.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
  row.state = { ...legacyForest(), fishingShop: row.state.fishingShop }; row.state.inventory = {};
  const before = structuredClone(row.state), revision = row.revision, expected = historicalSeconds(row.state);
  const shown = api.getDevEconomy(player.token, now);
  assert.equal(shown.progression.skills.buildingSeconds, expected);
  assert.equal(shown.revision, revision); assert.deepEqual(row.state, before);
  const payload = command("start_production", "grow_berries", { ownerPublicId: player.me.user.publicId, expectedRevision: revision });
  const accepted = api.commandDevEconomy(player.token, payload, now);
  assert.equal(row.state.progression.skills.buildingSeconds, expected);
  assert.equal(row.state.progression.skills.buildingHistoryVersion, 1);
  const saved = structuredClone(row.state), replay = api.commandDevEconomy(player.token, payload, now + 1);
  assert.equal(replay.replayed, true); assert.deepEqual(row.state, saved);
  assert.equal(accepted.state.progression.skills.buildingSeconds, expected);
});
