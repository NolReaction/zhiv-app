import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { creditEconomyTapBoost, settleEconomyTapBoost, projectEconomyTapBoost } = await vite.ssrLoadModule("/features/economy/domain/tap-boost.ts");
const { tapBoostPowerBps } = await vite.ssrLoadModule("/features/economy/domain/tap-boost-model.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
function job(id = "11111111-1111-4111-8111-111111111111", seconds = 600, extra = {}) {
  return { id, kind: "production", targetId: "woodlot", recipeId: "gather_wood", startedAt: new Date(now).toISOString(),
    finishesAt: new Date(now + seconds * 1000).toISOString(), rewards: { wood: 1 }, cost: { coins: 0, items: {} }, catalogVersion: 15, ...extra };
}
function state(jobs = [job()]) {
  return { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 }), jobs };
}

test("charge grows from one percent to twenty while duration never exceeds one minute", () => {
  assert.deepEqual([1, 100, 500, 1000, 9000].map(tapBoostPowerBps), [100, 900, 1700, 2000, 2000]);
  const s = state(); creditEconomyTapBoost(s, 1, now);
  assert.equal(s.tapBoost.powerBps, 100); assert.equal(Date.parse(s.tapBoost.expiresAt) - now, 1000);
  creditEconomyTapBoost(s, 9999, now);
  assert.equal(s.tapBoost.charge, 1000); assert.equal(s.tapBoost.powerBps, 2000);
  assert.equal(Date.parse(s.tapBoost.expiresAt) - now, 60_000);
  assert.equal(Date.parse(s.jobs[0].finishesAt) - now, 600_000, "granting taps never immediately removes work");
});

test("splitting a simultaneous accepted batch does not multiply charge or time", () => {
  const one = state(), many = state(); creditEconomyTapBoost(one, 1000, now);
  for (let index = 0; index < 1000; index++) creditEconomyTapBoost(many, 1, now);
  assert.deepEqual(many, one);
});

test("ordinary five taps per second can maintain and reach the cap", () => {
  const s = state();
  for (let index = 0; index < 1000; index++) creditEconomyTapBoost(s, 1, now + index * 200);
  assert.equal(s.tapBoost.powerBps, 2000); assert.equal(s.tapBoost.charge, 1000);
  assert.equal(Date.parse(s.tapBoost.expiresAt) - (now + 999 * 200), 60_000);
});

test("offline interval earns only funded work once and never changes another slot", () => {
  const s = state([job(), job("22222222-2222-4222-8222-222222222222", 700)]);
  creditEconomyTapBoost(s, 1000, now);
  const untouched = structuredClone(s.jobs[1]);
  settleEconomyTapBoost(s, now + 3_600_000);
  assert.equal(Date.parse(s.jobs[0].finishesAt) - now, 588_000);
  assert.equal(Date.parse(s.jobs[0].startedAt) - now, -12_000);
  assert.deepEqual(s.jobs[1], untouched);
  const settled = structuredClone(s); settleEconomyTapBoost(s, now + 7_200_000); assert.deepEqual(s, settled);
});

test("completion inside an interval cannot finish before actual accelerated work", () => {
  const s = state([job(undefined, 3)]); creditEconomyTapBoost(s, 1000, now);
  settleEconomyTapBoost(s, now + 10_000);
  assert.equal(Date.parse(s.jobs[0].finishesAt), now + 2500);
  assert.equal(Date.parse(s.jobs[0].startedAt), now - 500);
});

test("authoritative claim settles the boost, rejects early collection and pays once", () => {
  const s = state([job(undefined, 3)]); creditEconomyTapBoost(s, 1000, now);
  const original = structuredClone(s), initialWood = s.inventory.wood ?? 0;
  const command = { action: "claim_job", targetId: s.jobs[0].id, quantity: 1, totalPrice: 0 };
  assert.throws(() => applyEconomyCommand(s, command, now + 2499, crypto.randomUUID), error => error.code === "ECONOMY_JOB_NOT_READY");
  assert.deepEqual(s, original, "a failed early claim must preserve the saved clock and charge");
  applyEconomyCommand(s, command, now + 2500, crypto.randomUUID);
  assert.equal(s.jobs.length, 0); assert.equal(s.inventory.wood, initialWood + 1);
  assert.throws(() => applyEconomyCommand(s, command, now + 2500, crypto.randomUUID), error => error.code === "ECONOMY_JOB_GONE");
});

test("charge expires and neither construction nor ordinary travel receives it", () => {
  const excluded = state([job(undefined, 10, { kind: "construction", targetId: "home" }),
    job("22222222-2222-4222-8222-222222222222", 20, { kind: "exploration", targetId: "forest", actorId: "mochlik" })]);
  assert.equal(creditEconomyTapBoost(excluded, 1000, now), false); assert.equal(excluded.tapBoost, undefined);
  const s = state(); creditEconomyTapBoost(s, 1000, now); creditEconomyTapBoost(s, 1, now + 60_001);
  assert.equal(s.tapBoost.charge, 1); assert.equal(s.tapBoost.powerBps, 100);
});

test("read projection is pure and mining unit progress receives the earned work", () => {
  const s = state([job(undefined, 1800, { kind: "exploration", actorId: "miner", targetId: "quarry_stone", recipeId: undefined,
    miningBatch: { quantity: 10, claimed: 0, unitSeconds: 180 } })]);
  creditEconomyTapBoost(s, 1000, now); const original = structuredClone(s);
  const projected = projectEconomyTapBoost(s, now + 60_000);
  assert.deepEqual(s, original); assert.equal(Date.parse(projected.jobs[0].startedAt), now - 12_000);
  const nextProjection = projectEconomyTapBoost(projected, now + 120_000);
  assert.equal(nextProjection.jobs[0].startedAt, projected.jobs[0].startedAt);
});

test("an authenticated game-batch replay does not replenish boost or change economy revision", async () => {
  const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
  const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
  const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
  identities.resetDevStoreForTests();
  const p = identities.createDevIdentity("Tap boost", crypto.randomUUID());
  const owner = p.me.user.publicId;
  economy.initializeDevEconomy(p.token, now);
  const stored = globalThis.__zhivDevEconomyStore.profiles.get(owner);
  stored.state.jobs = [job()];
  const session = game.createDevGameSession(p.token, owner, crypto.randomUUID(), now);
  assert.equal(session.kind, "ok");
  const batch = { sessionId: session.value.sessionId, sequence: 1, tapCount: 60, runId: crypto.randomUUID() };
  const response = game.submitDevGameBatch(p.token, batch, now);
  assert.equal(response.kind, "ok"); assert.equal(response.value.acceptedTaps, 60);
  const before = structuredClone(stored.state.tapBoost), revision = stored.revision;
  assert.equal(before.charge, 60);
  const replay = game.submitDevGameBatch(p.token, batch, now + 2000);
  assert.equal(replay.value.replayed, true); assert.deepEqual(stored.state.tapBoost, before); assert.equal(stored.revision, revision);
});

test("accepted taps do not invalidate an already prepared production claim cancel or start", async () => {
  const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
  const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
  const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
  identities.resetDevStoreForTests();
  for (const action of ["claim_job", "cancel_production", "start_production"]) {
    const p = identities.createDevIdentity(action, crypto.randomUUID()), owner = p.me.user.publicId;
    economy.initializeDevEconomy(p.token, now);
    const stored = globalThis.__zhivDevEconomyStore.profiles.get(owner);
    stored.state.jobs = [job(undefined, 3)];
    const snapshot = economy.getDevEconomy(p.token, now);
    const command = { requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: snapshot.revision,
      action, targetId: action === "start_production" ? "grow_berries" : stored.state.jobs[0].id, quantity: 1, totalPrice: 0 };
    const session = game.createDevGameSession(p.token, owner, crypto.randomUUID(), now);
    const response = game.submitDevGameBatch(p.token, { sessionId: session.value.sessionId, sequence: 1, tapCount: 60,
      runId: crypto.randomUUID() }, now);
    assert.equal(response.kind, "ok"); assert.equal(stored.state.tapBoost.charge, 60);
    assert.equal(stored.revision, snapshot.revision, "clock updates preserve the prepared command's material revision");
    const result = economy.commandDevEconomy(p.token, command, now + (action === "claim_job" ? 3000 : 1));
    assert.equal(result.acceptedRevision, snapshot.revision + 1, `${action} must succeed on its first click`);
    assert.equal(result.replayed, false);
  }
});

test("equal revision refresh accepts new clock state but ignores an older response", async () => {
  const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
  const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
  const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
  identities.resetDevStoreForTests();
  const p = identities.createDevIdentity("Clock ordering", crypto.randomUUID()), owner = p.me.user.publicId;
  economy.initializeDevEconomy(p.token, now);
  globalThis.__zhivDevEconomyStore.profiles.get(owner).state.jobs = [job()];
  const old = economy.getDevEconomy(p.token, now);
  economy.creditDevEconomyTapBoost(owner, 100, now + 50);
  const fresh = economy.getDevEconomy(p.token, now + 100);
  assert.equal(old.revision, fresh.revision);
  let incoming = old;
  const session = createEconomySession(owner, { get: async () => incoming, market: async () => assert.fail("unexpected market"),
    send: async () => assert.fail("unexpected write"), trade: async () => assert.fail("unexpected trade") }, () => assert.fail("session owner changed"));
  const stop = session.activate();
  try {
    await session.refresh(); incoming = fresh; await session.refresh();
    assert.equal(session.getSnapshot().snapshot.tapBoost.charge, 100);
    incoming = old; await session.refresh();
    assert.equal(session.getSnapshot().snapshot.tapBoost.charge, 100);
    assert.equal(session.getSnapshot().snapshot.serverTime, fresh.serverTime);
  } finally { stop(); }
});
