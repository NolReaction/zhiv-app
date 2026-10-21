import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-fish-stock-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stock = await vite.ssrLoadModule("/features/economy/domain/fish-stock.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-10-14T23:40:00Z");
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const input = (action, targetId, extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: "AAAA-0000-0001", expectedRevision: 0,
  quantity: 1, totalPrice: 0, action, targetId, ...extra });
const apply = (state, command, at = now) => rules.applyEconomyCommand(state, command, at, () => crypto.randomUUID(), {}, () => 0);
const fisher = () => {
  const state = fresh();
  state.inventory = { fish_epic: 6, fish_common: 9, berries: 8, hardwood: 2, charcoal: 2 };
  state.fishing.stock = { fish_sturgeon: 1, fish_mirror_koi: 4, fish: 2, fish_silverfin: 3, fish_rudd: 3 };
  state.fishing.catches = { fish_sturgeon: 77, fish_shark: 100 };
  Object.assign(state.buildings, { home: 5, dryer: 5, woodlot: 3, kiln: 1, warehouse: 10 });
  return state;
};
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
const player = name => identities.createDevIdentity(name, crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const stored = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const command = (p, action, targetId, extra = {}) => ({ ...input(action, targetId, extra), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision });
const issue = (p, action, targetId, extra = {}) => economy.commandDevEconomy(p.token, command(p, action, targetId, extra), now);
const trade = (p, action, targetId, extra = {}) => economy.commandDevEconomyMarket(p.token, command(p, action, targetId, extra), now);
const marketFixture = p => {
  read(p); Object.assign(stored(p), fisher());
  Object.assign(stored(p).buildings, { home: 4, bridge: 1 });
  stored(p).wallet.coins = 100_000;
  stored(p).unlockedItems = ["fish_epic"];
  stored(p).fishing.ownedRods = model.economyCatalog.fishing.rods.map(rod => rod.id);
};

test("owned species and unidentified remainder are distinct from the lifetime collection", () => {
  const state = fisher();
  assert.deepEqual(stock.fishStockEntries(state, "fish_epic"), [
    { itemId: "fish_sturgeon", classId: "fish_epic", quantity: 1 },
    { itemId: "fish_mirror_koi", classId: "fish_epic", quantity: 4 },
    { itemId: "fish_epic", classId: "fish_epic", quantity: 1 },
  ]);
  assert.deepEqual(stock.fishStockEntries(state, "fish_legendary"), [], "lifetime sharks cannot become ingredients");
  const common = stock.fishStockEntries(state, "fish_common");
  assert.equal(common.find(entry => entry.itemId === "fish").quantity, 2);
  assert.equal(common.find(entry => entry.itemId === "fish_common").quantity, 1);
  assert.equal(new Set(common.map(entry => entry.itemId)).size, common.length);
});

test("old class-only profiles stay unidentified even with large lifetime catch counts", () => {
  const state = fisher(); delete state.fishing.stock;
  stock.normalizeFishStockInventory(state);
  assert.equal(state.fishing.stock, undefined);
  assert.deepEqual(stock.fishStockEntries(state, "fish_epic"), [{ itemId: "fish_epic", classId: "fish_epic", quantity: 6 }]);
  assert.deepEqual(stock.autoFillFishSelection(state, { fish_epic: 2 }), { fish_epic: 2 });
});

test("raw legacy species are captured once before class folding without collection grants", () => {
  const state = fresh(); state.inventory = { fish_common: 2, fish_sturgeon: 2, fish: 1, wood: 2 };
  stock.normalizeFishStockInventory(state);
  assert.deepEqual(state.inventory, { fish_common: 3, fish_epic: 2, wood: 2 });
  assert.deepEqual(state.fishing.stock, { fish: 1, fish_sturgeon: 2 });
  assert.deepEqual(state.fishing.catches, {});
  stock.normalizeFishStockInventory(state);
  assert.deepEqual(state.fishing.stock, { fish: 1, fish_sturgeon: 2 });
});

test("invalid or over-cap ledgers reconcile deterministically to actual class inventory", () => {
  const state = fisher(); state.inventory = { fish_epic: 3, fish_common: 1 };
  state.fishing.stock = { fish_sturgeon: 2, fish_mirror_koi: 9, fish: 0.5, fish_rudd: -1, fish_shark: 9, wood: 9 };
  assert.deepEqual(stock.normalizedFishStock(state), { fish_sturgeon: 2, fish_mirror_koi: 1 });
  stock.reconcileFishStock(state);
  assert.deepEqual(state.fishing.stock, { fish_sturgeon: 2, fish_mirror_koi: 1 });
});

test("automatic selection uses unknown first then abundant species with stable ties", () => {
  const state = fisher();
  assert.deepEqual(stock.autoFillFishSelection(state, { fish_epic: 3, fish_common: 5, wood: 4 }),
    { fish_epic: 1, fish_mirror_koi: 2, fish_common: 1, fish_silverfin: 3, fish_rudd: 1 });
  const selected = stock.autoFillFishSelection(state, { fish_sturgeon: 2, fish_mirror_koi: 1 });
  assert.deepEqual(selected, { fish_epic: 1, fish_mirror_koi: 2 });
  assert.equal(stock.fishSelectionMatches(state, { fish_epic: 3 }, selected), true);
});

test("exact choices reject the wrong class, missing quantities, excess, zeros and fictitious ownership", () => {
  const state = fisher(), required = { fish_epic: 2 };
  for (const selected of [{}, { fish_sturgeon: 1 }, { fish_sturgeon: 2 }, { fish_mirror_koi: 3 },
    { fish_shark: 2 }, { fish_epic: 2 }, { fish_mirror_koi: 2, wood: 1 }, { fish_mirror_koi: 2, fish_sturgeon: 0 }])
    assert.equal(stock.fishSelectionMatches(state, required, selected), false, JSON.stringify(selected));
  assert.equal(stock.fishSelectionMatches(state, required, { fish_sturgeon: 1, fish_mirror_koi: 1 }), true);
  assert.equal(stock.fishSelectionMatches(state, { wood: 1 }, {}), true);
});

test("chosen cooking fish debit exact species while class costs and recipe rewards stay unchanged", () => {
  const state = fisher(), before = structuredClone(state.fishing.catches);
  apply(state, input("start_production", "cook_epic_fish", { fishSelection: { fish_mirror_koi: 1 } }));
  assert.equal(state.inventory.fish_epic, 5);
  assert.deepEqual(state.fishing.stock, { fish: 2, fish_silverfin: 3, fish_rudd: 3, fish_sturgeon: 1, fish_mirror_koi: 3 });
  assert.deepEqual(state.jobs[0].cost, model.economyCatalog.recipes.find(recipe => recipe.id === "cook_epic_fish").cost);
  assert.deepEqual(state.jobs[0].fishStockCost, { fish_mirror_koi: 1 });
  assert.deepEqual(state.jobs[0].rewards, { epic_fish: 1 });
  assert.deepEqual(state.fishing.catches, before);
  apply(state, input("cancel_production", state.jobs[0].id));
  assert.equal(state.inventory.fish_epic, 6);
  assert.equal(state.fishing.stock.fish_mirror_koi, 4);
  assert.equal(state.fishing.stock.fish_sturgeon, 1);
});

test("automatic old-client cooking preserves rare owned species by consuming unknown first", () => {
  const state = fisher();
  apply(state, input("start_production", "cook_epic_fish"));
  assert.equal(state.inventory.fish_epic, 5);
  assert.equal(state.jobs[0].fishStockCost, undefined);
  assert.equal(state.fishing.stock.fish_sturgeon, 1);
  assert.equal(state.fishing.stock.fish_mirror_koi, 4);
});

test("invalid cooking selections leave resources, stock, timers and rewards untouched", () => {
  for (const selected of [{ fish_sturgeon: 2 }, { fish_shark: 1 }, {}, { fish_mirror_koi: 1, fish_common: 1 }]) {
    const state = fisher(), before = structuredClone(state);
    assert.throws(() => apply(state, input("start_production", "cook_epic_fish", { fishSelection: selected })), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
    assert.deepEqual(state, before);
  }
});

test("a changed owned count rejects a stale pick and cannot silently substitute another species", () => {
  const state = fisher(); delete state.fishing.stock.fish_sturgeon;
  const before = structuredClone(state);
  assert.throws(() => apply(state, input("start_production", "cook_epic_fish", { fishSelection: { fish_sturgeon: 1 } })),
    { code: "ECONOMY_FISH_SELECTION_CHANGED" });
  assert.deepEqual(state, before);
});

test("production refund identifies only fish covered by the frozen economic cost", () => {
  const state = fisher();
  apply(state, input("start_production", "cook_epic_fish", { fishSelection: { fish_mirror_koi: 1 } }));
  state.inventory.fish_legendary = 3;
  state.jobs[0].fishStockCost = { fish_mirror_koi: 1, fish_shark: 50, fish_sturgeon: 2 };
  apply(state, input("cancel_production", state.jobs[0].id));
  assert.equal(state.fishing.stock.fish_shark, undefined);
  assert.ok(state.fishing.stock.fish_sturgeon + state.fishing.stock.fish_mirror_koi <= state.inventory.fish_epic);
});

test("finished species catches create owned stock once while class-only deliveries stay unknown", () => {
  const state = fresh(); state.inventory = {};
  const job = { id: crypto.randomUUID(), kind: "exploration", targetId: "shore", recipeId: null, targetLevel: null,
    startedAt: new Date(now - 900000).toISOString(), finishesAt: new Date(now).toISOString(),
    rewards: { fish_sturgeon: 2, fish_common: 1 }, cost: { coins: 0, items: {} }, catalogVersion: 4 };
  state.jobs = [job];
  apply(state, input("claim_job", job.id));
  assert.deepEqual(state.inventory, { fish_epic: 2, fish_common: 1 });
  assert.deepEqual(state.fishing.stock, { fish_sturgeon: 2 });
  assert.deepEqual(state.fishing.catches, { fish_sturgeon: 2 });
  const before = structuredClone(state);
  assert.throws(() => apply(state, input("claim_job", job.id)), { code: "ECONOMY_JOB_GONE" });
  assert.deepEqual(state, before);
});

test("ordinary resident orders consume selected fish with the same payment and next order", () => {
  const state = fisher(); state.residentOrders = food.normalizedResidentOrders(state, now);
  const template = model.economyCatalog.food.orders.templates.find(order => order.id === "plesk_river_catch");
  state.residentOrders.slots[0] = { sequence: 12, readyAt: new Date(now).toISOString(), templateId: template.id,
    terms: { ...template, items: { fish_epic: 2 }, coins: 777 } };
  const offer = food.residentOrderBoard(state, now).offers.find(order => order.slot === 0);
  const beforeCoins = state.wallet.coins;
  apply(state, input("complete_resident_order", offer.id, { fishSelection: { fish_mirror_koi: 2 } }));
  assert.equal(state.inventory.fish_epic, 4); assert.equal(state.fishing.stock.fish_mirror_koi, 2);
  assert.equal(state.fishing.stock.fish_sturgeon, 1); assert.equal(state.wallet.coins, beforeCoins + 777);
});

test("saved tutorial order terms also honor exact fish selection", () => {
  const state = fisher();
  state.tutorialOrder = { version: 1, ingredientsClaimed: true, step: 0, completed: false,
    terms: { id: "tutorial_first_order", name: "Рыбная просьба", residentId: "plesk", items: { fish_epic: 1 }, coins: 90 } };
  apply(state, input("complete_resident_order", "tutorial_first_order", { fishSelection: { fish_mirror_koi: 1 } }));
  assert.equal(state.inventory.fish_epic, 5); assert.equal(state.fishing.stock.fish_mirror_koi, 3);
  assert.equal(state.tutorialOrder.completed, true);
});

test("stage orders use selected species and reject empty choices before advancing progress", () => {
  const state = fisher(); state.buildings.home = 2;
  state.tutorialOrder.completed = true;
  stages.ensureStageOrders(state, model.economyCatalog, now);
  const progress = state.stageOrders.stages["2"];
  progress.terms.items = { fish_epic: 1 }; progress.availableAt = new Date(now).toISOString();
  progress.terms.requiredBuildings = {}; progress.terms.requiredExplorations = {};
  const offer = stages.stageResidentOrder(state), before = structuredClone(state);
  assert.throws(() => apply(state, input("complete_resident_order", offer.id, { fishSelection: {} })), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
  assert.deepEqual(state, before);
  apply(state, input("complete_resident_order", offer.id, { fishSelection: { fish_mirror_koi: 1 } }));
  assert.equal(state.fishing.stock.fish_mirror_koi, 3);
  assert.equal(state.stageOrders.stages["2"].step, before.stageOrders.stages["2"].step + 1);
});

test("selection request receipts distinguish changed choices while reordering the same choice replays", () => {
  const p = player("Cook"); read(p); Object.assign(stored(p), fisher());
  stored(p).progression.recipes.cook_grilled_fish = 1;
  const request = command(p, "start_production", "cook_fish_soup", { fishSelection: { fish_silverfin: 1, fish_rudd: 1 } });
  const accepted = economy.commandDevEconomy(p.token, request, now);
  assert.equal(accepted.state.fishing.stock.fish_silverfin, 2);
  assert.equal(economy.commandDevEconomy(p.token, { ...request, fishSelection: { fish_rudd: 1, fish_silverfin: 1 } }, now).replayed, true);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, fishSelection: { fish_rudd: 2 } }, now),
    { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.deepEqual(read(p).fishing.stock, accepted.state.fishing.stock);
});

test("null selection is old-client automatic behavior and cannot attach choices to unsupported actions", () => {
  const p = player("Legacy"); read(p); Object.assign(stored(p), fisher());
  const request = command(p, "start_production", "cook_grilled_fish", { fishSelection: null });
  const accepted = economy.commandDevEconomy(p.token, request, now);
  assert.equal(accepted.state.fishing.stock.fish_silverfin, 3);
  const absent = { ...request }; delete absent.fishSelection;
  assert.equal(economy.commandDevEconomy(p.token, absent, now).replayed, true);
  assert.throws(() => issue(p, "equip_fishing_rod", "reed_rod", { fishSelection: { fish_sturgeon: 1 } }), { code: "INVALID_ECONOMY_COMMAND" });
});

test("market cancellation restores exact escrowed species without changing the catch book", () => {
  const p = player("Seller"); marketFixture(p);
  const before = structuredClone(read(p)), price = model.economyCatalog.items.find(item => item.id === "fish_epic").baseSellPrice * 2;
  const listing = trade(p, "create_listing", "fish_epic", { quantity: 2, totalPrice: price }).listing;
  assert.deepEqual(stored(p).fishing.escrow[listing.id], { fish_mirror_koi: 1 });
  assert.equal(read(p).fishing.stock.fish_mirror_koi, 3);
  const returned = trade(p, "cancel_listing", listing.id).state;
  assert.equal(returned.fishing.stock.fish_mirror_koi, 4);
  assert.equal(returned.fishing.stock.fish_sturgeon, 1);
  assert.deepEqual(returned.inventory, before.inventory);
  assert.deepEqual(returned.fishing.catches, before.fishing.catches);
  assert.equal(returned.fishing.escrow[listing.id], undefined);
});

test("market sale transfers exact known fish while leaving lifetime collections personal", () => {
  const seller = player("Seller"), buyer = player("Buyer"); marketFixture(seller); marketFixture(buyer);
  stored(buyer).inventory = {}; delete stored(buyer).fishing.stock;
  const beforeCatches = structuredClone(read(buyer).fishing.catches);
  const price = model.economyCatalog.items.find(item => item.id === "fish_epic").baseSellPrice * 2;
  const listing = trade(seller, "create_listing", "fish_epic", { quantity: 2, totalPrice: price }).listing;
  assert.ok(economy.getDevEconomyMarket(buyer.token, {}, now).listings.some(item => item.id === listing.id));
  const bought = trade(buyer, "buy_listing", listing.id, { quantity: 2, totalPrice: price }).state;
  assert.deepEqual(bought.inventory, { fish_epic: 2 });
  assert.deepEqual(bought.fishing.stock, { fish_mirror_koi: 1 });
  assert.deepEqual(bought.fishing.catches, beforeCatches);
  assert.equal(read(seller).fishing.escrow[listing.id], undefined);
  assert.equal(read(seller).fishing.stock.fish_mirror_koi, 3);
});

test("class-only market purchases remain unidentified and a failed sale keeps seller escrow", () => {
  const seller = player("Seller"), buyer = player("Buyer"); marketFixture(seller); marketFixture(buyer);
  delete stored(seller).fishing.stock; delete stored(buyer).fishing.stock; stored(buyer).inventory = {}; stored(buyer).wallet.coins = 0;
  const price = model.economyCatalog.items.find(item => item.id === "fish_epic").baseSellPrice;
  const listing = trade(seller, "create_listing", "fish_epic", { totalPrice: price }).listing;
  economy.getDevEconomyMarket(buyer.token, {}, now);
  const beforeSeller = structuredClone(read(seller));
  assert.throws(() => trade(buyer, "buy_listing", listing.id, { totalPrice: price }), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(read(seller), beforeSeller);
  stored(buyer).wallet.coins = price;
  const bought = trade(buyer, "buy_listing", listing.id, { totalPrice: price }).state;
  assert.equal(bought.fishing.stock, undefined);
  assert.deepEqual(stock.fishStockEntries(bought, "fish_epic"), [{ itemId: "fish_epic", classId: "fish_epic", quantity: 1 }]);
});

test("legacy frozen raw-species refunds identify fish only when explicit metadata is absent", () => {
  for (const metadata of [undefined, {}, { fish_mirror_koi: 1 }]) {
    const state = fresh(); state.inventory = {};
    const job = { id: crypto.randomUUID(), kind: "production", targetId: "dryer", recipeId: "cook_grilled_fish", targetLevel: null,
      startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 180000).toISOString(),
      rewards: { grilled_fish: 1 }, cost: { coins: 0, items: { fish_sturgeon: 1 } }, catalogVersion: 4,
      ...(metadata === undefined ? {} : { fishStockCost: metadata }) };
    state.jobs = [job];
    apply(state, input("cancel_production", job.id));
    assert.deepEqual(state.inventory, { fish_epic: 1 });
    assert.deepEqual(state.fishing.stock ?? {}, metadata ?? { fish_sturgeon: 1 });
    assert.deepEqual(state.fishing.catches, {});
  }
});

test("a blocked production refund preserves the exact spent species metadata and running job", () => {
  const state = fisher(); state.buildings.warehouse = 1;
  apply(state, input("start_production", "cook_epic_fish", { fishSelection: { fish_mirror_koi: 1 } }));
  state.inventory.wood = 50;
  const before = structuredClone(state);
  assert.throws(() => apply(state, input("cancel_production", state.jobs[0].id)), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, before);
});

test("explicit DEV species grants own that fish without opening the personal collection", () => {
  const originalMode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const p = player("QA");
    const known = economy.commandDevEconomyCheat(p.token, command(p, "grant_item", "fish_sturgeon", { quantity: 2 }), now).state;
    assert.deepEqual(known.inventory.fish_epic, 2);
    assert.deepEqual(known.fishing.stock, { fish_sturgeon: 2 });
    assert.deepEqual(known.fishing.catches, {});
    const unknown = economy.commandDevEconomyCheat(p.token, command(p, "grant_item", "fish_epic", { quantity: 3 }), now).state;
    assert.deepEqual(unknown.fishing.stock, { fish_sturgeon: 2 });
    assert.deepEqual(stock.fishStockEntries(unknown, "fish_epic"), [
      { itemId: "fish_sturgeon", classId: "fish_epic", quantity: 2 },
      { itemId: "fish_epic", classId: "fish_epic", quantity: 3 },
    ]);
  } finally {
    if (originalMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  }
});

test("legacy raw-species market lots prove exact ownership unless explicit empty escrow overrides it", () => {
  for (const action of ["cancel_listing", "buy_listing"]) for (const metadata of [undefined, {}]) {
    const seller = player("Legacy seller"), buyer = player("Legacy buyer"); marketFixture(seller); marketFixture(buyer);
    stored(seller).inventory = {}; delete stored(seller).fishing.stock;
    stored(buyer).inventory = {}; delete stored(buyer).fishing.stock;
    const lot = { id: crypto.randomUUID(), sellerPublicId: seller.me.user.publicId, itemId: "fish_sturgeon", quantity: 2,
      totalPrice: model.economyCatalog.items.find(item => item.id === "fish_sturgeon").baseSellPrice * 2,
      currencyScale: 10, feeBps: model.economyCatalog.market.feeBps, status: "active",
      createdAt: new Date(now).toISOString(), closedAt: null };
    // HMR retains pre-class listing rows; there is no new client species listing command.
    globalThis.__zhivDevEconomyStore.listings.set(lot.id, lot);
    if (metadata !== undefined) stored(seller).fishing.escrow = { [lot.id]: metadata };
    const recipient = action === "cancel_listing" ? seller : buyer;
    const beforeCatches = structuredClone(read(recipient).fishing.catches);
    if (action === "buy_listing") assert.ok(economy.getDevEconomyMarket(buyer.token, {}, now).listings.some(item => item.id === lot.id));
    const result = trade(recipient, action, lot.id, action === "buy_listing" ? { quantity: lot.quantity, totalPrice: lot.totalPrice } : {}).state;
    assert.deepEqual(result.inventory, { fish_epic: 2 });
    assert.deepEqual(result.fishing.stock ?? {}, metadata ?? { fish_sturgeon: 2 });
    assert.deepEqual(result.fishing.catches, beforeCatches);
    assert.equal(read(seller).fishing.escrow?.[lot.id], undefined);
  }
});
