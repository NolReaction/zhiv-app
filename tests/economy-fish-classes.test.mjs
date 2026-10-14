import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, cacheDir: '/tmp/zhiv-fish-classes-vite', resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog, economyCatalogSchema, ECONOMY_MAX_ITEMS } = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const fish = await vite.ssrLoadModule('/features/economy/domain/fishing.ts');
const rules = await vite.ssrLoadModule('/features/economy/domain/rules.ts');
const food = await vite.ssrLoadModule('/features/economy/domain/food.ts');
const market = await vite.ssrLoadModule('/features/economy/domain/market-rules.ts');
const { publicEconomyJob } = await vite.ssrLoadModule('/features/economy/domain/public-jobs.ts');
const { inventoryGainFromReceipt } = await vite.ssrLoadModule('/features/economy/domain/inventory-gain.ts');
const now = Date.parse('2026-10-13T16:00:00Z');
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const command = (action, targetId, quantity = 1) => ({ action, targetId, quantity, totalPrice: 0, expectedRevision: 0, ownerPublicId: 'AAAA-0000-0001', requestId: crypto.randomUUID() });
const apply = (state, input) => rules.applyEconomyCommand(state, input, now, () => crypto.randomUUID(), {}, () => 0);

test('all stock maps idempotently to exactly five classes without creating collection history', () => {
  const state = fresh(); state.inventory = { wood: 9, fish_common: 2, fish: 1, fish_silverfin: 2, fish_rudd: 3, fish_mooncarp: 2 };
  const inventory = fish.fishClassInventory(state.inventory);
  assert.deepEqual(inventory, { wood: 9, fish_common: 8, fish_rare: 2 });
  assert.deepEqual(fish.fishClassInventory(inventory), inventory);
  rules.creditEconomyItems(state, { fish_rudd: 2, fish_shark: 1 });
  assert.deepEqual(state.inventory, { wood: 9, fish_common: 10, fish_rare: 2, fish_legendary: 1 });
  assert.deepEqual(state.fishing.catches, {});
  assert.throws(() => fish.fishClassInventory({ fish_common: ECONOMY_MAX_ITEMS, fish: 1 }), RangeError);
  assert.throws(() => fish.fishClassInventory({ fish_common: 5, fish: -1 }), RangeError);
  assert.throws(() => fish.fishClassInventory({ fish: 0.5 }), RangeError);
  assert.deepEqual(fish.fishClassInventory({ ancient_core: 0, fish_common: 0 }), { ancient_core: 0, fish_common: 0 });
});

test('class orders consume mixed species while preserving their saved payment and neighbours', () => {
  const state = fresh(); state.residentOrders = food.normalizedResidentOrders(state, now);
  const template = catalog.food.orders.templates.find(item => item.id === 'plesk_river_catch');
  state.residentOrders.slots[0] = { sequence: 9, readyAt: new Date(now).toISOString(), templateId: template.id,
    terms: { ...template, items: { fish: 1, fish_silverfin: 2 }, coins: 777 } };
  const board = food.residentOrderBoard(state, now), offer = board.offers.find(item => item.slot === 0);
  assert.deepEqual(offer.items, { fish_common: 3 }); assert.equal(offer.coins, 777);
  state.inventory = { fish: 1, fish_rudd: 2, fish_legendary: 1 };
  const beforeCoins = state.wallet.coins;
  apply(state, command('complete_resident_order', offer.id));
  assert.equal(state.wallet.coins, beforeCoins + 777);
  assert.deepEqual(state.inventory, { fish_legendary: 1 });
  assert.deepEqual(state.fishing.catches, {});
  assert.deepEqual(food.residentOrderBoard(state, now).offers.filter(item => item.slot !== 0), board.offers.filter(item => item.slot !== 0));
});

test('market class unlocks follow available routes and a rod with positive class odds', () => {
  assert.equal(market.marketRequiredHomeLevel('fish_common'), 1);
  assert.equal(market.marketRequiredHomeLevel('fish_uncommon'), 1);
  const legendary = market.marketRequiredHomeLevel('fish_legendary');
  assert.ok(Number.isFinite(legendary) && legendary >= 4);
  assert.equal(market.marketRequiredHomeLevel('fish_shark'), legendary);
  const state = fresh(); state.buildings.home = 5;
  assert.equal(market.marketItemUnlocked(state, 'fish_legendary'), false, 'a high home cannot invent ownership of a legendary rod');
  state.fishing.ownedRods = catalog.fishing.rods.map(rod => rod.id);
  state.fishing.ownedHooks = catalog.fishing.hooks.map(hook => hook.id);
  for (const group of catalog.fishing.classes) {
    const quantity = 2, price = catalog.items.find(item => item.id === group.itemId).baseSellPrice * quantity;
    assert.equal(market.marketListingEligible({ itemId: group.itemId, quantity, totalPrice: price }, state), true);
  }
  state.unlockedItems = catalog.fishing.classes.map(group => group.itemId);
  state.fishing.ownedRods = ['reed_rod'];
  assert.equal(market.marketItemUnlocked(state, 'fish_legendary'), true, 'permanent discovery remains after the source becomes unavailable');
});

test('version4 jobs claim their frozen species and costs regardless of current rod odds', () => {
  const state = fresh(); state.inventory = {};
  const id = crypto.randomUUID();
  const saved = { id, kind: 'exploration', targetId: 'shore_camp', recipeId: null, targetLevel: null,
    startedAt: new Date(now - 900000).toISOString(), finishesAt: new Date(now).toISOString(),
    cost: { coins: 0, items: { firefly_bait: 1 } }, catalogVersion: 4,
    rewards: { fish_sturgeon: 2, fish_mirror_koi: 1, fish_shark: 1 },
    fishing: { rodId: 'reed_rod', hookId: 'bare_hook', baitId: 'firefly_bait', fishId: 'fish_sturgeon' } };
  state.jobs = [structuredClone(saved)];
  assert.equal(fish.fishingBaitCompatible(saved.fishing.rodId, saved.fishing.baitId), false);
  apply(state, command('claim_job', id));
  assert.deepEqual(state.inventory, { fish_epic: 3, fish_legendary: 1 });
  assert.deepEqual(state.fishing.catches, saved.rewards);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.fishing.equippedRodId, 'reed_rod');
});

test('unfinished catches hide class rolls while completed catches preserve actual classes without inventing species', () => {
  const id = crypto.randomUUID();
  const saved = { id, kind: 'exploration', targetId: 'shore', recipeId: null, targetLevel: null,
    startedAt: new Date(now - 180000).toISOString(), finishesAt: new Date(now).toISOString(), cost: { coins: 0, items: {} }, catalogVersion: 4,
    rewards: { fish_common: 1, fish_legendary: 1 }, fishing: { rodId: 'starfall_rod', hookId: 'leviathan_hook', baitId: null, fishId: 'fish_shark' } };
  const hidden = publicEconomyJob(saved, now - 1);
  assert.deepEqual(hidden.rewards, { fish: 2 }); assert.equal(hidden.fishing.fishId, 'fish');
  assert.deepEqual(publicEconomyJob(saved, now).rewards, saved.rewards);
  assert.deepEqual(publicEconomyJob(saved, now).fishing, { ...saved.fishing, catchRevealed: true });
  const state = fresh(); state.inventory = {}; state.jobs = [saved];
  const before = { ...structuredClone(state), jobs: [hidden], ownerPublicId: 'AAAA-0000-0001', revision: 0, catalog };
  const input = command('claim_job', id); apply(state, input);
  assert.deepEqual(state.inventory, { fish_common: 1, fish_legendary: 1 });
  assert.deepEqual(state.fishing.catches, {}, 'class-only deliveries cannot fabricate which species was caught');
  const afterState = { ...state, ownerPublicId: before.ownerPublicId, revision: 1, catalog };
  const gain = inventoryGainFromReceipt(before, { state: afterState, acceptedRevision: 1, replayed: false }, input);
  assert.deepEqual(gain.items, [{ itemId: 'fish_common', quantity: 1 }, { itemId: 'fish_legendary', quantity: 1 }]);
});

test('catalog rejects duplicate classes, missing class species, extra routes and undrawn output', () => {
  for (const alter of [
    value => { value.fishing.classes[1].rarity = 'common'; },
    value => { value.fishing.classes[1].itemId = 'fish_common'; },
    value => { value.fishing.fish = value.fishing.fish.filter(item => item.rarity !== 'legendary'); },
    value => { value.fishing.collectionDrawsByRoute.missing_route = 1; },
    value => { value.fishing.collectionDrawsByRoute.shore = 1; },
    value => { delete value.fishing.rods[0].classOddsBps; },
    value => { for (const rod of value.fishing.rods) { rod.classOddsBps.common += rod.classOddsBps.epic; rod.classOddsBps.epic = 0; } },
  ]) { const changed = structuredClone(catalog); alter(changed); assert.equal(economyCatalogSchema.safeParse(changed).success, false); }
});
