import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const store = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { weeklyOrderBoard } = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
const { parseProductionJournal } = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const now = Date.parse("2026-10-23T12:00:00Z");
beforeEach(() => { identity.resetDevStoreForTests(); process.env.NODE_ENV = "development"; });
after(async () => { identity.resetDevStoreForTests(); if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode; await vite.close(); });
const read = (p, at = now) => store.getDevEconomy(p.token, at);
function request(p, action, targetId, quantity = 1, at = now) {
  const view = read(p, at);
  return { requestId: crypto.randomUUID(), ownerPublicId: view.ownerPublicId, expectedRevision: view.revision, action, targetId, quantity, totalPrice: 0 };
}
function cheat(p, action, targetId, quantity = 1) { return store.commandDevEconomyCheat(p.token, request(p, action, targetId, quantity), now); }
function player() {
  const p = identity.createDevIdentity("Trader", crypto.randomUUID());
  cheat(p, "apply_settlement", "home", 5);
  return p;
}
const send = (p, command, at = now) => store.commandDevEconomy(p.token, command, at);
function accept(p) {
  const view = read(p), choice = weeklyOrderBoard(view, now, view.catalog).offers.find(offer => offer.residentId === "builder");
  assert.ok(choice);
  const command = request(p, "accept_weekly_order", choice.id);
  return { choice, command, result: send(p, command) };
}
function fundStage(p, active) {
  for (const [itemId, quantity] of Object.entries(active.items)) {
    const missing = quantity - (read(p).inventory[itemId] ?? 0);
    if (missing > 0) cheat(p, "grant_item", itemId, missing);
  }
}

test("weekly choice is persisted by the owner adapter and request replay cannot accept another or award XP", () => {
  const p = player(), before = read(p), { choice, command, result } = accept(p);
  assert.equal(result.replayed, false);
  assert.deepEqual(result.state.tradeRelations.reputation, before.tradeRelations.reputation);
  assert.equal(result.state.tradeRelations.weekly.templateId, choice.templateId);
  assert.equal(result.state.tradeRelations.weekly.stages.length, 3);
  assert.equal(result.state.tradeRelations.weekly.expiresAt, new Date(now + 604800000).toISOString());
  const replay = send(p, command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.acceptedRevision, result.acceptedRevision);
  assert.deepEqual(read(p).tradeRelations, result.state.tradeRelations);
  assert.throws(() => send(p, request(p, "accept_weekly_order", choice.id)));
  assert.deepEqual(read(p).tradeRelations, result.state.tradeRelations);
  assert.equal(economyViewSchema.safeParse(read(p)).success, true);
});

test("paid weekly stages keep XP and coins after reload and expiry; a duplicate cannot consume or pay twice", () => {
  const p = player(); accept(p);
  const first = weeklyOrderBoard(read(p), now).active;
  fundStage(p, first);
  const before = read(p), command = request(p, "complete_resident_order", first.id), result = send(p, command);
  assert.equal(result.state.wallet.coins, before.wallet.coins + first.coins);
  assert.equal(result.state.tradeRelations.reputation.builder, first.reputationXp);
  assert.equal(result.state.tradeRelations.weekly.stage, 1);
  const replay = send(p, command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state.wallet, result.state.wallet);
  assert.deepEqual(replay.state.inventory, result.state.inventory);
  assert.deepEqual(replay.state.tradeRelations, result.state.tradeRelations);
  const journal = parseProductionJournal(JSON.stringify({ version: 1, owner: result.state.ownerPublicId, snapshot: result.state, entries: [] }), result.state.ownerPublicId);
  assert.ok(journal);
  assert.deepEqual(journal.snapshot.tradeRelations, result.state.tradeRelations);
  assert.deepEqual(read(p).tradeRelations, result.state.tradeRelations);
  const expiredAt = now + 604800000, expired = read(p, expiredAt);
  assert.equal(weeklyOrderBoard(expired, expiredAt).active, null);
  assert.deepEqual(expired.tradeRelations.reputation, result.state.tradeRelations.reputation);
  assert.deepEqual(expired.wallet, result.state.wallet);
  const oldStage = weeklyOrderBoard(result.state, now).active;
  assert.throws(() => send(p, request(p, "complete_resident_order", oldStage.id, 1, expiredAt), expiredAt));
  assert.deepEqual(read(p, expiredAt).wallet, expired.wallet);
  assert.deepEqual(read(p, expiredAt).inventory, expired.inventory);
});

test("another account and malformed accept commands cannot change the saved weekly choice", () => {
  const p = player(), other = player(), initial = read(p);
  const choice = weeklyOrderBoard(initial, now).offers[0], command = request(p, "accept_weekly_order", choice.id);
  for (const patch of [{ quantity: 2 }, { totalPrice: 1 }, { targetId: `${choice.id}_changed` }, { fishSelection: { fish_common: { fish_common: 1 } } }]) {
    assert.throws(() => send(p, { ...command, ...patch }));
    assert.deepEqual(read(p).tradeRelations, initial.tradeRelations);
  }
  assert.throws(() => send(other, { ...command, expectedRevision: read(other).revision }), error => error.code === "ECONOMY_OWNER_CHANGED");
  assert.equal(read(p).tradeRelations.weekly, null);
  assert.equal(read(other).tradeRelations.weekly, null);
});
