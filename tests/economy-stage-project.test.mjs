import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const now = Date.parse("2026-10-14T09:00:00Z"), interval = 23 * 3600000;
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function player(version = 2) {
  const p = identities.createDevIdentity("Недельный проект", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home: 3, warehouse: 1, garden: 3, woodlot: 3, workshop: 3, quarry: 3, kiln: 3, dryer: 3 });
  row(p).state.tutorialOrder = { version, step: version === 2 ? 4 : 0, completed: true, ingredientsClaimed: true, terms: null };
  row(p).state.stageOrders = { version: 1, stages: { 2: { step: 5, completed: true, terms: null } } };
  row(p).state.wallet = { coins: 230, pearls: 0 }; row(p).state.inventory = {};
  return p;
}
const course = () => model.economyCatalog.stageOrders.find(stage => stage.homeLevel === 3);
const quote = (p, at = now) => stages.stageResidentOrder(read(p, at));
const request = (p, action = "complete_resident_order", targetId = quote(p)?.id, at = now, extra = {}) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision,
  action, targetId, quantity: 1, totalPrice: 0, ...extra,
});
const send = (p, action = "complete_resident_order", targetId, at = now, extra = {}) =>
  economy.commandDevEconomy(p.token, request(p, action, targetId ?? quote(p, at)?.id, at, extra), at);

test("the project quote opens immediately without persisting, and rejected attempts cannot freeze conditions or grant ingredients", () => {
  const p = player(), stored = structuredClone(row(p).state), first = quote(p);
  assert.equal(course().orders.length, 8); assert.equal(course().intervalSeconds, 82800);
  assert.deepEqual(course().completionRewards, { living_resin: 1 });
  assert.equal(first.id, course().orders[0].id); assert(Date.parse(first.availableAt) <= now);
  assert.equal(first.intervalSeconds, 82800); assert.deepEqual(first.completionRewards, {});
  assert.deepEqual(row(p).state, stored);
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" });
  assert.throws(() => send(p, "replace_resident_order", first.id), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  assert.deepEqual(row(p).state, stored);
  send(p, "start_production", "grow_berries");
  const progress = row(p).state.stageOrders.stages[3];
  assert.equal(progress.intervalSeconds, 82800); assert.deepEqual(progress.completionRewards, { living_resin: 1 });
  assert.equal(progress.terms.id, first.id); assert.deepEqual(read(p).inventory, {});
});

test("eight newly pinned deliveries require seven real 23-hour fences and award one guaranteed resin exactly once", () => {
  const p = player(), receipts = []; let paid = 0;
  for (let step = 0; step < 8; step++) {
    const at = now + step * interval, offer = quote(p, at);
    assert.equal(offer.id, course().orders[step].id); row(p).state.inventory = { ...offer.items };
    if (step > 0) {
      const before = read(p, at - 1), captured = request(p, "complete_resident_order", offer.id, at - 1);
      assert.throws(() => economy.commandDevEconomy(p.token, captured, at - 1), { code: "ECONOMY_STAGE_WAIT" });
      assert.deepEqual(read(p, at - 1), before);
      assert.equal(Date.parse(offer.availableAt), at);
    }
    assert.deepEqual(offer.completionRewards, step === 7 ? { living_resin: 1 } : {});
    const cmd = request(p, "complete_resident_order", offer.id, at), result = economy.commandDevEconomy(p.token, cmd, at);
    receipts.push([cmd, result.acceptedRevision]); paid += offer.coins;
    assert.equal(result.state.stageOrders.stages[3].step, step + 1);
    assert.equal(result.state.stageOrders.stages[3].completed, step === 7);
    assert.equal(result.state.wallet.coins, 230 + paid); assert.equal(result.state.wallet.pearls, 0);
    assert.deepEqual(result.state.inventory, step === 7 ? { living_resin: 1 } : {});
    if (step < 7) {
      const next = stages.stageResidentOrder(result.state);
      assert.equal(next.id, course().orders[step + 1].id);
      assert.equal(Date.parse(next.availableAt), at + interval);
      assert.deepEqual(next.items, course().orders[step + 1].items, "the next material list is visible during its wait");
    }
    assert.throws(() => send(p, "complete_resident_order", offer.id, at), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  }
  const latest = read(p, now + 7 * interval); assert.equal(quote(p, now + 7 * interval), null);
  for (const [cmd, acceptedRevision] of receipts) {
    const result = economy.commandDevEconomy(p.token, cmd, now + 30 * interval);
    assert.equal(result.replayed, true); assert.equal(result.acceptedRevision, acceptedRevision);
    assert.deepEqual(result.state.inventory, latest.inventory); assert.deepEqual(result.state.wallet, latest.wallet);
    assert.equal(result.state.stageOrders.stages[3].step, 8);
  }
});

test("the next deadline is measured from actual delivery and frozen conditions survive JSON and catalog edits", () => {
  const p = player(); send(p, "start_production", "grow_berries");
  const first = quote(p), later = now + 3 * interval + 12345;
  row(p).state.inventory = { ...first.items };
  const result = send(p, "complete_resident_order", first.id, later);
  assert.equal(Date.parse(result.state.stageOrders.stages[3].availableAt), later + interval);
  row(p).state = JSON.parse(JSON.stringify(row(p).state));
  const view = read(p, later), current = view.catalog.stageOrders.find(stage => stage.homeLevel === 3);
  current.intervalSeconds = 0; current.completionRewards = { ancient_core: 50 };
  current.orders[1].coins = 999999; current.orders[1].items = { wood: 42 };
  const frozen = stages.stageResidentOrder(view);
  assert.equal(frozen.intervalSeconds, 82800); assert.equal(Date.parse(frozen.availableAt), later + interval);
  assert.deepEqual(frozen.items, course().orders[1].items); assert.equal(frozen.coins, course().orders[1].coins);
  assert.deepEqual(view.stageOrders.stages[3].completionRewards, { living_resin: 1 });
});

test("previously saved twenty four hour projects keep their exact cadence across the new twenty three hour catalog", () => {
  const p = player(), first = structuredClone(course().orders[0]), oldInterval = 24 * 3600000;
  row(p).state.stageOrders.stages[3] = { step: 0, completed: false, terms: first,
    availableAt: new Date(now).toISOString(), intervalSeconds: 86400, completionRewards: { living_resin: 1 } };
  row(p).state = JSON.parse(JSON.stringify(row(p).state));
  assert.equal(quote(p).intervalSeconds, 86400);
  row(p).state.inventory = { ...first.items };
  const delivered = send(p).state;
  assert.equal(delivered.stageOrders.stages[3].intervalSeconds, 86400);
  assert.equal(Date.parse(delivered.stageOrders.stages[3].availableAt), now + oldInterval);
  const second = quote(p, now + interval); row(p).state.inventory = { ...second.items };
  const before = read(p, now + interval);
  assert.throws(() => send(p, "complete_resident_order", second.id, now + interval), { code: "ECONOMY_STAGE_WAIT" });
  assert.deepEqual(read(p, now + interval), before);
  const completed = send(p, "complete_resident_order", second.id, now + oldInterval).state;
  assert.equal(completed.stageOrders.stages[3].step, 2);
  assert.equal(Date.parse(completed.stageOrders.stages[3].availableAt), now + 2 * oldInterval);
  assert.deepEqual(completed.stageOrders.stages[3].completionRewards, { living_resin: 1 });
});

test("home four requires this project for every tutorial generation but an already paid home-four job still claims", () => {
  const home = model.economyCatalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 4);
  for (const version of [1, 2]) {
    const p = player(version); row(p).state.wallet.coins = home.cost.coins; row(p).state.inventory = { ...home.cost.items };
    const before = read(p); assert.throws(() => send(p, "start_construction", "home"), { code: "ECONOMY_STAGE_REQUIRED" });
    assert.deepEqual(read(p), before); assert.equal(stages.stageCourseRequired(before, 4), true);
  }
  const p = player(1), id = crypto.randomUUID();
  row(p).state.jobs.push({ id, kind: "construction", targetId: "home", recipeId: null, targetLevel: 4,
    startedAt: new Date(now - 24 * 3600000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: {},
    cost: { coins: 180000, items: { beams: 45, bricks: 35 } }, catalogVersion: 7 });
  const before = read(p), claimed = send(p, "claim_job", id).state;
  assert.equal(claimed.buildings.home, 4); assert.deepEqual(claimed.wallet, before.wallet); assert.deepEqual(claimed.inventory, before.inventory);
  assert.equal(stages.stageResidentOrder(claimed)?.id?.startsWith("stage3_") ?? false, false);
});

test("final delivery is atomic at wallet and item limits and concurrent revisions cannot award two relics", () => {
  const p = player(), last = course().orders.at(-1);
  row(p).state.stageOrders.stages[3] = { step: 7, completed: false, terms: { ...last, items: { ...last.items } },
    availableAt: new Date(now).toISOString(), intervalSeconds: 86400, completionRewards: { living_resin: 1 } };
  row(p).state.inventory = { ...last.items }; row(p).state.wallet.coins = model.ECONOMY_MAX_BALANCE - last.coins + 1;
  let before = read(p); assert.throws(() => send(p), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), before);
  row(p).state.wallet.coins = 230; row(p).state.inventory.living_resin = model.ECONOMY_MAX_ITEMS;
  before = read(p); assert.throws(() => send(p), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), before);
  delete row(p).state.inventory.living_resin;
  const first = request(p), racing = request(p), result = economy.commandDevEconomy(p.token, first, now);
  assert.throws(() => economy.commandDevEconomy(p.token, racing, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(result.state.inventory, { living_resin: 1 }); assert.equal(result.state.stageOrders.stages[3].completed, true);
  assert.equal(economy.commandDevEconomy(p.token, first, now + interval).replayed, true);
  assert.deepEqual(read(p).inventory, { living_resin: 1 });
});

test("course merges preserve the furthest frozen terms and the later same-step wait, without reopening completion", () => {
  const orders = course().orders, oldInterval = 24 * 3600000;
  const first = { version: 1, stages: { 3: { step: 3, completed: false, terms: { ...orders[3], coins: 123 },
    availableAt: new Date(now + oldInterval).toISOString(), intervalSeconds: 86400, completionRewards: { living_resin: 1 } } } };
  const second = { version: 1, stages: { 3: { ...first.stages[3], availableAt: new Date(now + 2 * oldInterval).toISOString() } } };
  const before = [structuredClone(first), structuredClone(second)];
  for (const pair of [[first, second], [second, first]]) {
    const merged = stages.mergeStageOrders(...pair);
    assert.equal(merged.stages[3].terms.coins, 123); assert.equal(Date.parse(merged.stages[3].availableAt), now + 2 * oldInterval);
    assert.deepEqual(merged.stages[3].completionRewards, { living_resin: 1 });
  }
  const done = { version: 1, stages: { 3: { ...second.stages[3], step: 8, completed: true, terms: null } } };
  for (const pair of [[done, first], [first, done]]) {
    const merged = stages.mergeStageOrders(...pair); assert.equal(merged.stages[3].step, 8); assert.equal(merged.stages[3].completed, true);
    assert.equal(stages.stageResidentOrder({ ...read(player()), stageOrders: merged }), null);
  }
  assert.deepEqual([first, second], before);
});
