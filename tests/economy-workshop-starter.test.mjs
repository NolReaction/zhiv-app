import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const starter = await vite.ssrLoadModule("/features/economy/domain/workshop-starter.ts");
const now = Date.parse("2026-10-08T12:00:00Z");
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const player = () => identities.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, overrides = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action: "claim_workshop_starter", targetId: "workshop", quantity: 1, totalPrice: 0, ...overrides });
const issue = (p, overrides = {}, at = now) => economy.commandDevEconomy(p.token, command(p, overrides), at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });

test("starter quote comes from workshop level one and cannot mutate the catalog", () => {
  const catalog = structuredClone(model.economyCatalog);
  const level = catalog.buildings.find(building => building.id === "workshop").levels.find(level => level.level === 1);
  assert.deepEqual(starter.workshopStarterCost(), { coins: 1200, items: { wood: 10, stone: 8 } });
  level.cost = { coins: 1300, items: { wood: 12, stone: 9 } };
  const quote = starter.workshopStarterCost(catalog);
  assert.deepEqual(quote, level.cost);
  quote.items.wood = 999;
  assert.equal(level.cost.items.wood, 12);
});

test("the confirmed starter adds the full cost to savings without constructing or charging pearls", () => {
  const p = player(), saved = row(p);
  saved.state.wallet = { coins: 350, pearls: 7 };
  saved.state.inventory = { wood: 2, berries: 4 };
  const before = read(p), accepted = issue(p);
  assert.equal(accepted.acceptedRevision, before.revision + 1);
  assert.equal(accepted.state.workshopStarterClaimed, true);
  assert.deepEqual(accepted.state.wallet, { coins: 1550, pearls: 7 });
  assert.deepEqual(accepted.state.inventory, { wood: 12, stone: 8, berries: 4 });
  assert.deepEqual(accepted.state.buildings, before.buildings);
  assert.deepEqual(accepted.state.jobs, before.jobs);
  assert.deepEqual(accepted.state.progression, before.progression);
  assert.equal(accepted.state.storage.used, before.storage.used + 18);
  assert.equal(model.economyResultSchema.safeParse(accepted).success, true);
});

test("receipt retry preserves the original payout while a new request cannot claim twice", () => {
  const p = player(), request = command(p), accepted = economy.commandDevEconomy(p.token, request, now);
  issue(p, { action: "start_production", targetId: "grow_berries" });
  const after = read(p), retried = economy.commandDevEconomy(p.token, request, now);
  assert.equal(retried.replayed, true);
  assert.equal(retried.acceptedRevision, accepted.acceptedRevision);
  assert.deepEqual(retried.state, after);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_CLAIMED" });
  assert.deepEqual(read(p), after);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, targetId: "home" }, now),
    { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("the gift pays for a separate ordinary timed construction and survives its delivery", () => {
  const p = player(); issue(p);
  const building = issue(p, { action: "start_construction" });
  assert.equal(building.state.buildings.workshop, 0);
  assert.equal(building.state.workshopStarterClaimed, true);
  assert.deepEqual(building.state.wallet, { coins: 0, pearls: 0 });
  assert.deepEqual(building.state.inventory, {});
  const job = building.state.jobs.find(job => job.kind === "construction" && job.targetId === "workshop");
  assert.equal(Date.parse(job.finishesAt) - Date.parse(job.startedAt), 1200 * 1000);
  assert.deepEqual(job.cost, starter.workshopStarterCost());
  const complete = economy.commandDevEconomy(p.token, { ...command(p), action: "claim_job", targetId: job.id }, Date.parse(job.finishesAt));
  assert.equal(complete.state.buildings.workshop, 1);
  assert.equal(complete.state.workshopStarterClaimed, true);
});

test("old persisted state and old snapshots default to unclaimed, and accounts keep separate grants", () => {
  const p = player(), other = player(), saved = row(p);
  delete saved.state.workshopStarterClaimed;
  const old = read(p);
  assert.equal(old.workshopStarterClaimed, false);
  delete old.workshopStarterClaimed;
  assert.equal(model.economyViewSchema.parse(old).workshopStarterClaimed, false);
  issue(p);
  assert.equal(read(p).workshopStarterClaimed, true);
  assert.equal(read(other).workshopStarterClaimed, false);
  assert.equal(issue(other).state.workshopStarterClaimed, true);
});

test("a built workshop or its active construction cannot receive the starter", () => {
  for (const built of [true, false]) {
    const p = player(), saved = row(p);
    if (built) saved.state.buildings.workshop = 1;
    else {
      saved.state.wallet.coins = starter.workshopStarterCost().coins;
      saved.state.inventory = starter.workshopStarterCost().items;
      issue(p, { action: "start_construction" });
    }
    const before = read(p);
    assert.equal(starter.canClaimWorkshopStarter(before), false);
    assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
    assert.deepEqual(read(p), before);
  }
});

test("an occupied builder or travelling hero does not block receiving the resources", () => {
  const p = player(), saved = row(p);
  const cost = model.economyCatalog.buildings.find(building => building.id === "woodlot").levels[0].cost;
  saved.state.wallet.coins = cost.coins;
  saved.state.inventory = { ...cost.items };
  issue(p, { action: "start_construction", targetId: "woodlot" });
  issue(p, { action: "start_exploration", targetId: "forest" });
  const before = read(p);
  assert.equal(starter.canClaimWorkshopStarter(before), true);
  const accepted = issue(p);
  assert.equal(accepted.state.workshopStarterClaimed, true);
  assert.deepEqual(accepted.state.jobs, before.jobs);
});

test("a full warehouse rejects atomically and leaves the grant available after goods are sold", () => {
  const p = player(), saved = row(p);
  saved.state.inventory = { berries: 200 };
  const before = read(p), rejected = command(p);
  assert.throws(() => economy.commandDevEconomy(p.token, rejected, now), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p), before);
  assert.equal(saved.receipts.has(rejected.requestId), false);
  issue(p, { action: "sell", targetId: "berries", quantity: 18 });
  const accepted = issue(p);
  assert.equal(accepted.state.workshopStarterClaimed, true);
  assert.equal(accepted.state.storage.used, 200);
});

test("reserved market goods occupy warehouse space and rejection does not mutate direct domain state", () => {
  const state = fresh(); state.inventory = { berries: 182 };
  const before = structuredClone(state);
  assert.throws(() => rules.applyEconomyCommand(state, { ...command(player()), expectedRevision: 0 }, now,
    crypto.randomUUID, { wood: 1 }), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, before);
});

test("wallet and per-item limits reject without spending the permanent marker", () => {
  for (const limit of ["wallet", "item"]) {
    const p = player(), saved = row(p);
    if (limit === "wallet") saved.state.wallet.coins = model.ECONOMY_MAX_BALANCE - 1199;
    else saved.state.inventory = { wood: model.ECONOMY_MAX_ITEMS - 9 };
    const before = read(p);
    assert.throws(() => issue(p), { code: "ECONOMY_CAPACITY" });
    assert.deepEqual(read(p), before);
    assert.equal(saved.state.workshopStarterClaimed, false);
  }
});

test("the grant accepts only its exact workshop target, single quantity and zero supplied price", () => {
  const p = player(), before = read(p);
  for (const overrides of [{ targetId: "home" }, { quantity: 2 }, { totalPrice: 1 }]) {
    assert.throws(() => issue(p, overrides), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before);
  }
});

test("two requests prepared at one revision mint one gift through the standard revision fence", () => {
  const p = player(), first = command(p), second = command(p);
  const accepted = economy.commandDevEconomy(p.token, first, now);
  assert.throws(() => economy.commandDevEconomy(p.token, second, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(read(p), accepted.state);
});
