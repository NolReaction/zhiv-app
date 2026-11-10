import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const starter = await vite.ssrLoadModule("/features/economy/domain/workshop-starter.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-10-13T20:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, overrides = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action: "claim_workshop_starter", targetId: "workshop", quantity: 1, totalPrice: 0, ...overrides });
const issue = (p, overrides = {}, at = now) => economy.commandDevEconomy(p.token, command(p, overrides), at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };

test("historical workshop quote follows the current construction cost and cannot mutate the catalog", () => {
  const catalog = structuredClone(model.economyCatalog);
  const level = catalog.buildings.find(building => building.id === "workshop").levels.find(level => level.level === 1);
  assert.deepEqual(starter.workshopStarterCost(), { coins: 50, items: { wood: 2, stone: 1 } });
  level.cost = { coins: 70, items: { wood: 3, stone: 2 } };
  const quote = starter.workshopStarterCost(catalog); assert.deepEqual(quote, level.cost);
  quote.items.wood = 999; assert.equal(level.cost.items.wood, 3);
});

test("new and legacy accounts cannot receive another free workshop budget at any completion marker", () => {
  for (const marker of [false, true, undefined]) {
    const p = player(), saved = row(p); saved.state.workshopStarterClaimed = marker;
    saved.state.wallet = { coins: 350, pearls: 7 }; saved.state.inventory = { wood: 2, berries: 4 };
    const before = read(p), rejected = command(p);
    assert.equal(starter.canClaimWorkshopStarter(before), false);
    assert.throws(() => economy.commandDevEconomy(p.token, rejected, now), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
    assert.deepEqual(read(p), before); assert.equal(saved.receipts.has(rejected.requestId), false);
    assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" }); assert.deepEqual(read(p), before);
  }
});

test("saved funded workshop jobs keep their paid cost and timing without granting or charging again", () => {
  const p = player(), saved = row(p);
  saved.state.workshopStarterClaimed = true;
  saved.state.wallet = { coins: 350, pearls: 7 }; saved.state.inventory = { wood: 2, berries: 4 };
  const oldCost = { coins: 1200, items: { wood: 10, stone: 8 } };
  const job = model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "construction", targetId: "workshop", recipeId: null,
    targetLevel: 1, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 1200 * 1000).toISOString(),
    rewards: {}, cost: oldCost, catalogVersion: 5 }); saved.state.jobs = [job];
  const before = read(p); assert.deepEqual(before.jobs[0].cost, oldCost);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
  assert.throws(() => issue(p, { action: "claim_job", targetId: job.id }), { code: "ECONOMY_JOB_NOT_READY" });
  const cmd = command(p, { action: "claim_job", targetId: job.id }), end = Date.parse(job.finishesAt);
  const complete = economy.commandDevEconomy(p.token, cmd, end).state;
  assert.equal(complete.buildings.workshop, 1); assert.equal(complete.workshopStarterClaimed, true);
  assert.deepEqual(complete.wallet, before.wallet); assert.deepEqual(complete.inventory, before.inventory);
  assert.equal(economy.commandDevEconomy(p.token, cmd, end).replayed, true); assert.deepEqual(read(p, end), complete);
});

test("old persisted markers and API snapshots remain readable without re-enabling the gift", () => {
  const p = player(), saved = row(p); delete saved.state.workshopStarterClaimed;
  const old = read(p); assert.equal(old.workshopStarterClaimed, false); delete old.workshopStarterClaimed;
  assert.equal(model.economyViewSchema.parse(old).workshopStarterClaimed, false);
  assert.equal(starter.canClaimWorkshopStarter(old), false);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
});

test("the obsolete command still validates its workshop target, single quantity and zero supplied price", () => {
  const p = player(), before = read(p);
  for (const overrides of [{ targetId: "home" }, { quantity: 2 }, { totalPrice: 1 }]) {
    assert.throws(() => issue(p, overrides), { code: "INVALID_ECONOMY_COMMAND" }); assert.deepEqual(read(p), before);
  }
});

test("full inventory and capped wallets remain intact when obsolete starter commands are rejected", () => {
  const p = player(), saved = row(p); saved.state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  saved.state.inventory = { wood: model.ECONOMY_MAX_ITEMS }; const before = read(p);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" }); assert.deepEqual(read(p), before);
});

const workshop = () => model.economyCatalog.buildings.find(building => building.id === "workshop").levels.find(level => level.level === 1);
const tutorialStart = (p, extra = {}, at = now) => issue(p, { action: "start_tutorial_workshop", ...extra }, at);
const savedJob = (kind, targetId, extra = {}) => model.economyJobSchema.parse({ id: crypto.randomUUID(), kind, targetId,
  recipeId: null, targetLevel: kind === "construction" ? 1 : null, startedAt: new Date(now).toISOString(),
  finishesAt: new Date(now + 300_000).toISOString(), rewards: {}, cost: { coins: 0, items: {} }, catalogVersion: model.economyCatalog.version, ...extra });

test("tutorial aid starts the first workshop atomically even after personal supplies are spent", () => {
  for (const inventory of [{}, { wood: 3, stone: 5, berries: 2 }]) {
    const p = player(), saved = row(p); saved.state.wallet = { coins: 0, pearls: 7 }; saved.state.inventory = inventory;
    const before = read(p); assert.equal(starter.canStartTutorialWorkshop(before), true);
    const result = tutorialStart(p), state = result.state, job = state.jobs.at(-1);
    assert.deepEqual(state.wallet, before.wallet); assert.deepEqual(state.inventory, before.inventory);
    assert.equal(state.workshopStarterClaimed, true); assert.equal(state.buildings.workshop, 0);
    assert.equal(job.kind, "construction"); assert.equal(job.targetId, "workshop"); assert.equal(job.targetLevel, 1);
    assert.deepEqual(job.cost, { coins: 0, items: {} }); assert.deepEqual(job.rewards, {});
    assert.equal(Date.parse(job.finishesAt) - now, workshop().seconds * 1000);
    assert.equal(starter.canStartTutorialWorkshop(state), false);
  }
});

test("tutorial aid receipt replays once and neither a new request nor completion grants it again", () => {
  const p = player(), request = command(p, { action: "start_tutorial_workshop" });
  const result = economy.commandDevEconomy(p.token, request, now), job = result.state.jobs.at(-1);
  const replay = economy.commandDevEconomy(p.token, request, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, result.state);
  assert.throws(() => tutorialStart(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
  assert.deepEqual(read(p), result.state);
  const end = Date.parse(job.finishesAt), completed = issue(p, { action: "claim_job", targetId: job.id }, end).state;
  assert.equal(completed.buildings.workshop, 1); assert.equal(completed.workshopStarterClaimed, true);
  assert.deepEqual(completed.wallet, result.state.wallet); assert.deepEqual(completed.inventory, result.state.inventory);
  assert.throws(() => tutorialStart(p, {}, end), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
});

test("tutorial aid respects old claimed markers, completed workshops and paid work already in progress", () => {
  const paid = savedJob("construction", "workshop", { cost: workshop().cost });
  for (const overrides of [{ workshopStarterClaimed: true }, { buildings: { workshop: 1 } }, { jobs: [paid] }]) {
    const p = player(), saved = row(p); Object.assign(saved.state, overrides);
    const before = read(p); assert.equal(starter.canStartTutorialWorkshop(before), false);
    assert.throws(() => tutorialStart(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
    assert.deepEqual(read(p), before);
  }
  const p = player(), saved = row(p); delete saved.state.workshopStarterClaimed;
  assert.equal(tutorialStart(p).state.workshopStarterClaimed, true);
});

test("failed builder and queue checks leave the one-time aid and all supplies untouched", () => {
  for (const [jobs, code] of [
    [[savedJob("construction", "woodlot")], "ECONOMY_CONSTRUCTION_BUSY"],
    [[savedJob("construction", "woodlot", { finishesAt: new Date(now).toISOString() })], "ECONOMY_CONSTRUCTION_BUSY"],
    [Array.from({ length: 18 }, () => savedJob("production", "garden")), "ECONOMY_JOBS_CAPACITY"],
    [[savedJob("production", "workshop")], "ECONOMY_BUILDING_BUSY"],
  ]) {
    const p = player(), saved = row(p); saved.state.jobs = jobs;
    const before = read(p), request = command(p, { action: "start_tutorial_workshop" });
    assert.throws(() => economy.commandDevEconomy(p.token, request, now), { code });
    assert.deepEqual(read(p), before); assert.equal(saved.receipts.has(request.requestId), false);
  }
  const p = player(), saved = row(p); saved.state.buildings.home = 0; const before = read(p);
  assert.throws(() => tutorialStart(p), { code: "ECONOMY_HOME_REQUIRED" }); assert.deepEqual(read(p), before);
});

test("tutorial construction rejects forged targets quantities prices and irrelevant fish selections", () => {
  const p = player(), before = read(p);
  for (const extra of [{ targetId: "home" }, { quantity: 2 }, { totalPrice: 1 }, { fishSelection: { fish_roach: 1 } }]) {
    assert.throws(() => tutorialStart(p, extra), { code: "INVALID_ECONOMY_COMMAND" }); assert.deepEqual(read(p), before);
  }
});

test("earmarked construction bypasses overflowing storage and reserved market goods without adding stock", () => {
  const p = player(), saved = row(p); saved.state.inventory = { wood: model.ECONOMY_MAX_ITEMS };
  saved.state.wallet = { coins: model.ECONOMY_MAX_BALANCE, pearls: 7 };
  const before = read(p), state = tutorialStart(p).state;
  assert.deepEqual(state.wallet, before.wallet); assert.deepEqual(state.inventory, before.inventory);
  const input = structuredClone(saved.state); input.jobs = []; input.workshopStarterClaimed = false;
  input.wallet.coins = -20; input.inventory = { berries: 49 };
  const wallet = structuredClone(input.wallet), inventory = structuredClone(input.inventory), reserved = { wood: 1 };
  rules.applyEconomyCommand(input, command(p, { action: "start_tutorial_workshop" }), now, () => crypto.randomUUID(), reserved);
  assert.deepEqual(input.wallet, wallet); assert.deepEqual(input.inventory, inventory); assert.deepEqual(reserved, { wood: 1 });
  assert.equal(input.jobs.length, 1); assert.equal(input.workshopStarterClaimed, true);
});

test("ordinary workshop construction still charges the catalog and cannot be converted to tutorial aid", () => {
  const p = player(), before = read(p), paid = issue(p, { action: "start_construction" }).state;
  assert.equal(paid.wallet.coins, before.wallet.coins - workshop().cost.coins);
  for (const [item, quantity] of Object.entries(workshop().cost.items))
    assert.equal(paid.inventory[item] ?? 0, (before.inventory[item] ?? 0) - quantity);
  assert.equal(paid.workshopStarterClaimed, false); assert.deepEqual(paid.jobs.at(-1).cost, workshop().cost);
  assert.throws(() => tutorialStart(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
});

test("earmarked build uses the builder's pending meal once with the usual speed boost", () => {
  const p = player(), saved = row(p); saved.state.food = { heroMeal: null, builderMeal: "grilled_fish" };
  const before = read(p), state = tutorialStart(p).state, meal = model.economyCatalog.food.meals.find(item => item.itemId === "grilled_fish");
  assert.deepEqual(state.jobs.at(-1).meal, { itemId: meal.itemId, consumer: "builder", speedBps: meal.builderSpeedBps });
  assert.equal(Date.parse(state.jobs.at(-1).finishesAt) - now, Math.ceil(workshop().seconds / (1 + meal.builderSpeedBps / 10000)) * 1000);
  assert.equal(state.food.builderMeal, null); assert.deepEqual(state.wallet, before.wallet); assert.deepEqual(state.inventory, before.inventory);
});
