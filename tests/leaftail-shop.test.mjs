import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule('/lib/dev/api-store.ts');
const economy = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
const model = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const shop = await vite.ssrLoadModule('/features/economy/domain/leaftail-shop.ts');
const { inventoryGainFromReceipt } = await vite.ssrLoadModule('/features/economy/domain/inventory-gain.ts');
const { leaftailPurchaseReason, WorldLeaftailMarket } = await vite.ssrLoadModule('/features/economy/ui/market/world-leaftail-market.tsx');
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const now = Date.parse('2026-10-16T17:00:00Z'), midnight = Date.parse('2026-10-17T00:00:00Z');
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const saved = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const stock = (p, at = now) => shop.leaftailShopView(read(p, at), at);
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
function player(home = 3) {
  const p = identities.createDevIdentity('У Листохвоста', crypto.randomUUID());
  read(p); Object.assign(saved(p), { inventory: {}, wallet: { coins: 10_000, pearls: 1000 } });
  saved(p).buildings.home = home; return p;
}
function request(p, itemId = 'living_resin', at = now, extra = {}) {
  const state = read(p, at), offer = shop.leaftailShopView(state, at).offers.find(item => item.itemId === itemId);
  return { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: state.revision,
    action: 'buy_leaftail_item', targetId: offer.targetId, quantity: 1, totalPrice: offer.priceCoins, ...extra };
}
const buy = (p, itemId, at = now) => economy.commandDevEconomy(p.token, request(p, itemId, at), at);
const controller = (state, at = now) => ({ snapshot: state, snapshotConfirmed: true, now: at, retryAt: 0,
  busy: false, uncertain: false, directActionsAvailable: true, pendingProductionCount: 0 });
function quote(state, itemId = 'living_resin', at = now) {
  const offer = shop.leaftailShopView(state, at, state.catalog).offers.find(item => item.itemId === itemId);
  return { owner: state.ownerPublicId, revision: state.revision, targetId: offer.targetId, itemId, price: offer.priceCoins };
}

test('one deterministic daily delivery exposes only three special items and preserves legacy snapshots', () => {
  const p = player(), before = read(p), initial = stock(p);
  assert.equal(initial.requiredHomeLevel, 3); assert.equal(initial.refreshAt, midnight);
  assert.deepEqual(initial.offers.map(item => [item.itemId, item.priceCoins, item.stock, item.remaining]),
    [['ancient_core', 2400, 1, 1], ['moon_crystal', 2400, 1, 1], ['living_resin', 2400, 1, 1]]);
  for (const at of [now, now + 1, midnight - 1]) assert.deepEqual(shop.leaftailShopView(before, at), initial);
  assert.deepEqual(stock(p), initial);
  assert.equal(read(p).revision, before.revision); assert.equal(saved(p).leaftailShop, undefined);
  const legacy = structuredClone(before); delete legacy.leaftailShop; delete legacy.catalog.leaftailShop;
  const parsed = model.economyViewSchema.parse(legacy);
  assert.deepEqual(parsed.leaftailShop, { cycle: -1, purchased: {} });
  assert.equal(shop.leaftailShopView(parsed, now, parsed.catalog), null);
  assert.equal(model.economyCatalogSchema.safeParse({ ...before.catalog, leaftailShop: { ...before.catalog.leaftailShop,
    offers: [{ id: 'wood', itemId: 'wood', priceCoins: 1, stock: 1 }] } }).success, false);
});

test('a confirmed purchase spends coins, consumes personal stock and adds only its item without exploration discovery', () => {
  const p = player(), q = player(), before = read(p), command = request(p);
  const first = economy.commandDevEconomy(p.token, command, now);
  assert.equal(model.economyResultSchema.safeParse(first).success, true);
  assert.deepEqual(first.state.wallet, { coins: 7600, pearls: 1000 });
  assert.deepEqual(first.state.inventory, { living_resin: 1 });
  assert.deepEqual(first.state.progression, before.progression);
  assert.deepEqual(first.state.fishing, before.fishing);
  assert.equal(first.state.completedExplorations, before.completedExplorations);
  assert.equal(stock(p).offers.find(item => item.itemId === 'living_resin').remaining, 0);
  assert.ok(stock(q).offers.every(item => item.remaining === 1));
  const gain = inventoryGainFromReceipt(before, first, command);
  assert.deepEqual(gain.items, [{ itemId: 'living_resin', quantity: 1 }]); assert.equal(gain.source, 'purchase');
  for (const itemId of ['ancient_core', 'moon_crystal']) buy(p, itemId);
  assert.deepEqual(read(p).inventory, { living_resin: 1, ancient_core: 1, moon_crystal: 1 });
  assert.ok(stock(p).offers.every(item => item.remaining === 0));
});

test('one receipt survives replay and restart; new purchases, racing revisions and changed request bodies cannot double spend', async () => {
  const p = player(), command = request(p), first = economy.commandDevEconomy(p.token, command, now);
  const reopened = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
  const replay = reopened.commandDevEconomy(p.token, command, now + 1);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.equal(inventoryGainFromReceipt(first.state, replay, command), null);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, requestId: crypto.randomUUID() }, now), { code: 'ECONOMY_REVISION_CONFLICT' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, totalPrice: 2399 }, now), { code: 'ECONOMY_REQUEST_CONFLICT' });
  assert.throws(() => buy(p, 'living_resin'), { code: 'ECONOMY_LEAFTAIL_STOCK' });
  assert.equal(read(p).wallet.coins, 7600); assert.equal(read(p).inventory.living_resin, 1);
});

test('home, owner, exact price, quantity and malformed item quotes fail before balances or stock change', () => {
  const p = player(), stranger = player(), command = request(p), before = read(p);
  assert.throws(() => economy.commandDevEconomy(stranger.token, command, now), { code: 'ECONOMY_OWNER_CHANGED' });
  for (const totalPrice of [0, 2399, 2401])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...command, totalPrice }, now), { code: 'ECONOMY_LEAFTAIL_PRICE_CHANGED' });
  for (const targetId of ['living_resin', `${stock(p).cycle}:wood`, `${stock(p).cycle}:__proto__`])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...command, targetId }, now), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, quantity: 2 }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, fishSelection: {} }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, rewards: { living_resin: 100 } }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  assert.deepEqual(read(p), before);
  saved(p).buildings.home = 2;
  assert.throws(() => buy(p, 'living_resin'), { code: 'ECONOMY_HOME_REQUIRED' });
  saved(p).buildings.home = 3; saved(p).wallet.coins = 2399;
  assert.throws(() => buy(p, 'living_resin'), { code: 'ECONOMY_RESOURCES' });
  assert.equal(saved(p).leaftailShop, undefined);
});

test('full and overfull storage and market escrow preserve wallet and unconsumed stock', () => {
  const p = player(); saved(p).inventory = { wood: 50 };
  const before = read(p), command = request(p);
  assert.throws(() => economy.commandDevEconomy(p.token, command, now), { code: 'ECONOMY_STORAGE_FULL' });
  assert.deepEqual(read(p), before);
  saved(p).inventory = { wood: 51 };
  assert.throws(() => buy(p, 'living_resin'), { code: 'ECONOMY_STORAGE_FULL' });
  saved(p).inventory = { wood: 49 };
  const owner = p.me.user.publicId;
  globalThis.__zhivDevEconomyStore.listings.set(crypto.randomUUID(), { id: crypto.randomUUID(), sellerPublicId: owner,
    sellerName: 'Seller', itemId: 'stone', quantity: 1, totalPrice: 1, status: 'active', createdAt: new Date(now).toISOString(), closedAt: null });
  assert.equal(read(p).storage.available, 0);
  assert.throws(() => buy(p, 'living_resin'), { code: 'ECONOMY_STORAGE_FULL' });
  assert.equal(read(p).wallet.coins, 10_000); assert.equal(saved(p).leaftailShop, undefined);
});

test('UTC midnight resets once, rejects yesterday quote and replaying yesterday receipt does not consume today stock', () => {
  const p = player(), command = request(p), first = economy.commandDevEconomy(p.token, command, now);
  const before = read(p, midnight), yesterday = { ...command, expectedRevision: before.revision, requestId: crypto.randomUUID() };
  assert.ok(stock(p, midnight).offers.every(item => item.remaining === 1));
  assert.throws(() => economy.commandDevEconomy(p.token, yesterday, midnight), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  const replay = economy.commandDevEconomy(p.token, command, midnight);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.coins, first.state.wallet.coins);
  const second = buy(p, 'living_resin', midnight).state;
  assert.equal(second.inventory.living_resin, 2); assert.equal(second.wallet.coins, 5200);
  assert.equal(stock(p, midnight + 1).offers.find(item => item.itemId === 'living_resin').remaining, 0);
  assert.equal(shop.leaftailShopView(saved(p), now).offers.find(item => item.itemId === 'living_resin').remaining, 0, 'server clock rewind cannot replenish stock');
});

test('purchase UI revalidates the displayed account revision, cycle, funds, online state and capacity', () => {
  const p = player(), state = read(p), q = quote(state), ready = controller(state);
  assert.equal(leaftailPurchaseReason(ready, q, true), null);
  assert.match(leaftailPurchaseReason(ready, q, false), /соединение/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshotConfirmed: false }, q, true), /подтверждения/);
  assert.match(leaftailPurchaseReason({ ...ready, pendingProductionCount: 1 }, q, true), /подтверждения/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, ownerPublicId: 'OTHER' } }, q, true), /обновились/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, revision: state.revision + 1 } }, q, true), /обновились/);
  assert.match(leaftailPurchaseReason({ ...ready, now: midnight }, q, true), /Поставка изменилась/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, wallet: { ...state.wallet, coins: 0 } } }, q, true), /Не хватает/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, storage: { ...state.storage, available: 0 } } }, q, true), /место/);
  const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy: ready, isOnline: true }));
  assert.equal((html.match(/data-leaftail-item=/g) ?? []).length, 3); assert.match(html, /03:00 МСК/);
  assert.doesNotMatch(html, /жемчуг|Заказы жителей|Редкие товары появятся/);
});


test('a schema-valid cached far-future delivery cannot crash the merchant or replenish its stock', () => {
  const p = player(), state = structuredClone(read(p));
  state.leaftailShop = { cycle: Number.MAX_SAFE_INTEGER, purchased: { living_resin: 1 } };
  assert.equal(model.economyViewSchema.safeParse(state).success, true);
  const savedStock = structuredClone(state.leaftailShop);
  const unconfirmed = { ...controller(state), snapshotConfirmed: false };
  const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy: unconfirmed, isOnline: true }));
  assert.match(html, /Проверяем время новой поставки/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.equal(shop.leaftailShopView(state, now).cycle, Number.MAX_SAFE_INTEGER);
  assert.equal(shop.leaftailShopView(state, now).offers.find(item => item.itemId === 'living_resin').remaining, 0);
  assert.match(leaftailPurchaseReason(unconfirmed, quote(state), true), /подтверждения/);
  assert.deepEqual(state.leaftailShop, savedStock);
});
