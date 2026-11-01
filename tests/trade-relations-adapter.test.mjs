import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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


test("an accepted small v15 weekly keeps all old promises and receipt replay after larger offers ship", () => {
  const legacy = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/weekly-contract-legacy-v15.json", import.meta.url), "utf8"));
  const p = player(), owner = read(p).ownerPublicId;
  const row = globalThis.__zhivDevEconomyStore.profiles.get(owner);
  row.state.tradeRelations.weekly = structuredClone(legacy.weekly);
  row.state.tradeRelations.weeklyAvailableAt = legacy.weekly.expiresAt;
  const before = read(p), current = before.catalog.tradeRelations.weekly.templates.find(template => template.id === legacy.weekly.templateId);
  assert.notDeepEqual(current.stages[0].items, legacy.weekly.stages[0].items);
  for (const [index, terms] of legacy.weekly.stages.entries()) {
    const active = weeklyOrderBoard(read(p), now).active;
    assert.equal(active.id, legacy.activeStageIds[index]);
    for (const key of ["items", "coins", "pearls", "reputationXp", "effortSeconds", "manufacturingSeconds", "requiredBuildings"])
      assert.deepEqual(active[key], terms[key], `saved ${key} must not be replaced by the new catalog`);
    fundStage(p, active);
    const command = request(p, "complete_resident_order", active.id), paid = send(p, command), replay = send(p, command);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.state.wallet, paid.state.wallet);
    assert.deepEqual(replay.state.inventory, paid.state.inventory);
    assert.deepEqual(replay.state.tradeRelations, paid.state.tradeRelations);
    assert.equal(economyViewSchema.safeParse(read(p)).success, true);
  }
  const after = read(p);
  assert.equal(after.wallet.coins, before.wallet.coins + legacy.coins);
  assert.equal(after.tradeRelations.reputation.builder ?? 0, (before.tradeRelations.reputation.builder ?? 0) + legacy.reputationXp);
  assert.equal(after.tradeRelations.weekly, null);
  assert.equal(after.tradeRelations.weeklyAvailableAt, legacy.weekly.expiresAt);
  assert.equal(weeklyOrderBoard(after, now).canChoose, false);
});
