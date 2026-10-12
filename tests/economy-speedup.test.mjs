import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-10-04T00:00:00Z");
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());

function fixture({ pearls = 20, remaining = 900_000, kind = "construction", targetId = "home" } = {}) {
  const player = identities.createDevIdentity("Строитель", crypto.randomUUID());
  economy.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
  const job = { id: crypto.randomUUID(), kind, targetId, recipeId: null, targetLevel: 2,
    startedAt: new Date(now - 900_000).toISOString(), finishesAt: new Date(now + remaining).toISOString(),
    rewards: {}, cost: { coins: 1500, items: { wood: 20 } }, catalogVersion: 2 };
  row.state.wallet = { coins: 710, pearls: pearls * 50 };
  row.state.inventory = { berries: 8, stone: 4 };
  row.state.jobs = [job];
  return { player, row, job, read: (at = now) => economy.getDevEconomy(player.token, at) };
}
const command = (f, price = 3, extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: f.player.me.user.publicId,
  expectedRevision: f.read().revision, action: "speedup_construction", targetId: f.job.id, quantity: 1, totalPrice: price * 50, ...extra });
const issue = (f, c, at = now) => economy.commandDevEconomy(f.player.token, c, at);

test("construction quote decreases in single displayed pearls while preserving the full tariff", () => {
  assert.equal(model.economyCatalog.constructionSpeedup.secondsPerPearl, 300);
  const f = fixture();
  for (const [remaining, price] of [[-1, 0], [0, 0], [1, 1], [12000, 1], [12001, 2], [120000, 10], [299999, 25], [300000, 25], [300001, 26], [900000, 75]]) {
    assert.equal(rules.constructionSpeedupPrice({ ...f.job, finishesAt: new Date(now + remaining).toISOString() }, now), price * 2);
  }
  assert.equal(rules.constructionSpeedupPrice(f.job, now, { secondsPerPearl: 600, priceStepPearls: 2 }), 76, "the UI may quote the server-supplied policy");
  for (const kind of ["production", "exploration"]) assert.equal(rules.constructionSpeedupPrice({ ...f.job, kind }, now), 0);
});

test("speedup spends only current pearls and atomically completes the paid construction", () => {
  const f = fixture();
  const before = f.read();
  const result = issue(f, command(f, 10));
  assert.equal(result.state.wallet.pearls, 850, "accepted quote is an upper limit, not a client-controlled debit");
  assert.equal(result.state.wallet.coins, 710);
  assert.deepEqual(result.state.inventory, before.inventory);
  assert.equal(result.state.buildings.home, 2);
  assert.deepEqual(result.state.jobs, []);
  assert.equal(result.state.revision, before.revision + 1);
  assert.equal(result.state.completedExplorations, 0);
});

test("delayed confirmation pays a lower price and ready construction is completed free", () => {
  const cheaper = fixture();
  assert.equal(issue(cheaper, command(cheaper, 3), now + 300_000).state.wallet.pearls, 900);
  for (const at of [now + 900_000, now + 900_001]) {
    const ready = fixture({ pearls: 0 });
    const completed = issue(ready, command(ready, 3), at).state;
    assert.equal(completed.wallet.pearls, 0);
    assert.equal(completed.buildings.home, 2);
    assert.deepEqual(completed.jobs, []);
  }
});

test("insufficient pearls and unaccepted higher quotes leave job wallet revision and receipts untouched", () => {
  for (const [pearls, price, code] of [[2, 3, "ECONOMY_PEARLS"], [20, 2, "ECONOMY_SPEEDUP_PRICE_CHANGED"], [20, 0, "ECONOMY_SPEEDUP_PRICE_CHANGED"]]) {
    const f = fixture({ pearls });
    const before = f.read(), c = command(f, price);
    assert.throws(() => issue(f, c), { code });
    assert.deepEqual(f.read(), before);
    assert.equal(f.row.receipts.has(c.requestId), false);
  }
});

test("only active owned construction may be accelerated and ordinary commands cannot accept prices", () => {
  for (const kind of ["production", "exploration"]) {
    const f = fixture({ kind }), before = f.read();
    assert.throws(() => issue(f, command(f, 20)), { code: "ECONOMY_SPEEDUP_KIND" });
    assert.deepEqual(f.read(), before);
  }
  const f = fixture(), stranger = fixture(), before = f.read();
  assert.throws(() => issue(f, command(f, 3, { targetId: stranger.job.id })), { code: "ECONOMY_JOB_GONE" });
  assert.throws(() => economy.commandDevEconomy(stranger.player.token, command(f), now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => issue(f, command(f, 3, { quantity: 2 })), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => issue(f, command(f, 3, { action: "claim_job" })), { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(f.read(), before);
});

test("lost response retry spends once and a second device cannot finish or pay again", () => {
  const f = fixture(), accepted = command(f), competing = command(f);
  const first = issue(f, accepted);
  assert.throws(() => issue(f, competing), { code: "ECONOMY_REVISION_CONFLICT" });
  const replay = issue(f, accepted, now + 1_000_000);
  assert.equal(replay.replayed, true);
  assert.equal(replay.acceptedRevision, first.acceptedRevision);
  assert.equal(replay.state.wallet.pearls, 850);
  assert.equal(replay.state.revision, first.state.revision);
  assert.throws(() => issue(f, { ...accepted, totalPrice: 40 }), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => issue(f, command(f)), { code: "ECONOMY_JOB_GONE" });
  assert.equal(f.row.receipts.size, 1);
});

test("a claim racing a stale speedup at readiness cannot charge or complete twice", () => {
  for (const firstAction of ["claim_job", "speedup_construction"]) {
    const f = fixture({ pearls: 0 }), speedup = command(f), claim = command(f, 0, { action: "claim_job" });
    const commands = firstAction === "claim_job" ? [claim, speedup] : [speedup, claim];
    const result = issue(f, commands[0], now + 900_000);
    assert.throws(() => issue(f, commands[1], now + 900_000), { code: "ECONOMY_REVISION_CONFLICT" });
    assert.equal(result.state.wallet.pearls, 0);
    assert.equal(result.state.buildings.home, 2);
    assert.equal(result.state.jobs.length, 0);
  }
});

test("speedup honours locked old construction snapshots and can expand an overflowing warehouse", () => {
  const f = fixture({ targetId: "warehouse" });
  f.row.state.inventory = { wood: 450 };
  f.row.state.jobs[0].catalogVersion = 1;
  const result = issue(f, command(f)).state;
  assert.equal(result.buildings.warehouse, 2);
  assert.deepEqual(result.storage, { capacity: 500, used: 450, reserved: 0, available: 50, overflow: 0 });
  assert.deepEqual(result.inventory, { wood: 450 });
});
