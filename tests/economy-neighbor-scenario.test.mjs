import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createNeighborScenario } from "../scripts/lib/economy-neighbor-scenario.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, logLevel: "silent",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const modules = {};
for (const [key, path] of Object.entries({ identities: "lib/dev/api-store.ts", economyStore: "lib/dev/economy-store.ts",
  neighborStore: "lib/dev/neighbor-store.ts", neighborRules: "features/economy/domain/neighbor-rules.ts",
  market: "features/economy/domain/market-rules.ts", rules: "features/economy/domain/rules.ts" }))
  modules[key] = await vite.ssrLoadModule(`/${path}`);
after(() => vite.close());
const now = Date.parse("2026-10-14T09:00:00Z"), HOUR = 3_600_000, ownerPublicId = "0000-0000-0001";
// A unit-test fixture only. The progression runner passes the state earned by
// preceding commands; the adapter itself cannot grant resources or upgrades.
function marketFixture() {
  const state = modules.rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  Object.assign(state.buildings, { home: 2, bridge: 1 });
  state.completedExplorations = 1;
  state.inventory = { wood: 12 };
  return state;
}
function withScenario(run, state = marketFixture()) {
  const before = structuredClone(state);
  const scenario = createNeighborScenario({ ...modules, state, now, ownerPublicId });
  try { assert.deepEqual(state, before); return run(scenario, state); }
  finally { scenario.close(); }
}

test("funded listings retain escrow, wait three minutes, then settle and require a real proceeds claim", () => {
  withScenario((scenario, state) => {
    const coins = state.wallet.coins, pearls = state.wallet.pearls;
    assert.equal(scenario.quote("wood", 1), 60);
    const listed = scenario.command("create_listing", "wood", 1, 60, now).listing;
    assert.equal(state.inventory.wood, 11);
    assert.deepEqual(scenario.escrowItems(), { wood: 1 });
    const storage = modules.rules.economyStorage(state, scenario.escrowItems());
    assert.equal(storage.used + storage.reserved, 12);
    assert.equal(scenario.nextDue(now), now + 180_000);
    assert.deepEqual(scenario.tick(now + 179_999), { sales: [], automaticTransactions: 0 });
    const sold = scenario.tick(now + 180_000);
    assert.equal(sold.automaticTransactions, 1);
    assert.deepEqual(sold.sales, [{ itemId: "wood", quantity: 1, totalPrice: 60, proceedsCoins: 57, feeCoins: 3,
      createdAt: new Date(now).toISOString(), closedAt: new Date(now + 180_000).toISOString() }]);
    assert.deepEqual(scenario.escrowItems(), {});
    assert.equal(state.wallet.coins, coins, "A sale reserves proceeds until the seller claims them");
    assert.equal(state.wallet.pearls, pearls, "A world-character sale never grants a player-market pearl award");
    assert.equal(scenario.confirmedSales(), 0, "Production excludes NPC transactions from first-sale achievements");
    const uid = globalThis.__zhivDevStore.publicIds.get(ownerPublicId);
    assert.equal(globalThis.__zhivDevStore.achievementTierAwards.get(uid)?.get("first_sale")?.size ?? 0, 0);
    assert.equal(scenario.tick(now + 180_001).automaticTransactions, 0);
    scenario.command("claim_sale", listed.id, 1, 0, now + 182_000);
    assert.equal(state.wallet.coins, coins + 57);
    assert.throws(() => scenario.command("claim_sale", listed.id, 1, 0, now + 184_000), { code: "ECONOMY_MARKET_NOT_PENDING" });
    assert.equal(state.wallet.coins, coins + 57);
  });
});

test("later sales wait six hours and a third lot waits for the next UTC daily allowance", () => {
  withScenario((scenario) => {
    scenario.command("create_listing", "wood", 1, 60, now);
    scenario.tick(now + 180_000);
    const secondAt = now + 240_000;
    scenario.command("create_listing", "wood", 1, 60, secondAt);
    scenario.command("create_listing", "wood", 1, 60, secondAt + 2000);
    assert.equal(scenario.nextDue(secondAt + 2000), secondAt + 6 * HOUR);
    assert.equal(scenario.tick(secondAt + 6 * HOUR - 1).automaticTransactions, 0);
    assert.equal(scenario.tick(secondAt + 6 * HOUR).automaticTransactions, 1);
    assert.equal(scenario.tick(secondAt + 6 * HOUR + 2000).automaticTransactions, 0);
    assert.equal(scenario.usage(secondAt + 6 * HOUR).usedLots, 2);
    const midnight = Date.parse("2026-10-15T00:00:00Z");
    assert.equal(scenario.nextDue(secondAt + 6 * HOUR + 2000), midnight);
    assert.equal(scenario.tick(midnight - 1).automaticTransactions, 0);
    assert.equal(scenario.tick(midnight).automaticTransactions, 1);
    assert.equal(scenario.usage(midnight).usedLots, 1);
    assert.equal(scenario.usage(midnight).spentCoins, 60);
    assert.equal(scenario.nextDue(midnight), null);
  });
});

test("the adapter cannot create an unfunded lot and cancellation restores reserved stock without money", () => {
  withScenario((scenario, state) => {
    const before = structuredClone(state.wallet);
    assert.throws(() => scenario.command("create_listing", "wood", 13, 780, now), { code: "ECONOMY_RESOURCES" });
    assert.deepEqual(scenario.listings(), []); assert.equal(state.inventory.wood, 12);
    const listing = scenario.command("create_listing", "wood", 2, 120, now).listing;
    assert.equal(state.inventory.wood, 10);
    scenario.command("cancel_listing", listing.id, 1, 0, now + 2000);
    assert.equal(state.inventory.wood, 12); assert.deepEqual(scenario.escrowItems(), {});
    assert.deepEqual(state.wallet, before);
    assert.equal(scenario.tick(now + 24 * HOUR).automaticTransactions, 0);
  });
});

test("market transactions preserve private production state and close restores the prior DEV context", () => {
  const state = marketFixture();
  modules.rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId, expectedRevision: 0,
    action: "start_exploration", targetId: "forest", quantity: 1, totalPrice: 0 }, now, () => crypto.randomUUID(), {}, () => 0);
  const job = structuredClone(state.jobs[0]);
  const original = globalThis.__zhivDevStore;
  const scenario = createNeighborScenario({ ...modules, state, now, ownerPublicId });
  try {
    const listing = scenario.command("create_listing", "wood", 1, 60, now).listing;
    scenario.tick(now + 180_000); scenario.command("claim_sale", listing.id, 1, 0, now + 182_000);
    assert.deepEqual(state.jobs[0], job, "Do not replace private stored jobs with public response projections");
    assert.strictEqual(globalThis.__zhivDevEconomyStore.profiles.get(ownerPublicId).state, state);
  } finally { scenario.close(); }
  assert.strictEqual(globalThis.__zhivDevStore, original);
  assert.throws(() => scenario.tick(now), /closed/);
});

test("renewable budgets and configured active hours affect the next actual purchase time", () => {
  withScenario((scenario) => {
    modules.neighborStore.configureDevNeighbor({ ...scenario.settings, dailyBudgetCoins: 100, maxLotsPerDay: 5,
      activeFromHourUtc: 10, activeUntilHourUtc: 20 });
    scenario.command("create_listing", "wood", 1, 60, now);
    assert.equal(scenario.nextDue(now), now + HOUR);
    assert.equal(scenario.tick(now + 180_000).automaticTransactions, 0);
    assert.equal(scenario.tick(now + HOUR).automaticTransactions, 1);
    scenario.command("create_listing", "wood", 1, 60, now + HOUR + 2000);
    const due = Date.parse("2026-10-15T10:00:00Z");
    assert.equal(scenario.nextDue(now + 8 * HOUR), due);
    assert.equal(scenario.tick(now + 8 * HOUR).automaticTransactions, 0);
    assert.equal(scenario.tick(due).automaticTransactions, 1);
    assert.equal(scenario.usage(due).spentCoins, 60);
  });
});
