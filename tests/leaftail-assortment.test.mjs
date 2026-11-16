import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule('/lib/dev/api-store.ts');
const economy = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
const world = await vite.ssrLoadModule('/lib/dev/world-store.ts');
const model = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const shop = await vite.ssrLoadModule('/features/economy/domain/leaftail-shop.ts');
const { createFishingShop } = await vite.ssrLoadModule('/features/economy/domain/fishing-shop.ts');
const now = Date.parse('2026-10-18T17:00:00Z'), tomorrow = now + 86400000;
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const saved = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const stock = (p, at = now) => shop.leaftailShopView(read(p, at), at);
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); world.resetDevWorldStoreForTests(); });
function player(home = 3) {
  const p = identities.createDevIdentity('Новая поставка', crypto.randomUUID());
  read(p); Object.assign(saved(p), { inventory: {}, wallet: { coins: 1_000_000, pearls: 100 } });
  saved(p).buildings.home = home; return p;
}
function command(p, itemId, at = now, extra = {}) {
  const state = read(p, at), offer = shop.leaftailShopView(state, at).offers.find(item => item.itemId === itemId);
  return { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: state.revision,
    action: 'buy_leaftail_item', targetId: offer.targetId, quantity: 1, totalPrice: offer.unitPrice, ...extra };
}
const buy = (p, itemId, at = now, extra = {}) => economy.commandDevEconomy(p.token, command(p, itemId, at, extra), at);
function nextDeliveryWith(p, itemId, start = tomorrow) {
  const state = read(p);
  for (let index = 0; index < 100; index++) {
    const at = start + index * 86400000;
    const preview = { ...state, leaftailShop: { cycle: -1, purchased: {} } };
    if (shop.leaftailShopView(preview, at, state.catalog).offers.some(item => item.itemId === itemId)) return at;
  }
  throw Error(`No delivery selected ${itemId}`);
}


test('v14 delivery rotates all departments after applying home eligibility while legacy snapshots remain readable', () => {
  const p = player(), view = stock(p), catalog = read(p).catalog;
  assert.equal(catalog.version, 15);
  assert.equal(catalog.leaftailShop.offers.length, 3);
  assert.equal(catalog.leaftailShop.supplyOffers.length, 8);
  assert.equal(catalog.leaftailShop.pearlOffers.length, 3);
  assert.equal(catalog.leaftailShop.travelOffers.length, 21);
  assert.deepEqual(Object.fromEntries(['wardrobe', 'rod', 'hook', 'bait'].map(kind => [kind, view.offers.filter(item => item.kind === kind).length])),
    { wardrobe: 2, rod: 1, hook: 1, bait: 1 });
  assert.ok(view.offers.every(item => item.requiredHomeLevel <= 3 && item.unlocked));
  const legacy = structuredClone(catalog); legacy.version = 11;
  delete legacy.leaftailShop.travelOffers; delete legacy.leaftailShop.supplyOffers; delete legacy.leaftailShop.pearlOffers;
  assert.deepEqual(model.economyCatalogSchema.parse(legacy).leaftailShop.travelOffers, []);
  assert.equal(shop.leaftailShopView({ buildings: { home: 3 } }, now, legacy).offers.length, 3);
  assert.deepEqual(shop.leaftailShopView({ buildings: { home: 3 } }, now, catalog).offers, [], 'personal v12 stock requires an owner');
});

test('selected clothes are permanent independent of full pantry, project into world immediately and do not equip themselves', () => {
  const p = player(); world.getDevWorld(p.token, now);
  saved(p).inventory = { wood: read(p).storage.capacity };
  const original = read(p), worldBefore = structuredClone(globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state);
  const clothes = stock(p).offers.filter(item => item.kind === 'wardrobe');
  let spent = 0;
  for (const offer of clothes) {
    const result = buy(p, offer.itemId).state; spent += offer.priceCoins;
    assert.ok(result.wardrobe.includes(offer.itemId));
    assert.ok(globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state.inventory.includes(offer.itemId), 'confirmed wardrobe projects at commit, before another GET');
    assert.deepEqual(result.inventory, original.inventory);
    assert.deepEqual(result.fishing, original.fishing);
    assert.equal(stock(p).offers.find(item => item.itemId === offer.itemId).owned, true);
    assert.deepEqual(globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state.equipment, worldBefore.equipment);
    assert.throws(() => buy(p, offer.itemId), { code: 'ECONOMY_LEAFTAIL_STOCK' });
    for (const prefix of ['', 'coins:', 'pearls:']) assert.throws(() => buy(p, offer.itemId, now,
      { action: 'buy_wardrobe_item', targetId: `${prefix}${offer.itemId}` }), { code: 'ECONOMY_WARDROBE_ITEM' });
  }
  assert.equal(read(p).wallet.coins, original.wallet.coins - spent);
  assert.equal(read(p).wallet.pearls, original.wallet.pearls);
  assert.throws(() => buy(p, clothes[0].itemId, nextDeliveryWith(p, clothes[0].itemId)), { code: 'ECONOMY_WARDROBE_OWNED' });
});

test('rods and hooks keep equipped tackle intact and cannot be bought again after a delivery reset', () => {
  const p = player(4); saved(p).inventory = { wood: read(p).storage.capacity };
  const initial = read(p), offers = stock(p).offers.filter(item => ['rod', 'hook'].includes(item.kind));
  for (const offer of offers) {
    const before = read(p), result = buy(p, offer.itemId).state;
    const key = offer.kind === 'rod' ? 'ownedRods' : 'ownedHooks';
    assert.deepEqual(result.fishing[key], [...before.fishing[key], offer.itemId]);
    assert.equal(result.fishing.equippedRodId, initial.fishing.equippedRodId);
    assert.equal(result.fishing.equippedHookId, initial.fishing.equippedHookId);
    assert.equal(result.fishing.equippedBaitId, initial.fishing.equippedBaitId);
    assert.deepEqual(result.inventory, initial.inventory);
    assert.throws(() => buy(p, offer.itemId, nextDeliveryWith(p, offer.itemId)), { code: 'ECONOMY_FISHING_OWNED' });
  }
});

test('the selected bait sells five individual units and validates storage, escrow and caps before spending', () => {
  const p = player(4), capacity = read(p).storage.capacity, offer = stock(p).offers.find(item => item.kind === 'bait'), itemId = offer.itemId;
  const purchase = () => buy(p, itemId, now, { quantity: 5, totalPrice: offer.unitPrice * 5 });
  saved(p).inventory = { wood: capacity - 4 };
  let before = read(p);
  assert.throws(purchase, { code: 'ECONOMY_STORAGE_FULL' }); assert.deepEqual(read(p), before);
  saved(p).inventory = { wood: capacity - 5 };
  const listingId = crypto.randomUUID();
  globalThis.__zhivDevEconomyStore.listings.set(listingId, { id: listingId, sellerPublicId: p.me.user.publicId,
    sellerName: 'Путник', itemId: 'fiber', quantity: 1, totalPrice: 1, status: 'active', createdAt: new Date(now).toISOString(), closedAt: null });
  before = read(p);
  assert.throws(purchase, { code: 'ECONOMY_STORAGE_FULL' }); assert.deepEqual(read(p), before);
  globalThis.__zhivDevEconomyStore.listings.delete(listingId);
  const result = purchase().state;
  assert.equal(result.inventory[itemId], 5); assert.equal(result.storage.available, 0);
  assert.equal(result.wallet.coins, before.wallet.coins - offer.unitPrice * 5); assert.equal(result.wallet.pearls, before.wallet.pearls);
  assert.equal(result.leaftailShop.purchased[offer.id], 5); assert.equal(result.fishing.equippedBaitId, null);
  const capped = player(4), cappedOffer = stock(capped).offers.find(item => item.kind === 'bait');
  saved(capped).inventory = { [cappedOffer.itemId]: model.ECONOMY_MAX_ITEMS - 4 };
  const cappedBefore = read(capped);
  assert.throws(() => buy(capped, cappedOffer.itemId, now, { quantity: 5, totalPrice: cappedOffer.unitPrice * 5 }), { code: 'ECONOMY_CAPACITY' });
  assert.deepEqual(read(capped), cappedBefore);
});

test('new assortment rejects locked/unselected goods and validates exact price, count and owner atomically', () => {
  const p = player(), before = read(p), hat = stock(p).offers.find(item => item.kind === 'wardrobe'), q = command(p, hat.itemId);
  const cycle = stock(p).cycle;
  for (const itemId of ['dusk_rod', 'dusk_hook', 'dusk_bait']) {
    assert.ok(!stock(p).offers.some(item => item.itemId === itemId));
    assert.throws(() => economy.commandDevEconomy(p.token, { ...q, requestId: crypto.randomUUID(), targetId: `v2:${cycle}:${itemId}` }, now), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  }
  for (const totalPrice of [0, q.totalPrice - 1, q.totalPrice + 1]) assert.throws(() => economy.commandDevEconomy(p.token, { ...q, totalPrice }, now), { code: 'ECONOMY_LEAFTAIL_PRICE_CHANGED' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...q, quantity: 2, totalPrice: q.totalPrice * 2 }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  const stranger = player(); assert.throws(() => economy.commandDevEconomy(stranger.token, q, now), { code: 'ECONOMY_OWNER_CHANGED' });
  assert.deepEqual(read(p), before);
  saved(p).wallet.coins = hat.unitPrice - 1; const poor = read(p);
  assert.throws(() => buy(p, hat.itemId), { code: 'ECONOMY_RESOURCES' }); assert.deepEqual(read(p), poor);
});

test('selected clothing, gear and bait receipts replay once while stale delivery and revisions cannot debit twice', async () => {
  for (const kind of ['wardrobe', 'rod', 'bait']) {
    const p = player(), offer = stock(p).offers.find(item => item.kind === kind), q = command(p, offer.itemId), first = economy.commandDevEconomy(p.token, q, now);
    const reopened = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
    const replay = reopened.commandDevEconomy(p.token, q, now + 1);
    assert.equal(replay.replayed, true); assert.deepEqual({ ...replay.state, serverTime: first.state.serverTime }, first.state);
    assert.throws(() => economy.commandDevEconomy(p.token, { ...q, requestId: crypto.randomUUID() }, now), { code: 'ECONOMY_REVISION_CONFLICT' });
    assert.throws(() => economy.commandDevEconomy(p.token, { ...q, totalPrice: q.totalPrice - 1 }, now), { code: 'ECONOMY_REQUEST_CONFLICT' });
    const back = { ...q, requestId: crypto.randomUUID(), expectedRevision: read(p).revision };
    if (kind !== 'bait') assert.throws(() => economy.commandDevEconomy(p.token, back, now - 86400000), { code: 'ECONOMY_LEAFTAIL_STOCK' });
    const current = read(p, tomorrow);
    assert.throws(() => economy.commandDevEconomy(p.token, { ...q, requestId: crypto.randomUUID(), expectedRevision: current.revision }, tomorrow), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  }
});

test('Pleska generation and injected persisted offers cannot sell Leaftail exclusive gear', () => {
  const p = player(5), state = read(p), fishing = state.catalog.fishing;
  const exclusive = state.catalog.leaftailShop.travelOffers.filter(item => (item.kind === 'rod' ? fishing.rods.find(gear => gear.id === item.itemId)
    : item.kind === 'hook' ? fishing.hooks.find(gear => gear.id === item.itemId)
    : item.kind === 'bait' ? fishing.baits.find(gear => gear.itemId === item.itemId) : undefined)?.shop === 'leaftail');
  const ids = new Set(exclusive.map(item => item.itemId));
  for (let n = 0; n < 80; n++) {
    const generated = createFishingShop(saved(p), now, max => n % max);
    assert.ok(generated.offers.every(offer => !ids.has(offer.itemId)));
  }
  for (const offer of exclusive) {
    const id = `${state.fishingShop.id}:${offer.itemId}`;
    saved(p).fishingShop.offers = [{ id, kind: offer.kind, itemId: offer.itemId, unitPrice: 1, remaining: 5 }];
    const before = read(p);
    assert.throws(() => economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: before.revision, action: 'buy_fishing_item', targetId: id, totalPrice: 1, quantity: 1 }, now), { code: 'ECONOMY_FISHING_ITEM' });
    assert.deepEqual(read(p), before);
  }
});

test('catalog rejects mixed legacy slots, duplicate cross-array ids, invalid sources and cheap gear', () => {
  const catalog = read(player()).catalog, original = catalog.leaftailShop;
  const valid = model.economyCatalogSchema.safeParse(catalog); assert.equal(valid.success, true);
  const rejects = travelOffers => assert.equal(model.economyCatalogSchema.safeParse({ ...catalog, leaftailShop: { ...original, travelOffers } }).success, false);
  const hat = original.travelOffers.find(offer => offer.kind === 'wardrobe'), rod = original.travelOffers.find(offer => offer.kind === 'rod');
  rejects([...original.travelOffers, { ...hat, id: original.offers[0].id }]);
  rejects([{ ...rod, kind: 'item' }]); rejects([{ ...rod, priceCoins: rod.priceCoins - 1 }]); rejects([{ ...rod, quantity: 2 }]);
  rejects([{ ...hat, itemId: 'amber_scarf' }]); rejects([{ ...hat, itemId: 'ranger_cap' }]);
  rejects([{ ...rod, itemId: 'willow_rod' }]);
  assert.equal(model.economyCatalogSchema.safeParse({ ...catalog, leaftailShop: { ...original, offers: [hat] } }).success, false);
  const tooMany = Array.from({ length: 33 }, (_, n) => ({ ...hat, id: `hat_${n}` })); rejects(tooMany);
});
