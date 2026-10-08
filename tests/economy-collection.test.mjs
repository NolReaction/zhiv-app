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
const now = Date.UTC(2026, 9, 4, 10);
beforeEach(() => identities.resetDevStoreForTests());
const player = () => identities.createDevIdentity("Сборщик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, action, targetId, at = now, quantity = 1, totalPrice = 0) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision,
  action, targetId, quantity, totalPrice,
});
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, at), at);
const trade = (p, action, targetId, quantity, totalPrice, at = now) => economy.commandDevEconomyMarket(p.token,
  command(p, action, targetId, at, quantity, totalPrice), at);
function fixture(p, patch = {}) {
  read(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  Object.assign(row.state, patch); return row;
}
const grow = p => issue(p, "start_production", "grow_berries").state.jobs[0];

test("only berry recipes opt in and each order keeps its collection rules alongside paid rewards", () => {
  const configured = model.economyCatalog.recipes.filter(recipe => recipe.collection);
  assert.deepEqual(configured.map(recipe => recipe.id), ["grow_berries", "grow_berries_overnight", "grow_berries_large", "garden_season", "garden_supply", "garden_abundance"]);
  for (const recipe of configured) {
    assert.equal(recipe.buildingId, "garden"); assert.ok(recipe.rewards.berries > 0);
    assert.deepEqual(recipe.collection, { kind: "berry_harvest", seconds: 8 });
  }
  assert.equal(model.economyCatalog.recipes.find(recipe => recipe.id === "garden_fiber").collection, undefined);
  const p = player(), job = grow(p);
  assert.deepEqual(job.collection, { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null });
  assert.ok(model.economyViewSchema.safeParse(read(p)).success);
});

test("server collection requires ripe fruit and elapsed work, then grants the saved batch exactly once", () => {
  const p = player(), job = grow(p), readyAt = Date.parse(job.finishesAt);
  assert.throws(() => issue(p, "start_collection", job.id, readyAt - 1), { code: "ECONOMY_JOB_NOT_READY" });
  assert.throws(() => issue(p, "claim_job", job.id, readyAt), { code: "ECONOMY_COLLECTION_REQUIRED" });
  const before = read(p, readyAt), start = command(p, "start_collection", job.id, readyAt);
  const collecting = economy.commandDevEconomy(p.token, start, readyAt), current = collecting.state.jobs[0];
  assert.deepEqual(collecting.state.inventory, before.inventory); assert.deepEqual(collecting.state.wallet, before.wallet);
  assert.deepEqual(current.rewards, job.rewards); assert.deepEqual(current.cost, job.cost);
  assert.equal(current.collection.startedAt, new Date(readyAt).toISOString());
  const finish = Date.parse(current.collection.finishesAt);
  assert.equal(finish, readyAt + 8000);
  assert.throws(() => issue(p, "claim_job", job.id, finish - 1), { code: "ECONOMY_COLLECTION_NOT_READY" });
  const claim = command(p, "claim_job", job.id, finish);
  const result = economy.commandDevEconomy(p.token, claim, finish);
  assert.deepEqual(result.state.inventory, job.rewards); assert.equal(result.state.jobs.length, 0);
  const replay = economy.commandDevEconomy(p.token, claim, finish + 5000);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, result.acceptedRevision);
  assert.deepEqual(replay.state.inventory, result.state.inventory);
  assert.throws(() => issue(p, "claim_job", job.id, finish + 9000), { code: "ECONOMY_JOB_GONE" });
  const oldStart = economy.commandDevEconomy(p.token, start, finish + 10000);
  assert.equal(oldStart.replayed, true); assert.deepEqual(oldStart.state.inventory, result.state.inventory);
});

test("repeated starts, stale devices and foreign owners cannot restart the clock or create another collector", () => {
  const p = player(), other = player(), job = grow(p), readyAt = Date.parse(job.finishesAt);
  const start = command(p, "start_collection", job.id, readyAt);
  const first = economy.commandDevEconomy(p.token, start, readyAt), after = read(p, readyAt);
  const replay = economy.commandDevEconomy(p.token, start, readyAt + 7000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.jobs, first.state.jobs);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...start, requestId: crypto.randomUUID() }, readyAt), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(other.token, start, readyAt), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => issue(p, "start_collection", job.id, readyAt + 9000), { code: "ECONOMY_COLLECTION_STARTED" });
  assert.deepEqual(read(p, readyAt), after);
});

test("active exploration blocks harvesting; a returned explorer can gather and remains busy until delivery", () => {
  const p = player(), job = grow(p);
  const trip = issue(p, "start_exploration", "forest").state.jobs.find(item => item.kind === "exploration");
  assert.throws(() => issue(p, "start_collection", job.id, Date.parse(job.finishesAt)), { code: "ECONOMY_EXPLORER_BUSY" });
  const returnedAt = Date.parse(trip.finishesAt);
  const collecting = issue(p, "start_collection", job.id, returnedAt).state.jobs.find(item => item.id === job.id);
  const finish = Date.parse(collecting.collection.finishesAt);
  issue(p, "claim_job", trip.id, returnedAt);
  for (const at of [returnedAt, finish + 1000])
    assert.throws(() => issue(p, "start_exploration", "forest", at), { code: "ECONOMY_COLLECTOR_BUSY" });
  issue(p, "claim_job", job.id, finish);
  assert.equal(issue(p, "start_exploration", "forest", finish).state.jobs[0].kind, "exploration");
});

test("market purchases during gathering may fill storage, but a failed delivery keeps the completed batch for retry", () => {
  const p = player(), seller = player();
  for (const [account, inventory] of [[p, { wood: 190 }], [seller, { wood: 10 }]]) {
    const row = fixture(account, { inventory, wallet: { coins: 1000, pearls: 0 }, completedExplorations: 1 });
    row.state.buildings.home = 2;
  }
  const job = grow(p), readyAt = Date.parse(job.finishesAt);
  const collecting = issue(p, "start_collection", job.id, readyAt).state.jobs[0];
  const finish = Date.parse(collecting.collection.finishesAt);
  const listing = trade(seller, "create_listing", "wood", 10, 400, readyAt).listing;
  economy.getDevEconomyMarket(p.token, {}, readyAt);
  trade(p, "buy_listing", listing.id, 10, 400, readyAt + 1);
  const before = read(p, finish);
  assert.throws(() => issue(p, "claim_job", job.id, finish), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p, finish), before);
  economy.commandDevEconomy(p.token, command(p, "sell", "wood", finish, job.rewards.berries), finish);
  const result = issue(p, "claim_job", job.id, finish + 1).state;
  assert.equal(result.inventory.berries, job.rewards.berries); assert.equal(result.storage.used, 200); assert.equal(result.jobs.length, 0);
});

test("reloading after the server deadline can deliver without trusting any animation token or local inventory", () => {
  const p = player(), job = grow(p), readyAt = Date.parse(job.finishesAt);
  issue(p, "start_collection", job.id, readyAt);
  const restored = read(p, readyAt + 24 * 3600_000);
  assert.deepEqual(restored.inventory, {}); assert.ok(restored.jobs[0].collection.startedAt);
  const claimed = issue(p, "claim_job", job.id, readyAt + 24 * 3600_000).state;
  assert.equal(claimed.inventory.berries, job.rewards.berries);
  const bad = { ...command(p, "start_collection", job.id), animationComplete: true, rewards: { berries: 1000 } };
  assert.throws(() => economy.commandDevEconomy(p.token, bad, now), { code: "INVALID_ECONOMY_COMMAND" });
});

test("paid legacy jobs without collection retain direct claims or may opt into the new scene flow", () => {
  for (const startCollection of [false, true]) {
    const p = player(), job = grow(p), readyAt = Date.parse(job.finishesAt);
    const row = fixture(p); delete row.state.jobs[0].collection; row.state.jobs[0].rewards = { berries: 13 };
    let finish = readyAt;
    if (startCollection) {
      const collected = issue(p, "start_collection", job.id, readyAt).state.jobs[0];
      assert.equal(collected.collection.seconds, 8); finish = Date.parse(collected.collection.finishesAt);
    }
    assert.equal(issue(p, "claim_job", job.id, finish).state.inventory.berries, 13);
  }
});

test("persisted work duration wins over a later catalog value; malformed collection timestamps are rejected", () => {
  const p = player(), job = grow(p), readyAt = Date.parse(job.finishesAt);
  fixture(p).state.jobs[0].collection.seconds = 17;
  const collecting = issue(p, "start_collection", job.id, readyAt).state.jobs[0];
  assert.equal(Date.parse(collecting.collection.finishesAt) - readyAt, 17000);
  assert.throws(() => issue(p, "claim_job", job.id, readyAt + 8000), { code: "ECONOMY_COLLECTION_NOT_READY" });
  const base = collecting.collection;
  for (const patch of [{ seconds: 0 }, { seconds: 121 }, { kind: "give_items" }, { startedAt: null },
    { finishesAt: new Date(readyAt + 16000).toISOString() }])
    assert.equal(model.economyCollectionSchema.safeParse({ ...base, ...patch }).success, false);
});

test("only the intended job kind accepts collection and quantity/price cannot alter the harvest", () => {
  const p = player(), job = grow(p), readyAt = Date.parse(job.finishesAt);
  const trip = issue(p, "start_exploration", "forest").state.jobs.find(item => item.kind === "exploration");
  assert.throws(() => issue(p, "start_collection", trip.id, Date.parse(trip.finishesAt)), { code: "ECONOMY_COLLECTION_KIND" });
  for (const patch of [{ quantity: 2 }, { totalPrice: 1 }])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...command(p, "start_collection", job.id, readyAt), ...patch }, readyAt), { code: "INVALID_ECONOMY_COMMAND" });
});
