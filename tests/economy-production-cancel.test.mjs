import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-production-cancel-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.UTC(2026, 9, 15, 0);
beforeEach(() => identities.resetDevStoreForTests());
const player = () => identities.createDevIdentity("Crafter", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
const command = (p, action, targetId, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0 });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, at), at);
function readyPlayer(p, inventory = { wood: 4, berries: 5, fish_rare: 1 }) {
  read(p);
  Object.assign(row(p).state, { inventory,
    buildings: { ...row(p).state.buildings, home: 3, workshop: 1, woodlot: 1, dryer: 3, bridge: 1 } });
}

test("unfinished crafting refunds paid materials and frees only its slot without producing progress or food", () => {
  const p = player(); readyPlayer(p);
  const original = read(p), plank = issue(p, "start_production", "make_planks").state.jobs[0];
  const dinner = issue(p, "start_production", "cook_hearty_fish").state.jobs.find(job => job.targetId === "dryer");
  assert.equal(dinner.cost.items.fish_rare, 1);
  const started = read(p), cancelled = issue(p, "cancel_production", dinner.id, now + 1).state;
  assert.deepEqual(cancelled.inventory, { ...original.inventory, wood: original.inventory.wood - 1 });
  assert.deepEqual(cancelled.jobs, [plank]); assert.deepEqual(cancelled.wallet, started.wallet);
  for (const field of ["progression", "food", "completedExplorations", "fishing", "unlockedItems", "tutorialOrder", "stageOrders"])
    assert.deepEqual(cancelled[field], started[field]);
  assert.equal(cancelled.inventory.hearty_fish, undefined);
  assert.equal(issue(p, "start_production", "cook_hearty_fish", now + 2).state.jobs.length, 2);
  assert.equal(issue(p, "cancel_production", plank.id, now + 3).state.inventory.wood, original.inventory.wood - dinner.cost.items.wood);
});

test("historic production returns its saved coins and exact cost even when its recipe no longer exists", () => {
  const p = player(); readyPlayer(p, { wood: 1 });
  const job = issue(p, "start_production", "make_planks").state.jobs[0];
  const state = row(p).state;
  state.jobs[0] = { ...state.jobs[0], recipeId: "retired_recipe", catalogVersion: 1,
    cost: { coins: 73, items: { fish_rare: 2, wood: 3, berries: 1 } } };
  state.wallet.coins = 20;
  const before = read(p), result = issue(p, "cancel_production", job.id).state;
  assert.deepEqual(result.inventory, { fish_rare: 2, wood: 3, berries: 1 });
  assert.equal(result.wallet.coins, 93); assert.equal(result.wallet.pearls, before.wallet.pearls);
  assert.deepEqual(result.jobs, []); assert.deepEqual(result.progression, before.progression);
});

test("finished, collecting, nonproduction and quarry jobs cannot be cancelled through ordinary production", () => {
  const p = player(); readyPlayer(p);
  const job = issue(p, "start_production", "make_planks").state.jobs[0];
  const at = Date.parse(job.finishesAt);
  for (const clock of [at, at + 1]) {
    const before = read(p, clock);
    assert.throws(() => issue(p, "cancel_production", job.id, clock), { code: "ECONOMY_CANCEL_READY" });
    assert.deepEqual(read(p, clock), before);
  }
  const variants = [
    [{ kind: "construction", targetId: "workshop", targetLevel: 2 }, "ECONOMY_CANCEL_KIND"],
    [{ kind: "exploration", targetId: "mine_stone", actorId: "miner" }, "ECONOMY_CANCEL_KIND"],
    [{ targetId: "quarry" }, "ECONOMY_CANCEL_KIND"],
    [{ targetId: "retired_station" }, "ECONOMY_CANCEL_KIND"],
    [{ targetId: "garden", recipeId: "grow_berries", rewards: { berries: 1 },
      collection: { kind: "berry_harvest", seconds: 8, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() } }, "ECONOMY_CANCEL_READY"],
  ];
  for (const [patch, code] of variants) {
    row(p).state.jobs = [{ ...job, ...patch }];
    const before = read(p); assert.throws(() => issue(p, "cancel_production", job.id), { code });
    assert.deepEqual(read(p), before);
  }
  assert.throws(() => issue(p, "cancel_production", crypto.randomUUID()), { code: "ECONOMY_JOB_GONE" });
});

test("refund capacity includes market escrow and failed return keeps the paid work for a complete retry", () => {
  const p = player(); readyPlayer(p);
  const job = issue(p, "start_production", "make_planks").state.jobs[0];
  row(p).state.inventory = { wood: 50 };
  economy.commandDevEconomyMarket(p.token, { ...command(p, "create_listing", "wood"), quantity: 2, totalPrice: 80 }, now);
  const before = read(p); assert.equal(before.storage.used, 48); assert.equal(before.storage.reserved, 2);
  const cancel = command(p, "cancel_production", job.id);
  assert.throws(() => economy.commandDevEconomy(p.token, cancel, now), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p), before);
  // An external inventory correction changes no revision; a failed request stored no receipt.
  row(p).state.inventory.wood -= 1;
  const freed = read(p), result = economy.commandDevEconomy(p.token, cancel, now).state;
  assert.equal(result.inventory.wood, freed.inventory.wood + 1); assert.equal(result.storage.used + result.storage.reserved, 50);
  assert.deepEqual(result.jobs, []); assert.deepEqual(result.progression, freed.progression);
});

test("wallet and item caps are atomic even with escrow and empty-cost harvest may still be cancelled", () => {
  const p = player(); readyPlayer(p);
  const job = issue(p, "start_production", "make_planks").state.jobs[0];
  row(p).state.jobs[0].cost.coins = 5; row(p).state.wallet.coins = ECONOMY_MAX_BALANCE - 4;
  let before = read(p);
  assert.throws(() => issue(p, "cancel_production", job.id), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), before);
  row(p).state.jobs[0].cost.coins = 0; row(p).state.inventory = { wood: ECONOMY_MAX_ITEMS };
  before = read(p);
  assert.throws(() => issue(p, "cancel_production", job.id), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), before);
  row(p).state.inventory.wood = ECONOMY_MAX_ITEMS - 1;
  economy.commandDevEconomyMarket(p.token, { ...command(p, "create_listing", "wood"), quantity: 1, totalPrice: 40 }, now);
  row(p).state.inventory.wood = ECONOMY_MAX_ITEMS - 1;
  before = read(p);
  assert.throws(() => issue(p, "cancel_production", job.id), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), before);
  row(p).state.inventory.wood = ECONOMY_MAX_ITEMS - 1; row(p).state.jobs = [];
  const berries = issue(p, "start_production", "grow_berries").state.jobs[0];
  before = read(p);
  const result = issue(p, "cancel_production", berries.id, now + 1).state;
  assert.deepEqual(result.inventory, before.inventory); assert.deepEqual(result.wallet, before.wallet); assert.deepEqual(result.jobs, []);
});

test("cancellation is owner protected, revision guarded, strictly shaped and replay refunds exactly once", () => {
  const p = player(), other = player(); readyPlayer(p);
  const job = issue(p, "start_production", "make_planks").state.jobs[0], cancel = command(p, "cancel_production", job.id);
  const before = read(p);
  assert.throws(() => economy.commandDevEconomy(other.token, cancel, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => issue(other, "cancel_production", job.id), { code: "ECONOMY_JOB_GONE" });
  for (const patch of [{ quantity: 2 }, { totalPrice: 1 }, { rewards: { wood: 99 } }, { refund: true }, { cost: job.cost }])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...cancel, ...patch }, now), { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(read(p), before);
  const first = economy.commandDevEconomy(p.token, cancel, now), retry = economy.commandDevEconomy(p.token, cancel, now + 1);
  assert.equal(first.replayed, false); assert.equal(retry.replayed, true); assert.equal(first.state.revision, before.revision + 1);
  assert.equal(retry.acceptedRevision, first.acceptedRevision); assert.deepEqual(retry.state.inventory, first.state.inventory);
  assert.deepEqual(retry.state.wallet, first.state.wallet); assert.deepEqual(retry.state.progression, first.state.progression);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cancel, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cancel, targetId: crypto.randomUUID() }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => issue(p, "cancel_production", job.id), { code: "ECONOMY_JOB_GONE" });
});
