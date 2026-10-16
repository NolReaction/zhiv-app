import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-10-14T13:00:00Z");
const course = model.economyCatalog.stageOrders.find(stage => stage.homeLevel === 4);
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const row = player => globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
const read = (player, at = now) => economy.getDevEconomy(player.token, at);
function player(home = 4) {
  const result = identities.createDevIdentity("Исследователь дальнего берега", crypto.randomUUID()); read(result);
  Object.assign(row(result).state.buildings, { home, warehouse: 1, workshop: 3, kiln: 3, dryer: 2, woodlot: 2, garden: 2, quarry: 3 });
  row(result).state.wallet = { coins: 0, pearls: 0 }; row(result).state.inventory = {};
  row(result).state.stageOrders = { version: 1, stages: { 3: { step: 8, completed: true, terms: null } } };
  return result;
}
const command = (player, action, targetId) => ({ requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
  expectedRevision: read(player).revision, action, targetId, quantity: 1, totalPrice: 0 });
const send = (player, action, targetId, at = now) => economy.commandDevEconomy(player.token, command(player, action, targetId), at);
function lastDelivery(player) {
  const terms = structuredClone(course.orders.at(-1));
  row(player).state.stageOrders.stages[4] = { step: course.orders.length - 1, completed: false, terms,
    availableAt: new Date(now).toISOString(), intervalSeconds: course.intervalSeconds, completionRewards: { ...course.completionRewards } };
  row(player).state.inventory = { ...terms.items };
  return terms;
}

test("fourth-stage source is a twelve-delivery project with claimed exploration proof and one guaranteed pair of relics", () => {
  assert.equal(model.economyCatalog.version, 11); assert.equal(course.orders.length, 12); assert.equal(course.intervalSeconds, 23 * 3600);
  assert.deepEqual(course.completionRewards, { ancient_core: 1, moon_crystal: 1 });
  assert.deepEqual(course.orders.at(-1).requiredExplorations, { ancient_ruins: 1 });
  assert.deepEqual(course.orders.at(-1).requiredBuildings, { bridge: 1, lighthouse: 1 });
  const catalog = structuredClone(model.economyCatalog);
  catalog.stageOrders.find(stage => stage.homeLevel === 4).orders.at(-1).requiredExplorations = { missing_route: 1 };
  assert.equal(model.economyCatalogSchema.safeParse(catalog).success, false);
  assert.equal(model.economyResidentOrderTermsSchema.parse({ id: "stage4_legacy", residentId: "builder", name: "Прежние условия", items: { wood: 1 }, coins: 10 }).requiredExplorations, undefined);
});

test("restoration and expedition gates reject final delivery before spending materials or changing receipts", () => {
  const account = player(), terms = lastDelivery(account), original = read(account);
  assert.throws(() => send(account, "complete_resident_order", terms.id), { code: "ECONOMY_BUILDING_REQUIRED" });
  assert.deepEqual(read(account), original);
  Object.assign(row(account).state.buildings, { bridge: 1, lighthouse: 1 });
  const restored = read(account);
  assert.throws(() => send(account, "complete_resident_order", terms.id), { code: "ECONOMY_EXPLORATION_REQUIRED" });
  assert.deepEqual(read(account), restored); assert.equal(row(account).receipts.size, 0);
});

test("frozen building and exploration prerequisites survive JSON persistence, preview edits and merges", () => {
  const account = player(), terms = lastDelivery(account);
  row(account).state = JSON.parse(JSON.stringify(row(account).state));
  const view = read(account), offer = stages.stageResidentOrder(view);
  offer.requiredBuildings.lighthouse = 99; offer.requiredExplorations.ancient_ruins = 99;
  assert.deepEqual(stages.stageResidentOrder(view).requiredBuildings, terms.requiredBuildings);
  assert.deepEqual(stages.stageResidentOrder(view).requiredExplorations, terms.requiredExplorations);
  const merged = stages.mergeStageOrders({}, row(account).state.stageOrders);
  merged.stages[4].terms.requiredBuildings.bridge = 99;
  merged.stages[4].terms.requiredExplorations.ancient_ruins = 99;
  assert.deepEqual(row(account).state.stageOrders.stages[4].terms.requiredBuildings, terms.requiredBuildings);
  assert.deepEqual(row(account).state.stageOrders.stages[4].terms.requiredExplorations, terms.requiredExplorations);
});

test("starting, elapsed unclaimed work and cancellation cannot satisfy the personally claimed ruins requirement", () => {
  const account = player(), route = model.economyCatalog.explorations.find(entry => entry.id === "ancient_ruins");
  Object.assign(row(account).state.buildings, route.requiredBuildings);
  row(account).state.wallet.coins = route.cost.coins; row(account).state.inventory = { ...route.cost.items };
  const started = send(account, "start_exploration", route.id), job = started.state.jobs[0], finish = Date.parse(job.finishesAt);
  assert.equal(started.state.progression.routes.ancient_ruins ?? 0, 0);
  assert.equal(read(account, finish).progression.routes.ancient_ruins ?? 0, 0);
  const canceled = send(account, "cancel_exploration", job.id, finish);
  assert.equal(canceled.state.progression.routes.ancient_ruins ?? 0, 0);
  row(account).state.inventory = { ...route.cost.items }; row(account).state.wallet.coins = route.cost.coins;
  const next = send(account, "start_exploration", route.id, finish), nextJob = next.state.jobs[0];
  const claim = command(account, "claim_job", nextJob.id), received = economy.commandDevEconomy(account.token, claim, Date.parse(nextJob.finishesAt));
  assert.equal(received.state.progression.routes.ancient_ruins, 1);
  const replay = economy.commandDevEconomy(account.token, claim, Date.parse(nextJob.finishesAt) + 1);
  assert.equal(replay.replayed, true); assert.equal(replay.state.progression.routes.ancient_ruins, 1);
});

test("the final project grants its relics exactly once and unlocks home five without pearls", () => {
  const account = player(), terms = lastDelivery(account);
  Object.assign(row(account).state.buildings, { bridge: 1, lighthouse: 1 }); row(account).state.progression.routes.ancient_ruins = 1;
  const request = command(account, "complete_resident_order", terms.id), result = economy.commandDevEconomy(account.token, request, now);
  assert.deepEqual(result.state.inventory, course.completionRewards); assert.equal(result.state.wallet.coins, terms.coins);
  assert.equal(stages.stageCourseRequired(result.state, 5), false); assert.equal(result.state.stageOrders.stages[4].completed, true);
  assert.ok(result.state.unlockedItems.includes("moon_crystal")); assert.ok(result.state.unlockedItems.includes("ancient_core"));
  const replay = economy.commandDevEconomy(account.token, request, now + 1);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.inventory, course.completionRewards);
  assert.throws(() => send(account, "complete_resident_order", terms.id), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
});

test("paid legacy construction keeps its saved duration and cost while home five remains beyond the new project", () => {
  const account = player(5);
  assert.equal(stages.stageResidentOrder(read(account)), null); assert.equal(stages.stageCourseRequired(read(account), 5), false);
  const state = row(account).state, cost = { coins: 300000, items: { beams: 45, bricks: 35 } };
  const job = model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "construction", targetId: "lighthouse", recipeId: null,
    targetLevel: 1, startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: {}, cost, catalogVersion: 8 });
  state.jobs.push(job); const before = structuredClone(state.wallet);
  const result = send(account, "claim_job", job.id);
  assert.equal(result.state.buildings.home, 5); assert.equal(result.state.buildings.lighthouse, 1); assert.deepEqual(result.state.wallet, before);
  assert.deepEqual(job.cost, cost);
  const baseline = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  assert.equal(baseline.buildings.bridge, 0); assert.equal(baseline.buildings.lighthouse, 0);
});
