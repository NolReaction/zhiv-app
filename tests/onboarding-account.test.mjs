import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createOnboardingAccountSync } = await vite.ssrLoadModule("/features/onboarding/account-sync.ts");
const { onboardingDecisionSchema } = await vite.ssrLoadModule("/lib/onboarding-contract.ts");
const { createWorldOnboardingStore } = await vite.ssrLoadModule("/features/world/state/world-onboarding-storage.ts");
const { createAppOnboardingStore } = await vite.ssrLoadModule("/features/app/onboarding/app-onboarding-storage.ts");
const ids = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const dev = await vite.ssrLoadModule("/lib/dev/onboarding-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const rewards = await vite.ssrLoadModule("/lib/dev/progression-rewards-store.ts");
beforeEach(() => ids.resetDevStoreForTests());
const owner = "0000-0000-0001";
const memory = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }; };
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function make(course, initial, request, storage = memory(), options = {}) {
  const local = course === "world" ? createWorldOnboardingStore(owner, storage) : createAppOnboardingStore(owner, storage);
  local.restore(); if (initial) local.save(initial);
  const sync = createOnboardingAccountSync({ owner, course, local, storage, request,
    adopt: status => local.save({ version: 2, status }), ...options });
  return { local, sync, disconnect: sync.connect() };
}
const remote = (course, status) => ({ ownerPublicId: owner, app: null, world: null, [course]: status });

for (const course of ["app", "world"]) {
  test(`${course}: a fresh browser waits for the account and adopts completion without a welcome flash`, async () => {
    const pending = deferred(); const session = make(course, null, () => pending.promise);
    assert.equal(session.sync.getSnapshot(), false);
    assert.equal(session.local.getSnapshot().progress, null);
    pending.resolve(remote(course, "completed")); await tick();
    assert.equal(session.sync.getSnapshot(), true);
    assert.equal(session.local.getSnapshot().progress.status, "completed");
    assert.equal(session.local.getSnapshot().progress.rewardReady, undefined);
    session.disconnect();
  });
  test(`${course}: old local completed or skipped decisions upload before opening on another device`, async () => {
    for (const status of ["completed", "skipped"]) {
      const calls = []; const session = make(course, { version: 2, status }, async (_owner, decision) => { calls.push(decision); return remote(course, status); });
      await tick(); assert.equal(calls[0].status, status); assert.equal(calls[0].course, course);
      session.disconnect();
    }
  });
  test(`${course}: remote completion suppresses an obsolete in-progress lesson`, async () => {
    const started = course === "world" ? { version: 2, status: "started", stepId: "profile" }
      : { version: 2, status: "started", stepId: "people", completedSteps: [], baselineCheckInAt: null };
    const session = make(course, started, async () => remote(course, "completed")); await tick();
    assert.equal(session.local.getSnapshot().progress.status, "completed"); session.disconnect();
  });
}
test("completion during an initial read is subsequently uploaded and reward intent survives", async () => {
  const first = deferred(); const calls = [];
  const session = make("world", null, async (_owner, decision) => { calls.push(decision); return calls.length === 1 ? first.promise : remote("world", "completed"); });
  const completed = { version: 2, status: "completed", rewardReady: true, completedSteps: ["profile", "pantry", "garden", "grow", "neighbors", "orders", "workshop", "expeditions", "help"] };
  session.local.save(completed); first.resolve(remote("world", null)); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].status, "completed");
  assert.equal(session.local.getSnapshot().progress.rewardReady, true); session.disconnect();
});
test("explicit replay survives reload and a delayed acknowledgement of the previous completion", async () => {
  const storage = memory(), pending = deferred();
  const first = make("world", { version: 2, status: "completed" }, () => pending.promise, storage);
  first.sync.replay(); first.local.save({ version: 2, status: "started", stepId: "profile" });
  pending.resolve(remote("world", "completed")); await tick();
  assert.equal(first.local.getSnapshot().progress.status, "started"); first.disconnect();
  const second = make("world", null, async () => remote("world", "completed"), storage); await tick();
  assert.equal(second.local.getSnapshot().progress.status, "started"); second.disconnect();
});
test("failed account read does not launch a duplicate course; offline manual replay still works", async () => {
  let now = 0, calls = 0;
  const session = make("world", null, async () => { calls++; throw { retryAfterMs: 60_000 }; }, memory(), { now: () => now });
  await tick(); assert.equal(session.sync.getSnapshot(), false);
  await session.sync.refresh(); assert.equal(calls, 1);
  session.sync.replay(); session.local.save({ version: 2, status: "started", stepId: "profile" });
  assert.equal(session.sync.getSnapshot(), true);
  now = 60_000; await session.sync.refresh(); assert.equal(calls, 2); session.disconnect();
});
test("unmounted owner ignores a late response and another owner's response never becomes guide state", async () => {
  const pending = deferred(); const first = make("world", null, () => pending.promise); first.disconnect();
  pending.resolve(remote("world", "completed")); await tick(); assert.equal(first.local.getSnapshot().progress, null);
  const second = make("world", null, async () => ({ ...remote("world", "completed"), ownerPublicId: "0000-0000-0002" }));
  await tick(); assert.equal(second.sync.getSnapshot(), false); assert.equal(second.local.getSnapshot().progress, null); second.disconnect();
});
test("DEV decisions are account scoped, completion wins a late skip and no currency is issued", () => {
  const a = ids.createDevIdentity("Первый", crypto.randomUUID()); const b = ids.createDevIdentity("Второй", crypto.randomUUID());
  const wallet = economy.getDevEconomy(a.token).wallet;
  const decision = { ownerPublicId: a.me.user.publicId, course: "world", status: "completed" };
  assert.equal(dev.saveDevOnboarding(a.token, decision).world, "completed");
  assert.equal(dev.saveDevOnboarding(a.token, { ...decision, status: "skipped" }).world, "completed");
  assert.deepEqual(economy.getDevEconomy(a.token).wallet, wallet);
  assert.equal(rewards.getDevProgressionRewards(a.token).onboarding.claimedAt, null);
  assert.equal(dev.getDevOnboarding(b.token, b.me.user.publicId).world, null);
  assert.throws(() => dev.saveDevOnboarding(b.token, decision), error => error.code === "ONBOARDING_OWNER_CHANGED");
  assert.throws(() => dev.getDevOnboarding(undefined, decision.ownerPublicId), error => error.code === "UNAUTHORIZED");
});
test("contract accepts only terminal tutorial preferences, never reward or gameplay data", () => {
  const good = { ownerPublicId: owner, course: "world", status: "completed" };
  assert.equal(onboardingDecisionSchema.safeParse(good).success, true);
  for (const bad of [{ ...good, status: "started" }, { ...good, course: "all" }, { ...good, rewardReady: true }, { ...good, ownerPublicId: "wrong" }])
    assert.equal(onboardingDecisionSchema.safeParse(bad).success, false);
});
