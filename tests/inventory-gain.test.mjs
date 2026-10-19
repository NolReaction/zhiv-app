import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-inventory-gain-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { inventoryGainFromReceipt, INVENTORY_GAIN_HISTORY_LIMIT } = await vite.ssrLoadModule("/features/economy/domain/inventory-gain.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const legacyTraderCatalog = structuredClone(economyCatalog);
legacyTraderCatalog.version = 11;
delete legacyTraderCatalog.leaftailShop.supplyOffers;
delete legacyTraderCatalog.leaftailShop.pearlOffers;
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const job = (kind = "exploration", rewards = { fish: 3, stone: 2 }) => ({ id: crypto.randomUUID(), kind,
  targetId: kind === "production" ? "garden" : "shore", recipeId: null, targetLevel: null,
  startedAt: "2026-10-04T00:00:00.000Z", finishesAt: "2026-10-04T00:01:00.000Z", rewards,
  cost: { coins: 0, items: {} }, catalogVersion: 2 });
const state = (revision = 0, jobs = [], inventory = {}) => ({ ownerPublicId: owner, revision,
  serverTime: "2026-10-04T00:05:00.000Z", wallet: { coins: 100, pearls: 0 }, inventory, jobs,
  buildings: { home: 1, warehouse: 1, garden: 1 }, completedExplorations: 0,
  storage: { capacity: 100, used: 0, reserved: 0, available: 100, overflow: 0 },
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog });
const command = (action, targetId, expectedRevision = 0, quantity = 1) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: owner, expectedRevision, action, targetId, quantity, totalPrice: 0 });
const result = snapshot => ({ state: snapshot, message: "Получено", acceptedRevision: snapshot.revision, replayed: false });
const flush = () => new Promise(resolve => setImmediate(resolve));
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test("legacy v11 travel bait reports only its accepted bundle and permanent purchases do not masquerade as pantry gains", () => {
  const before = { ...state(), catalog: legacyTraderCatalog, leaftailShop: { cycle: 100, purchased: {} } };
  const after = { ...state(1, [], { spice_bait: 5 }), catalog: legacyTraderCatalog, leaftailShop: { cycle: 100, purchased: { spice_bait: 1 } } };
  const event = inventoryGainFromReceipt(before, result(after), command("buy_leaftail_item", "100:spice_bait"));
  assert.deepEqual(event.items, [{ itemId: "spice_bait", quantity: 5 }]);
  for (const item of ["trail_hat", "traveller_rod", "braided_hook"]) {
    assert.equal(inventoryGainFromReceipt(before, result({ ...after, inventory: { [item]: 1 } }),
      command("buy_leaftail_item", `100:${item}`)), null);
  }
});

test("confirmed fishing feedback draws exact saved species while economic items stay rarity classes", () => {
  const trip = { ...job("exploration", { fish_silverfin: 2, fish_rudd: 1, fish_mooncarp: 1, ancient_core: 1 }),
    fishing: { rodId: "willow_rod", hookId: "bare_hook", baitId: null, fishId: "fish_silverfin", catchRevealed: true } };
  const before = { ...state(4, [trip], { fish_common: 10 }), fishing: { catches: {} } };
  const after = { ...state(5, [], { fish_common: 13, fish_rare: 1, ancient_core: 1 }), fishing: { catches: { fish_silverfin: 2, fish_rudd: 1, fish_mooncarp: 1 } } };
  const event = inventoryGainFromReceipt(before, result(after), command("claim_job", trip.id, 4));
  assert.deepEqual(event.items, [{ itemId: "fish_common", quantity: 3 }, { itemId: "fish_rare", quantity: 1 }, { itemId: "ancient_core", quantity: 1 }]);
  assert.deepEqual(event.displayItems, [{ itemId: "fish_silverfin", quantity: 2 }, { itemId: "fish_rudd", quantity: 1 }, { itemId: "fish_mooncarp", quantity: 1 }, { itemId: "ancient_core", quantity: 1 }]);
  assert.ok(Object.isFrozen(event.displayItems) && event.displayItems.every(Object.isFrozen));
  assert.equal(inventoryGainFromReceipt(after, { ...result(after), replayed: true }, command("claim_job", trip.id, 4)), null);
});

test("saved ready catches stay exact when personal discovery counters are already capped", () => {
  const trip = { ...job("exploration", { fish: 2, fish_silverfin: 1 }), fishing: { rodId: "reed_rod", baitId: null, fishId: "fish", catchRevealed: true } };
  const catches = { fish: 1_000_000, fish_silverfin: 1_000_000 };
  const before = { ...state(0, [trip]), fishing: { catches } }, after = { ...state(1, [], { fish_common: 3 }), fishing: { catches } };
  const event = inventoryGainFromReceipt(before, result(after), command("claim_job", trip.id));
  assert.deepEqual(event.items, [{ itemId: "fish_common", quantity: 3 }]);
  assert.deepEqual(event.displayItems, [{ itemId: "fish", quantity: 2 }, { itemId: "fish_silverfin", quantity: 1 }]);
  const onlyRiver = { ...trip, rewards: { fish: 3 } };
  const riverEvent = inventoryGainFromReceipt({ ...before, jobs: [onlyRiver] }, result(after), command("claim_job", trip.id));
  assert.deepEqual(riverEvent.displayItems, [{ itemId: "fish", quantity: 3 }]);
});

test("an older masked snapshot recovers accepted species deltas without inventing river fish", () => {
  const trip = { ...job("exploration", { fish: 4, stone: 1 }), fishing: { rodId: "willow_rod", baitId: null, fishId: "fish" } };
  const before = { ...state(0, [trip]), fishing: { catches: { fish_silverfin: 5 } } };
  const after = { ...state(1, [], { fish_common: 3, fish_rare: 1, stone: 1 }), fishing: { catches: { fish_silverfin: 7, fish_rudd: 1, fish_mooncarp: 1 } } };
  const event = inventoryGainFromReceipt(before, result(after), command("claim_job", trip.id));
  assert.deepEqual(event.items, [{ itemId: "fish_common", quantity: 3 }, { itemId: "stone", quantity: 1 }, { itemId: "fish_rare", quantity: 1 }]);
  assert.deepEqual(event.displayItems, [{ itemId: "fish_silverfin", quantity: 2 }, { itemId: "fish_rudd", quantity: 1 }, { itemId: "fish_mooncarp", quantity: 1 }, { itemId: "stone", quantity: 1 }]);
  assert.ok(event.displayItems.every(item => item.itemId !== "fish"));
});

test("unknown legacy catches keep class fallbacks, and unrelated collection deltas cannot exceed stock gains", () => {
  const trip = { ...job("exploration", { fish: 4 }), fishing: { rodId: "reed_rod", baitId: null, fishId: "fish" } };
  const before = { ...state(0, [trip]), fishing: { catches: { fish: 100 } } };
  const after = { ...state(1, [], { fish_common: 2, fish_rare: 2 }), fishing: { catches: { fish: 100 } } };
  const unknown = inventoryGainFromReceipt(before, result(after), command("claim_job", trip.id));
  assert.equal(unknown.displayItems, undefined);
  assert.deepEqual(unknown.items, [{ itemId: "fish_common", quantity: 2 }, { itemId: "fish_rare", quantity: 2 }]);
  const mixed = { ...after, fishing: { catches: { fish: 100, fish_silverfin: 50, fish_mooncarp: 1, fish_shark: 99 } } };
  const event = inventoryGainFromReceipt(before, result(mixed), command("claim_job", trip.id));
  assert.deepEqual(event.displayItems, [{ itemId: "fish_silverfin", quantity: 2 }, { itemId: "fish_mooncarp", quantity: 1 }, { itemId: "fish_rare", quantity: 1 }]);
  assert.equal(event.displayItems.reduce((sum, item) => sum + item.quantity, 0), 4);
});

test("an actual species result cannot authorize stock or discovery for an absent class", () => {
  const trip = { ...job("exploration", { fish_silverfin: 2 }), fishing: { rodId: "reed_rod", baitId: null, fishId: "fish_silverfin", catchRevealed: true } };
  const before = { ...state(0, [trip]), fishing: { catches: {} } };
  const after = { ...state(1, [], { fish_common: 2, fish_legendary: 30 }), fishing: { catches: { fish_silverfin: 2, fish_shark: 30 } } };
  const event = inventoryGainFromReceipt(before, result(after), command("claim_job", trip.id));
  assert.deepEqual(event.items, [{ itemId: "fish_common", quantity: 2 }]);
  assert.deepEqual(event.displayItems, [{ itemId: "fish_silverfin", quantity: 2 }]);
});

test("a claim event contains only this removed job's confirmed inventory increase, not the full pantry", () => {
  const trip = job(), before = state(4, [trip], { fish: 17, wood: 90, stone: 5 });
  const after = state(5, [], { fish: 20, wood: 95, stone: 7 }), receipt = command("claim_job", trip.id, 4);
  const saved = structuredClone(before), event = inventoryGainFromReceipt(before, result(after), receipt);
  assert.deepEqual(event, { id: receipt.requestId, ownerPublicId: owner, revision: 5, source: "claim",
    items: [{ itemId: "fish_common", quantity: 3 }, { itemId: "stone", quantity: 2 }] });
  assert.equal(event.stationId, undefined, "a trip must not invent a production station");
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.items) && event.items.every(Object.isFrozen));
  assert.deepEqual(before, saved); assert.deepEqual(after.inventory, { fish: 20, wood: 95, stone: 7 });
  const partial = inventoryGainFromReceipt(before, result(state(5, [], { fish: 18, wood: 90, stone: 5 })), receipt);
  assert.deepEqual(partial.items, [{ itemId: "fish_common", quantity: 1 }]);
});

test("loading, old or unrelated revisions, foreign accounts and unclaimed/cancelled jobs cannot celebrate", () => {
  const trip = job(), before = state(4, [trip]), after = state(5, [], { fish: 3, stone: 2 });
  const claim = command("claim_job", trip.id, 4);
  for (const [previous, answer, sent] of [
    [null, result(after), claim], [after, { ...result(after), replayed: true }, claim],
    [before, result({ ...after, ownerPublicId: other }), claim],
    [before, result(after), { ...claim, ownerPublicId: other }],
    [before, result(after), { ...claim, expectedRevision: 3 }],
    [before, { ...result(after), acceptedRevision: 4 }, claim],
    [before, { ...result(state(6, [], after.inventory)), acceptedRevision: 5 }, claim],
    [before, result(state(5, [trip], after.inventory)), claim],
    [state(4), result(after), claim],
    [before, result(after), { ...claim, action: "cancel_exploration" }],
    [before, result(after), { ...claim, action: "start_collection" }],
    [before, result(after), { ...claim, action: "start_exploration" }],
    [state(4, [{ ...trip, kind: "construction" }]), result(after), claim],
  ]) assert.equal(inventoryGainFromReceipt(previous, answer, sent), null);
});

test("harvest celebrates on the accepted claim, while rod ownership and resource spending do not fake stock", () => {
  const harvest = job("production", { berries: 12 }), before = state(0, [harvest], { berries: 2 });
  const after = state(1, [], { berries: 14 });
  const accepted = inventoryGainFromReceipt(before, result(after), command("claim_job", harvest.id));
  assert.deepEqual(accepted.items, [{ itemId: "berries", quantity: 12 }]);
  assert.equal(accepted.stationId, "garden");
  assert.equal(inventoryGainFromReceipt(before, { ...result(after), replayed: true }, command("claim_job", harvest.id)).stationId, "garden");
  const purchase = command("buy_fishing_item", "shop:worm_bait", 0, 4);
  const offered = { ...state(), fishingShop: { offers: [{ id: "shop:worm_bait", itemId: "worm_bait", kind: "bait", remaining: 5 }] } };
  const bait = inventoryGainFromReceipt(offered, result(state(1, [], { worm_bait: 4 })), purchase);
  assert.equal(bait.stationId, undefined, "a purchase must not celebrate a building");
  assert.equal(bait.source, "purchase"); assert.deepEqual(bait.items, [{ itemId: "worm_bait", quantity: 4 }]);
  assert.equal(inventoryGainFromReceipt(state(), result(state(1, [], { fish: 99 })), command("buy_fishing_item", "willow_rod")), null);
  assert.equal(inventoryGainFromReceipt(before, result(state(1, [], { berries: 1 })), command("sell", "berries")), null);
});

test("one atomic berry batch celebrates combined confirmed rewards only after every saved member is removed", () => {
  const batchId = crypto.randomUUID();
  const crops = [{ berries: 1 }, { berries: 1, strawberries: 1 }, { blueberries: 1 }].map(rewards => ({ ...job("production", rewards),
    collection: { kind: "berry_harvest", seconds: 8, batchId, startedAt: "2026-10-04T00:01:00Z", finishesAt: "2026-10-04T00:01:08Z" } }));
  const later = job("production", { cranberries: 1 }), previous = state(4, [...crops, later], { berries: 7, wood: 3 });
  const after = state(5, [later], { berries: 9, strawberries: 1, blueberries: 1, wood: 20 });
  const receipt = command("claim_garden_collection", batchId, 4), saved = structuredClone(previous);
  const event = inventoryGainFromReceipt(previous, result(after), receipt);
  assert.deepEqual(event, { id: receipt.requestId, ownerPublicId: owner, revision: 5, source: "claim", stationId: "garden",
    items: [{ itemId: "berries", quantity: 2 }, { itemId: "strawberries", quantity: 1 }, { itemId: "blueberries", quantity: 1 }] });
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.items) && event.items.every(Object.isFrozen));
  assert.deepEqual(previous, saved, "feedback must not mutate saved jobs or stock");
  for (const remaining of crops) assert.equal(inventoryGainFromReceipt(previous, result({ ...after, jobs: [later, remaining] }), receipt), null);
  assert.equal(inventoryGainFromReceipt(previous, result(after), { ...receipt, targetId: crypto.randomUUID() }), null);
  assert.equal(inventoryGainFromReceipt(previous, result(after), { ...receipt, action: "start_garden_collection" }), null);
  assert.equal(inventoryGainFromReceipt(after, { ...result(after), replayed: true }, receipt), null, "a loaded receipt cannot celebrate again");
});

test("a pending batch shows one gain event; lost reply recovery stays silent after loading the applied receipt", async () => {
  for (const reload of [false, true]) {
    const batchId = crypto.randomUUID(), cache = storage(), sent = [];
    const crops = [{ berries: 1 }, { strawberries: 1 }, { blueberries: 1 }].map(rewards => ({ ...job("production", rewards),
      collection: { kind: "berry_harvest", seconds: 8, batchId, startedAt: "2026-10-04T00:01:00Z", finishesAt: "2026-10-04T00:01:08Z" } }));
    let latest = state(0, crops);
    const transport = { get: async () => latest, send: async receipt => {
      sent.push(structuredClone(receipt)); latest = state(1, [], { berries: 1, strawberries: 1, blueberries: 1 });
      if (sent.length === 1) throw Error("Batch claim committed before response loss");
      return { ...result(latest), replayed: true };
    } };
    const session = createEconomySession(owner, transport, () => assert.fail(), cache), stop = session.activate();
    await session.refresh(); session.act("claim_garden_collection", batchId); await flush();
    assert.deepEqual(session.getSnapshot().inventoryGains, [], "uncertain writes do not issue optimistic gains");
    if (reload) {
      stop(); const restored = createEconomySession(owner, transport, () => assert.fail(), cache), stopRestored = restored.activate();
      await restored.refresh(); assert.equal(restored.retryGardenCollection(), true); await flush();
      assert.deepEqual(restored.getSnapshot().inventoryGains, []); stopRestored();
    } else {
      assert.equal(session.retryGardenCollection(), true); await flush(); await session.retry(); await session.refresh();
      const gains = session.getSnapshot().inventoryGains;
      assert.equal(gains.length, 1); assert.equal(gains[0].stationId, "garden");
      assert.deepEqual(gains[0].items, [{ itemId: "berries", quantity: 1 }, { itemId: "strawberries", quantity: 1 }, { itemId: "blueberries", quantity: 1 }]);
      stop();
    }
    assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  }
});

test("market purchases require the same sold listing and use its item and purchased lot quantity", () => {
  const listingId = crypto.randomUUID(), purchase = command("buy_listing", listingId);
  const answer = { ...result(state(1, [], { wood: 4, stone: 20 })), listing: { id: listingId, itemId: "wood", quantity: 4, status: "sold" } };
  assert.deepEqual(inventoryGainFromReceipt(state(), answer, purchase).items, [{ itemId: "wood", quantity: 4 }]);
  for (const listing of [null, { ...answer.listing, id: crypto.randomUUID() }, { ...answer.listing, status: "cancelled" }]) {
    assert.equal(inventoryGainFromReceipt(state(), { ...answer, listing }, purchase), null);
  }
});

test("pending claims have no optimistic badge; the accepted receipt emits once and polling never adds another", async () => {
  const trip = job(); let latest = state(0, [trip]), resolve;
  const wait = new Promise(done => { resolve = done; });
  const session = createEconomySession(owner, { get: async () => latest, send: async () => wait }, () => assert.fail());
  const stop = session.activate();
  try {
    await session.refresh(); assert.deepEqual(session.getSnapshot().inventoryGains, []);
    session.act("claim_job", trip.id); assert.deepEqual(session.getSnapshot().inventoryGains, []);
    latest = state(1, [], { fish: 3, stone: 2 }); resolve(result(latest)); await flush();
    assert.equal(session.getSnapshot().inventoryGains.length, 1);
    assert.deepEqual(session.getSnapshot().inventoryGains[0].items, [{ itemId: "fish_common", quantity: 3 }, { itemId: "stone", quantity: 2 }]);
    assert.ok(Object.isFrozen(session.getSnapshot().inventoryGains));
    await session.refresh(); await session.retry(); assert.equal(session.getSnapshot().inventoryGains.length, 1);
    latest = state(2, [], { fish: 100 }); await session.refresh(); assert.equal(session.getSnapshot().inventoryGains.length, 1);
  } finally { stop(); }
});

test("a lost reply can confirm its pending gain once, while reloading its already-applied receipt remains silent", async () => {
  for (const reload of [false, true]) {
    const trip = job(), cache = storage(); let latest = state(0, [trip]), sends = 0;
    const sent = [], transport = { get: async () => latest, send: async receipt => {
      sent.push(receipt); latest = state(1, [], { fish: 3, stone: 2 });
      if (++sends === 1) throw Error("Response lost after commit");
      return { ...result(latest), replayed: true };
    } };
    const session = createEconomySession(owner, transport, () => assert.fail(), cache), stop = session.activate();
    await session.refresh(); session.act("claim_job", trip.id); await flush();
    assert.deepEqual(session.getSnapshot().inventoryGains, []);
    if (reload) {
      stop();
      const restored = createEconomySession(owner, transport, () => assert.fail(), cache), stopRestored = restored.activate();
      await restored.refresh(); await restored.retry();
      assert.deepEqual(restored.getSnapshot().inventoryGains, []); stopRestored();
    } else {
      await session.retry(); await session.retry();
      assert.equal(session.getSnapshot().inventoryGains.length, 1); stop();
    }
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
  }
});

test("receipt history is bounded and changing accounts discards a late command response", async () => {
  let latest = state(), currentJob;
  const session = createEconomySession(owner, { get: async () => latest, send: async () => {
    latest = state(latest.revision + 1, [], { fish: (latest.inventory.fish ?? 0) + 1 }); return result(latest);
  } }, () => assert.fail());
  const stop = session.activate();
  for (let index = 0; index < 14; index++) {
    currentJob = job("exploration", { fish: 1 }); latest = { ...latest, jobs: [currentJob] };
    await session.refresh(); session.act("claim_job", currentJob.id); await flush();
  }
  assert.equal(session.getSnapshot().inventoryGains.length, INVENTORY_GAIN_HISTORY_LIMIT); stop();
  const pendingJob = job(); let resolve;
  const wait = new Promise(done => { resolve = done; });
  const old = createEconomySession(owner, { get: async () => state(0, [pendingJob]), send: async () => wait }, () => assert.fail());
  const stopOld = old.activate(); await old.refresh(); old.act("claim_job", pendingJob.id); stopOld();
  const next = createEconomySession(other, { get: async () => ({ ...state(), ownerPublicId: other }) }, () => assert.fail());
  const stopNext = next.activate(); await next.refresh();
  resolve(result(state(1, [], { fish: 3, stone: 2 }))); await flush();
  assert.deepEqual(old.getSnapshot().inventoryGains, []); assert.deepEqual(next.getSnapshot().inventoryGains, []); stopNext();
});
