import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.UTC(2026, 9, 15, 0);
beforeEach(() => identities.resetDevStoreForTests());
const player = () => identities.createDevIdentity("Садовник", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, action, targetId, at = now, quantity = 1, totalPrice = 0) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, action, targetId, quantity, totalPrice });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, at), at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function garden(p, inventory = {}) {
  const first = issue(p, "start_production", "grow_berries").state.jobs[0];
  const readyAt = Date.parse(first.finishesAt), state = row(p).state;
  state.inventory = inventory; state.buildings.home = 5; state.buildings.garden = 5; state.buildings.bridge = 1;
  state.wallet.coins = 1000;
  const second = { ...structuredClone(first), id: crypto.randomUUID(), recipeId: "grow_strawberries", rewards: { strawberries: 1 } };
  const third = { ...structuredClone(first), id: crypto.randomUUID(), recipeId: "grow_blueberries", rewards: { blueberries: 1 } };
  state.jobs = [first, second, third];
  return { first, second, third, readyAt };
}
const trade = (p, action, targetId, quantity, totalPrice, at) => economy.commandDevEconomyMarket(p.token,
  command(p, action, targetId, at, quantity, totalPrice), at);

test("one request snapshots all ripe berry jobs into a single timed basket, excluding later and nonberry work", () => {
  const p = player(), { first, second, third, readyAt } = garden(p), state = row(p).state;
  const later = { ...structuredClone(third), id: crypto.randomUUID(), recipeId: "grow_cranberries", rewards: { cranberries: 1 }, finishesAt: new Date(readyAt + 4000).toISOString() };
  const fiber = { ...structuredClone(first), id: crypto.randomUUID(), recipeId: "garden_fiber", rewards: { fiber: 1 } }; delete fiber.collection;
  const retired = { ...structuredClone(first), id: crypto.randomUUID(), recipeId: "retired", rewards: { berries: 7 } }; delete retired.collection;
  state.jobs.push(later, fiber, retired);
  const before = read(p, readyAt), request = command(p, "start_garden_collection", second.id, readyAt);
  const start = economy.commandDevEconomy(p.token, request, readyAt);
  assert.equal(start.state.revision, before.revision + 1);
  assert.deepEqual(start.state.inventory, before.inventory); assert.deepEqual(start.state.wallet, before.wallet);
  const batch = start.state.jobs.filter(job => job.collection?.batchId === request.requestId);
  assert.deepEqual(batch.map(job => job.id), [first.id, second.id, third.id]);
  for (const job of batch) {
    assert.equal(job.collection.startedAt, new Date(readyAt).toISOString());
    assert.equal(job.collection.finishesAt, new Date(readyAt + 8000).toISOString());
    const original = before.jobs.find(item => item.id === job.id);
    for (const field of ["id", "rewards", "cost", "startedAt", "finishesAt", "catalogVersion"]) assert.deepEqual(job[field], original[field]);
  }
  assert.equal(start.state.jobs.find(job => job.id === later.id).collection.startedAt, null);
  assert.throws(() => issue(p, "claim_job", first.id, readyAt + 8000), { code: "ECONOMY_COLLECTION_BATCH_REQUIRED" });
  assert.throws(() => issue(p, "claim_garden_collection", request.requestId, readyAt + 7999), { code: "ECONOMY_COLLECTION_NOT_READY" });
  const delivered = issue(p, "claim_garden_collection", request.requestId, readyAt + 8000).state;
  assert.deepEqual(delivered.inventory, { berries: 1, strawberries: 1, blueberries: 1 });
  assert.deepEqual(delivered.jobs.map(job => job.id), [later.id, fiber.id, retired.id]);
  for (const recipe of [first.recipeId, second.recipeId, third.recipeId]) assert.equal(delivered.progression.recipes[recipe], 1);
  for (const item of ["berries", "strawberries", "blueberries"]) assert.ok(delivered.unlockedItems.includes(item));
  assert.equal(delivered.progression.recipes.grow_cranberries, undefined);
  assert.ok(model.economyViewSchema.safeParse(delivered).success);
});

test("batch start and claim are owner protected, revision guarded and idempotent across a reload", () => {
  const p = player(), other = player(), { first, readyAt } = garden(p);
  const start = command(p, "start_garden_collection", first.id, readyAt);
  const started = economy.commandDevEconomy(p.token, start, readyAt);
  assert.equal(economy.commandDevEconomy(p.token, start, readyAt + 1000).replayed, true);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...start, requestId: crypto.randomUUID() }, readyAt), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(other.token, start, readyAt), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => issue(p, "start_garden_collection", first.id, readyAt + 9000), { code: "ECONOMY_COLLECTION_STARTED" });
  const resumedAt = readyAt + 24 * 3600_000, resumed = read(p, resumedAt);
  assert.deepEqual(resumed.jobs, started.state.jobs); assert.deepEqual(resumed.inventory, started.state.inventory);
  const claim = command(p, "claim_garden_collection", start.requestId, resumedAt);
  const delivered = economy.commandDevEconomy(p.token, claim, resumedAt);
  assert.equal(delivered.state.revision, resumed.revision + 1); assert.equal(delivered.state.jobs.length, 0);
  const replay = economy.commandDevEconomy(p.token, claim, resumedAt + 2000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.inventory, delivered.state.inventory);
  assert.deepEqual(replay.state.progression, delivered.state.progression);
  assert.throws(() => issue(p, "claim_garden_collection", start.requestId, resumedAt + 3000), { code: "ECONOMY_JOB_GONE" });
  assert.equal(economy.commandDevEconomy(p.token, start, resumedAt + 4000).state.jobs.length, 0);
});

test("the basket preflight checks combined storage including owned market escrow without starting any member", () => {
  const p = player(), { first, readyAt } = garden(p, { wood: 48 });
  trade(p, "create_listing", "wood", 2, 80, readyAt);
  const before = read(p, readyAt);
  assert.equal(before.storage.used, 46); assert.equal(before.storage.reserved, 2);
  assert.throws(() => issue(p, "start_garden_collection", first.id, readyAt), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p, readyAt), before);
  assert.ok(before.jobs.every(job => job.collection.startedAt === null));
});

test("a purchase during the walk may fill storage, but failed delivery keeps every saved member for a complete retry", () => {
  const p = player(), seller = player(), { first, readyAt } = garden(p, { wood: 47 });
  garden(seller, { wood: 2 }); row(seller).state.jobs = [];
  const start = command(p, "start_garden_collection", first.id, readyAt);
  economy.commandDevEconomy(p.token, start, readyAt);
  const listing = trade(seller, "create_listing", "wood", 2, 80, readyAt).listing;
  economy.getDevEconomyMarket(p.token, {}, readyAt);
  trade(p, "buy_listing", listing.id, 2, 80, readyAt + 1);
  const before = read(p, readyAt + 8000);
  assert.throws(() => issue(p, "claim_garden_collection", start.requestId, readyAt + 8000), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p, readyAt + 8000), before); assert.equal(before.jobs.length, 3);
  economy.commandDevEconomy(p.token, command(p, "sell", "wood", readyAt + 8000, 2), readyAt + 8000);
  const delivered = issue(p, "claim_garden_collection", start.requestId, readyAt + 9000).state;
  assert.equal(delivered.jobs.length, 0); assert.equal(delivered.storage.used, 50);
  assert.deepEqual(delivered.inventory, { wood: 47, berries: 1, strawberries: 1, blueberries: 1 });
});

test("paid saved durations set the common deadline and old optional collection fields stay compatible", () => {
  const p = player(), { first, second, readyAt } = garden(p), state = row(p).state;
  state.jobs[0].collection.seconds = 17;
  delete state.jobs[1].collection; state.jobs[1].rewards = { strawberries: 13 };
  assert.equal(model.economyCollectionSchema.parse(first.collection).batchId, undefined);
  const start = command(p, "start_garden_collection", second.id, readyAt), started = economy.commandDevEconomy(p.token, start, readyAt).state;
  for (const job of started.jobs) assert.equal(Date.parse(job.collection.finishesAt), readyAt + 17000);
  assert.equal(started.jobs[0].collection.seconds, 17); assert.equal(started.jobs[1].collection.seconds, 8);
  assert.throws(() => issue(p, "claim_garden_collection", start.requestId, readyAt + 8000), { code: "ECONOMY_COLLECTION_NOT_READY" });
  const result = issue(p, "claim_garden_collection", start.requestId, readyAt + 17000).state;
  assert.equal(result.inventory.strawberries, 13);
  for (const patch of [{ batchId: "bogus" }, { batchId: start.requestId, startedAt: null, finishesAt: null }])
    assert.equal(model.economyCollectionSchema.safeParse({ ...started.jobs[0].collection, ...patch }).success, false);
});

test("a started legacy singleton remains separate and command fields cannot change batch rewards or quantity", () => {
  const p = player(), { first, second, readyAt } = garden(p);
  issue(p, "start_collection", first.id, readyAt);
  assert.throws(() => issue(p, "start_garden_collection", second.id, readyAt + 8000), { code: "ECONOMY_COLLECTOR_BUSY" });
  issue(p, "claim_job", first.id, readyAt + 8000);
  for (const action of ["start_garden_collection", "claim_garden_collection"]) for (const patch of [{ quantity: 2 }, { totalPrice: 1 }, { rewards: { berries: 1000 } }, { batchId: crypto.randomUUID() }])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...command(p, action, second.id, readyAt + 8000), ...patch }, readyAt + 8000), { code: "INVALID_ECONOMY_COMMAND" });
  const request = command(p, "start_garden_collection", second.id, readyAt + 8000);
  assert.equal(economy.commandDevEconomy(p.token, request, readyAt + 8000).state.jobs.filter(job => job.collection?.batchId === request.requestId).length, 2);
  assert.throws(() => issue(p, "start_exploration", "forest", readyAt + 16000), { code: "ECONOMY_COLLECTOR_BUSY" });
});

test("legacy world journeys retain Mochlik and cannot be bypassed by starting a basket", () => {
  for (const finished of [false, true]) {
    const p = player(), { first, readyAt } = garden(p);
    globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state.journeys = [{ id: crypto.randomUUID(), routeId: "first_path",
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(readyAt + (finished ? -1 : 600_000)).toISOString(),
      rewards: { sparks: 0, wood: 0, stone: 0 }, finds: [], introductory: true, catalogVersion: 3 }];
    const before = read(p, readyAt);
    assert.throws(() => issue(p, "start_garden_collection", first.id, readyAt), { code: "ECONOMY_EXPLORER_BUSY" });
    assert.deepEqual(read(p, readyAt), before);
  }
});
