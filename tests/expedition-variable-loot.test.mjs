import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { playerProgressionCatalog } = await vite.ssrLoadModule("/features/economy/domain/player-levels.ts");
const { drawExpeditionLoot, expeditionMaximumRewards } = await vite.ssrLoadModule("/features/economy/domain/expedition-finds.ts");
const { publicEconomyJob } = await vite.ssrLoadModule("/features/economy/domain/public-jobs.ts");
const { economyAchievementProgress } = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const now = Date.parse("2026-11-01T12:00:00Z"), catalog = model.economyCatalog;
const fresh = () => ({ ...rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 }), inventory: {} });
const command = (action, targetId) => ({ action, targetId, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, quantity: 1, totalPrice: 0 });
const apply = (state, action, targetId, at = now, random = () => 0) => rules.applyEconomyCommand(state, command(action, targetId), at, () => crypto.randomUUID(), {}, random);
const previous = {
  forest: { wood: 5, stone: 3, fiber: 4 }, old_woodland: { hardwood: 4, resin: 2, wood: 1 },
  coastal_deposits: { clay: 3, sand: 3, ore: 3 }, uplands: { hardwood: 4, ore: 6, resin: 4, stone: 4 },
  far_bank_path: { wood: 4, fiber: 4, hardwood: 6, stone: 4 }, far_bank_grove: { hardwood: 4, ore: 3, sand: 3, clay: 4 },
  ancient_ruins: { wood: 1, hardwood: 10, ore: 10, sand: 8, resin: 6, quartz: 3 },
};

test("all supply routes vary their yield without raising mean basic resources or gear bonus value", () => {
  for (const [id, old] of Object.entries(previous)) {
    const route = catalog.explorations.find(row => row.id === id);
    const expected = { ...route.rewards };
    for (const entry of route.loot) expected[entry.itemId] = (expected[entry.itemId] ?? 0) + (entry.min + entry.max) / 2;
    assert.deepEqual(expected, old, id);
    assert.ok(expeditionMaximumRewards(route) <= 49, "even the best supply result fits base storage with one separate rare relic");
  }
  for (const [id, itemId, chance, oldValue] of [["uplands", "metal_parts", 5, 47.6], ["ancient_ruins", "lens", 8, 87.5]]) {
    const finds = catalog.explorations.find(row => row.id === id).finds;
    const total = finds.emptyWeight + finds.entries.reduce((sum, entry) => sum + entry.weight, 0);
    assert.equal(finds.entries.find(entry => entry.itemId === itemId).weight / total * 100, chance);
    const value = finds.entries.reduce((sum, entry) => sum + catalog.items.find(item => item.id === entry.itemId).baseSellPrice * entry.quantity * entry.weight / total, 0);
    assert.ok(value <= oldValue + 1e-9);
  }
});

test("independent ranges include both endpoints and merge a rare find of the same material", () => {
  const route = { loot: [{ itemId: "wood", min: 0, max: 2 }, { itemId: "stone", min: 1, max: 3 }], finds: { emptyWeight: 1, entries: [{ itemId: "wood", quantity: 2, weight: 1 }] } };
  assert.deepEqual(drawExpeditionLoot(route, () => 0), { stone: 1 });
  assert.deepEqual(drawExpeditionLoot(route, size => size - 1), { wood: 4, stone: 3 });
  for (const invalid of [-1, 1.5, NaN, 3]) assert.throws(() => drawExpeditionLoot({ loot: route.loot }, () => invalid));
});

test("bait and ready food replace empty rolls with exact bounded chances and useful ordinary sources", () => {
  const additions = [
    ["forest", "worm_bait", 3, 20, 30, 20, 303.6, 0.6],
    ["far_bank_grove", "currant_jelly", 1, 6, 49, 22, 1085.2, 34.2],
  ];
  for (const [id, itemId, quantity, weight, emptyWeight, capacity, expectedValue, addedValue] of additions) {
    const route = catalog.explorations.find(row => row.id === id), counts = {};
    assert.equal(route.finds.emptyWeight, emptyWeight);
    assert.equal(route.finds.emptyWeight + route.finds.entries.reduce((sum, entry) => sum + entry.weight, 0), 100);
    assert.deepEqual(route.finds.entries.find(entry => entry.itemId === itemId), { itemId, quantity, weight });
    for (let roll = 0; roll < 100; roll++) {
      const result = drawExpeditionLoot({ ...route, loot: [] }, () => roll);
      const key = Object.keys(result)[0] ?? "empty";
      counts[key] = (counts[key] ?? 0) + 1;
      if (key === itemId) assert.equal(result[itemId], quantity);
    }
    assert.equal(counts[itemId], weight);
    assert.equal(counts.empty, emptyWeight);
    for (const entry of route.finds.entries) assert.equal(counts[entry.itemId], entry.weight);
    const price = id => catalog.items.find(item => item.id === id).baseSellPrice;
    const value = Object.entries(route.rewards).reduce((sum, [id, count]) => sum + price(id) * count, 0)
      + route.loot.reduce((sum, entry) => sum + price(entry.itemId) * (entry.min + entry.max) / 2, 0)
      + route.finds.entries.reduce((sum, entry) => sum + price(entry.itemId) * entry.quantity * entry.weight / 100, 0);
    assert(Math.abs(value - expectedValue) < 1e-9);
    assert(Math.abs(price(itemId) * quantity * weight / 100 - addedValue) < 1e-9);
    assert.equal(expeditionMaximumRewards(route), capacity);
  }
  assert.equal(catalog.fishing.baits.find(bait => bait.itemId === "worm_bait").price, 1);
  const jelly = catalog.recipes.find(recipe => recipe.id === "cook_currant_jelly");
  assert.equal(jelly.retired, undefined);
  assert.deepEqual(jelly.cost.items, { currants: 2, berry_compote: 1, ceramic_jar: 1 });
  assert.equal(jelly.rewards.currant_jelly, 1, "The find does not replace the ordinary crafting source");
});

test("the complete three-bait find fits exactly fifty slots and a failed claim retains the saved result", () => {
  const state = fresh(), route = catalog.explorations.find(row => row.id === "forest");
  apply(state, "start_exploration", route.id, now, size => size - 1);
  const job = state.jobs[0], end = Date.parse(job.finishesAt);
  assert.equal(job.expeditionFinds.worm_bait, 3);
  assert.equal(Object.values(job.rewards).reduce((sum, count) => sum + count, 0)
    + Object.values(job.expeditionFinds).reduce((sum, count) => sum + count, 0), 20);
  state.inventory = { wood: 31 }; const blocked = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", job.id, end), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, blocked);
  state.inventory = { wood: 30 };
  apply(state, "claim_job", job.id, end, () => { throw Error("claim must not reroll the bait"); });
  assert.equal(state.inventory.worm_bait, 3);
  assert.equal(rules.economyStorage(state).used, 50);
});

test("found jelly grants only expedition XP and cannot mint cooking rewards or resale XP", () => {
  const route = catalog.explorations.find(row => row.id === "far_bank_grove");
  const start = () => {
    const state = fresh();
    state.buildings = { ...state.buildings, home: 4, bridge: 1, kiln: 1, dryer: 2 };
    state.inventory = { packed_berries: 1 };
    return state;
  };
  const lucky = start(), ordinary = start();
  for (const [state, random] of [[lucky, size => size - 1], [ordinary, () => 0]]) {
    apply(state, "start_exploration", route.id, now, random);
    const job = state.jobs[0];
    apply(state, "claim_job", job.id, Date.parse(job.finishesAt), random);
  }
  assert.equal(lucky.inventory.currant_jelly, 1);
  assert.equal(ordinary.inventory.currant_jelly, undefined);
  assert.deepEqual(lucky.progression.player, ordinary.progression.player);
  assert.equal(lucky.wallet.pearls, ordinary.wallet.pearls);
  assert.equal(lucky.progression.player.xp, Math.floor(route.seconds / playerProgressionCatalog.workSecondsPerXp) + playerProgressionCatalog.firstExplorationXp);
  assert.deepEqual(lucky.progression.recipes, {});
  const achievements = economyAchievementProgress(lucky);
  for (const id of ["master_recipes", "campfire_cook", "forest_cuisine", "first_sale"])
    assert.equal(achievements[id], 0, id);
  const claimed = structuredClone(lucky), at = now + route.seconds * 1000;
  apply(lucky, "eat_food", "currant_jelly", at);
  assert.equal(lucky.inventory.currant_jelly ?? 0, 0);
  assert.equal(lucky.food.heroMeal, "currant_jelly", "The found meal is immediately usable");
  assert.deepEqual(lucky.progression, claimed.progression);
  const sold = structuredClone(claimed);
  apply(sold, "sell", "currant_jelly", at);
  assert.equal(sold.wallet.coins - claimed.wallet.coins, 570);
  assert.equal(sold.wallet.pearls, claimed.wallet.pearls);
  assert.deepEqual(sold.progression, claimed.progression);
  assert.equal(economyAchievementProgress(sold).first_sale, 0, "NPC sales are not confirmed player-market sales");
});

test("catalog rejects reversed, duplicated, unknown, special and fishing or mining loot", () => {
  for (const patch of [
    { loot: [{ itemId: "wood", min: 3, max: 2 }] },
    { loot: [{ itemId: "wood", min: 0, max: 2 }, { itemId: "wood", min: 0, max: 2 }] },
    { loot: [{ itemId: "unknown_material", min: 0, max: 1 }] },
    { loot: [{ itemId: catalog.items.find(item => item.category === "special").id, min: 0, max: 1 }] },
    { activity: "mining" },
  ]) {
    const changed = structuredClone(catalog); Object.assign(changed.explorations.find(row => row.id === "forest"), patch);
    assert.equal(model.economyCatalogSchema.safeParse(changed).success, false);
  }
  const changed = structuredClone(catalog); changed.explorations.find(row => row.id === "shore").loot = [{ itemId: "wood", min: 0, max: 1 }];
  assert.equal(model.economyCatalogSchema.safeParse(changed).success, false);
});

test("whole range capacity is checked before entropy and cannot reveal a lucky result through failed starts", () => {
  const route = { ...catalog.explorations.find(row => row.id === "forest"), id: "loot_capacity_test", rewards: { wood: 1 }, loot: [{ itemId: "wood", min: 0, max: 50 }], finds: null };
  catalog.explorations.push(route);
  try {
    const state = fresh(), before = structuredClone(state); let draws = 0;
    assert.throws(() => apply(state, "start_exploration", route.id, now, () => { draws++; return 0; }), { code: "ECONOMY_STORAGE_FULL" });
    assert.equal(draws, 0); assert.deepEqual(state, before);
  } finally { catalog.explorations.pop(); }
});

test("variable outcome stays private through ready and reload, retries never reroll, and XP is credited once", () => {
  const state = fresh(), route = catalog.explorations.find(row => row.id === "forest"); let draws = 0;
  apply(state, "start_exploration", route.id, now, size => { draws++; return size - 1; });
  assert.equal(draws, route.loot.length + 1);
  const job = state.jobs[0], end = Date.parse(job.finishesAt), original = structuredClone(job.expeditionFinds);
  for (const at of [now, end]) assert.equal(publicEconomyJob(job, at).expeditionFinds, undefined);
  assert.equal(state.progression.player, undefined, "departing does not give experience");
  state.jobs = [model.economyJobSchema.parse(JSON.parse(JSON.stringify(job)))];
  state.inventory = { wood: 49 }; const blocked = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", job.id, end), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, blocked); assert.deepEqual(state.jobs[0].expeditionFinds, original);
  state.inventory = {};
  apply(state, "claim_job", job.id, end, () => { throw Error("claim must not draw"); });
  const expected = { ...job.rewards }; for (const [id, count] of Object.entries(original)) expected[id] = (expected[id] ?? 0) + count;
  assert.deepEqual(state.inventory, expected); assert.equal(state.jobs.length, 0);
  assert.equal(state.progression.player.xp, Math.floor(route.seconds / playerProgressionCatalog.workSecondsPerXp) + playerProgressionCatalog.firstExplorationXp);
  assert.equal(state.completedExplorations, 1);
  const delivered = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", job.id, end + 1), { code: "ECONOMY_JOB_GONE" });
  assert.deepEqual(state, delivered);
});

test("saved fixed-reward trips retain original delivery and cancelled new trips grant neither loot nor XP", () => {
  const state = fresh(); apply(state, "start_exploration", "forest");
  const job = state.jobs[0]; delete job.expeditionFinds; job.rewards = { wood: 5, stone: 3, fiber: 4 };
  apply(state, "claim_job", job.id, Date.parse(job.finishesAt));
  assert.deepEqual(state.inventory, previous.forest);
  const cancelled = fresh(); apply(cancelled, "start_exploration", "forest", now, size => size - 1);
  apply(cancelled, "cancel_exploration", cancelled.jobs[0].id, now + 1);
  assert.deepEqual(cancelled.inventory, {}); assert.equal(cancelled.progression.player, undefined);
});
