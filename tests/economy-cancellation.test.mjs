import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-04T20:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Fisher", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, action, targetId, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0 });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, at), at);

test("active and ready fishing trips can be abandoned with no reward or completion credit", () => {
  for (const routeId of ["shore", "shore_camp"]) for (const ready of [false, true]) {
    const p = player(), started = issue(p, "start_exploration", routeId).state, trip = started.jobs[0];
    const at = ready ? Date.parse(trip.finishesAt) + 60_000 : now + 10_000;
    const cancel = command(p, "cancel_exploration", trip.id, at);
    const result = economy.commandDevEconomy(p.token, cancel, at);
    assert.deepEqual(result.state.jobs, []);
    assert.deepEqual(result.state.inventory, started.inventory);
    assert.deepEqual(result.state.wallet, started.wallet);
    assert.equal(result.state.completedExplorations, started.completedExplorations);
    // Reading an eight-hour trip can first persist the six-hour merchant refresh.
    // Cancellation itself advances exactly the revision it accepted once.
    assert.equal(result.state.revision, cancel.expectedRevision + 1);
    assert.equal(result.replayed, false);
    assert.throws(() => issue(p, "claim_job", trip.id, at), { code: "ECONOMY_JOB_GONE" });
    const repeated = economy.commandDevEconomy(p.token, cancel, at + 10_000);
    assert.equal(repeated.replayed, true);
    assert.equal(repeated.acceptedRevision, result.acceptedRevision);
    assert.deepEqual(repeated.state.jobs, []);
    assert.equal(repeated.state.revision, result.state.revision);
    assert.equal(issue(p, "start_exploration", "forest", at).state.jobs.length, 1, "the expedition slot is released");
  }
});

test("abandoning a supplied trip never refunds its consumed provisions or historic paid costs", () => {
  const p = player(); read(p);
  const route = economyCatalog.explorations.find(item => item.id === "deep_cave");
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.buildings.home = route.requiredHomeLevel;
  Object.assign(row.state.buildings, route.requiredBuildings);
  row.state.inventory = { ...route.cost.items, fish: 3 };
  row.state.wallet = { coins: 730, pearls: 20 };
  const started = issue(p, "start_exploration", route.id).state, trip = started.jobs[0];
  assert.notDeepEqual(started.inventory, { ...route.cost.items, fish: 3 });
  // Persisted jobs can originate in an older catalog with a coin cost.
  row.state.jobs[0].cost.coins = 250;
  const result = issue(p, "cancel_exploration", trip.id).state;
  assert.deepEqual(result.inventory, started.inventory);
  assert.deepEqual(result.wallet, started.wallet);
  assert.equal(result.completedExplorations, 0);
});

test("cancellation targets a specific owned exploration and preserves unrelated jobs", () => {
  const p = player(), other = player();
  const production = issue(p, "start_production", "grow_berries").state.jobs[0];
  const exploring = issue(p, "start_exploration", "shore").state;
  const trip = exploring.jobs.find(job => job.kind === "exploration");
  const before = read(p);
  for (const target of [crypto.randomUUID(), "shore"]) {
    assert.throws(() => issue(p, "cancel_exploration", target), { code: "ECONOMY_JOB_GONE" });
    assert.deepEqual(read(p), before);
  }
  assert.throws(() => issue(p, "cancel_exploration", production.id), { code: "ECONOMY_CANCEL_KIND" });
  assert.throws(() => issue(other, "cancel_exploration", trip.id), { code: "ECONOMY_JOB_GONE" });
  assert.throws(() => economy.commandDevEconomy(other.token, command(p, "cancel_exploration", trip.id), now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(read(p), before);
  const result = issue(p, "cancel_exploration", trip.id).state;
  assert.deepEqual(result.jobs, [production]);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.jobs = [{ ...production, kind: "construction", targetId: "home", targetLevel: 2, collection: undefined }];
  const construction = read(p);
  assert.throws(() => issue(p, "cancel_exploration", production.id), { code: "ECONOMY_CANCEL_KIND" });
  assert.deepEqual(read(p), construction);
});

test("claim and cancel from the same revision allow exactly one outcome in either arrival order", () => {
  for (const winner of ["cancel_exploration", "claim_job"]) {
    const p = player(), started = issue(p, "start_exploration", "shore").state, trip = started.jobs[0];
    const savedRewards = structuredClone(globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.jobs[0].rewards);
    const at = Date.parse(trip.finishesAt), loser = winner === "claim_job" ? "cancel_exploration" : "claim_job";
    const accepted = command(p, winner, trip.id, at), stale = command(p, loser, trip.id, at);
    const result = economy.commandDevEconomy(p.token, accepted, at);
    assert.throws(() => economy.commandDevEconomy(p.token, stale, at), { code: "ECONOMY_REVISION_CONFLICT" });
    assert.throws(() => issue(p, loser, trip.id, at), { code: "ECONOMY_JOB_GONE" });
    assert.deepEqual(result.state.inventory, winner === "claim_job" ? savedRewards : started.inventory);
    assert.equal(result.state.completedExplorations, winner === "claim_job" ? 1 : 0);
    assert.deepEqual(read(p, at), result.state);
  }
});

test("replaying cancellation after a new departure cannot cancel the replacement expedition", () => {
  const p = player(), first = issue(p, "start_exploration", "shore").state.jobs[0];
  const cancel = command(p, "cancel_exploration", first.id);
  const cancelled = economy.commandDevEconomy(p.token, cancel, now);
  const next = issue(p, "start_exploration", "shore_camp").state;
  const retry = economy.commandDevEconomy(p.token, cancel, now);
  assert.equal(retry.replayed, true);
  assert.equal(retry.acceptedRevision, cancelled.acceptedRevision);
  assert.deepEqual(retry.state, next);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cancel, targetId: next.jobs[0].id }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cancel, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(read(p), next);
});

test("cancellation is available with full storage and cannot be forged into a refund or bulk command", () => {
  const p = player(), trip = issue(p, "start_exploration", "shore").state.jobs[0];
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.inventory = { wood: 200 };
  const before = read(p), cancel = command(p, "cancel_exploration", trip.id);
  for (const extra of [{ quantity: 2 }, { totalPrice: 1 }, { rewards: { fish: 99 } }, { refund: true }, { targetId: "" }]) {
    assert.throws(() => economy.commandDevEconomy(p.token, { ...cancel, ...extra }, now), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before);
  }
  const result = economy.commandDevEconomy(p.token, cancel, now);
  assert.deepEqual(result.state.inventory, before.inventory);
  assert.deepEqual(result.state.jobs, []);
});
