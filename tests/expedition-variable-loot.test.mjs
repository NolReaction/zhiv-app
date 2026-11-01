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
