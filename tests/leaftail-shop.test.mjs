import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule('/lib/dev/api-store.ts');
const economy = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
const commandDevEconomy = economy.commandDevEconomy;
const model = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const shop = await vite.ssrLoadModule('/features/economy/domain/leaftail-shop.ts');
const { inventoryGainFromReceipt } = await vite.ssrLoadModule('/features/economy/domain/inventory-gain.ts');
const { localLeaftailPurchaseFromReceipt } = await vite.ssrLoadModule('/features/economy/domain/local-leaftail-purchase.ts');
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
function request(p, itemId, at = now, extra = {}) {
  const state = read(p, at), offers = shop.leaftailShopView(state, at).offers;
  const offer = itemId ? offers.find(item => item.itemId === itemId) : offers.find(item => item.section === 'finds');
  return { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: state.revision,
    action: 'buy_leaftail_item', targetId: offer.targetId, quantity: 1, totalPrice: offer.unitPrice, ...extra };
}
const buy = (p, itemId, at = now) => economy.commandDevEconomy(p.token, request(p, itemId, at), at);
const controller = (state, at = now) => ({ snapshot: state, snapshotConfirmed: true, now: at, retryAt: 0,
  busy: false, uncertain: false, directActionsAvailable: true, pendingProductionCount: 0 });
function quote(state, itemId, at = now) {
  const offers = shop.leaftailShopView(state, at, state.catalog).offers;
  const offer = itemId ? offers.find(item => item.itemId === itemId) : offers.find(item => item.section === 'finds');
  return { owner: state.ownerPublicId, revision: state.revision, targetId: offer.targetId, itemId: offer.itemId, kind: offer.kind, currency: offer.currency, unitPrice: offer.unitPrice, price: offer.unitPrice, quantity: 1, itemQuantity: offer.quantity };
}

test('a personal delivery rotates every department and prices finds only in pearls', () => {
  const p = player(), before = read(p), initial = stock(p);
  assert.equal(initial.requiredHomeLevel, 3); assert.equal(initial.refreshAt, midnight);
  const finds = initial.offers.filter(item => item.section === 'finds');
  assert.ok(finds.length >= 1 && finds.length <= 2);
  assert.ok(finds.every(item => ['ancient_core', 'moon_crystal', 'living_resin'].includes(item.itemId)
    && item.currency === 'pearls' && item.unitPrice === 300 && item.priceCoins === 0 && item.pricePearls === 300
    && item.stock === 1 && item.remaining === 1));
  assert.equal(initial.offers.filter(item => item.section === 'supplies').length, 3);
  assert.equal(initial.offers.filter(item => item.kind === 'wardrobe').length, 2);
  for (const kind of ['rod', 'hook', 'bait']) assert.equal(initial.offers.filter(item => item.kind === kind).length, 1);
  assert.ok(initial.offers.every(item => item.quantity === 1 && item.targetId === `v2:${initial.cycle}:${item.id}`));
  for (const at of [now, now + 1, midnight - 1]) assert.deepEqual(shop.leaftailShopView(before, at), initial);
  assert.deepEqual(stock(p), initial);
  assert.equal(read(p).revision, before.revision); assert.equal(saved(p).leaftailShop, undefined);
  const legacy = structuredClone(before); delete legacy.leaftailShop; delete legacy.catalog.leaftailShop;
  const parsed = model.economyViewSchema.parse(legacy);
  assert.deepEqual(parsed.leaftailShop, { cycle: -1, purchased: {} });
  assert.equal(shop.leaftailShopView(parsed, now, parsed.catalog), null);
});

test('legacy v11 find vectors survive without exposing the old coin sale in v12', () => {
  const catalog = structuredClone(model.economyCatalog);
  catalog.version = 11; delete catalog.leaftailShop.supplyOffers; delete catalog.leaftailShop.pearlOffers;
  catalog.leaftailShop.offers.unshift(...['ancient_core', 'moon_crystal', 'living_resin'].map(id =>
    ({ id, itemId: id, kind: 'item', quantity: 1, priceCoins: 2400, stock: 1 })));
  const special = new Set(catalog.items.filter(item => item.category === 'special').map(item => item.id));
  const ids = (owner, cycle) => shop.leaftailShopOffers(catalog, cycle, owner).filter(item => special.has(item.itemId)).map(item => item.id);
  for (const [owner, cycle, expected] of [
    ['AAAA-0000-0001', 20742, ['ancient_core', 'living_resin']],
    ['AAAA-0000-0001', 20743, ['living_resin']],
    ['AAAA-0000-0002', 20742, ['living_resin']],
    ['AAAA-0000-0002', 20743, ['moon_crystal', 'living_resin']],
    ['ABCD-EFGH-JKMP', Number.MAX_SAFE_INTEGER, ['moon_crystal', 'living_resin']],
    ['Мохлик', 20743, ['ancient_core']],
  ]) assert.deepEqual(ids(owner, cycle), expected);
  assert.deepEqual(ids(undefined, 20742), []);
  const current = stock(player());
  assert.ok(current.offers.filter(item => special.has(item.itemId)).every(item => item.currency === 'pearls'));
  assert.ok(!current.offers.some(item => item.priceCoins === 2400 && special.has(item.itemId)));
});

test('a forged request for an absent finding cannot spend or manufacture a purchase receipt', () => {
  const p = player(), before = read(p), delivery = stock(p), selected = new Set(delivery.offers.map(item => item.id));
  const absent = before.catalog.leaftailShop.pearlOffers.find(item => !selected.has(item.id));
  assert.ok(absent);
  const forged = { ...request(p), targetId: `v2:${delivery.cycle}:${absent.id}`, totalPrice: absent.pricePearls };
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.throws(() => economy.commandDevEconomy(p.token, { ...forged, requestId: crypto.randomUUID() }, now), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
    assert.deepEqual(read(p), before);
  }
  const fakeAfter = { ...before, revision: before.revision + 1, wallet: { ...before.wallet, pearls: before.wallet.pearls - 300 },
    inventory: { [absent.itemId]: 1 }, leaftailShop: { cycle: delivery.cycle, purchased: { [absent.id]: 1 } } };
  assert.equal(localLeaftailPurchaseFromReceipt(before, { state: fakeAfter, acceptedRevision: fakeAfter.revision, replayed: false, message: '' }, forged), null);
  const first = delivery.offers.find(item => item.section === 'finds'); buy(p, first.itemId);
  assert.deepEqual(stock(p).offers.map(item => item.id), delivery.offers.map(item => item.id), 'purchasing never rerolls an unbought delivery');
});

test('a confirmed find purchase spends 300 pearls and delivers one relic without exploration discovery', () => {
  const p = player(), before = read(p), command = request(p), itemId = quote(before).itemId;
  const first = economy.commandDevEconomy(p.token, command, now);
  assert.equal(model.economyResultSchema.safeParse(first).success, true);
  assert.deepEqual(first.state.wallet, { coins: 10000, pearls: 700 });
  assert.deepEqual(first.state.inventory, { [itemId]: 1 });
  assert.deepEqual(first.state.progression, before.progression); assert.deepEqual(first.state.fishing, before.fishing);
  assert.equal(first.state.completedExplorations, before.completedExplorations);
  assert.equal(stock(p).offers.find(item => item.itemId === itemId).remaining, 0);
  const gain = inventoryGainFromReceipt(before, first, command);
  assert.deepEqual(gain.items, [{ itemId, quantity: 1 }]); assert.equal(gain.source, 'purchase');
  const receipt = localLeaftailPurchaseFromReceipt(before, first, command);
  assert.equal(receipt.currency, 'pearls'); assert.equal(receipt.pearls, 300); assert.equal(receipt.coins, 0);
});

test('one exact receipt survives replay/restart and cannot double debit after request races', async () => {
  const p = player(), command = request(p), first = economy.commandDevEconomy(p.token, command, now);
  const reopened = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
  const replay = reopened.commandDevEconomy(p.token, command, now + 1);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.equal(inventoryGainFromReceipt(first.state, replay, command), null);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, requestId: crypto.randomUUID() }, now), { code: 'ECONOMY_REVISION_CONFLICT' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, totalPrice: 299 }, now), { code: 'ECONOMY_REQUEST_CONFLICT' });
  assert.throws(() => buy(p), { code: 'ECONOMY_LEAFTAIL_STOCK' });
  assert.deepEqual(read(p).wallet, { coins: 10000, pearls: 700 });
});

test('owner, exact currency price, quantity, malformed quotes and home gates preserve balances', () => {
  const p = player(), stranger = player(), command = request(p), before = read(p);
  assert.throws(() => economy.commandDevEconomy(stranger.token, command, now), { code: 'ECONOMY_OWNER_CHANGED' });
  for (const totalPrice of [0, 299, 301, 2400])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...command, totalPrice }, now), { code: 'ECONOMY_LEAFTAIL_PRICE_CHANGED' });
  for (const targetId of ['living_resin', `${stock(p).cycle}:ancient_core`, `v2:${stock(p).cycle}:__proto__`])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...command, targetId }, now), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, quantity: 21, totalPrice: 6300 }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, fishSelection: {} }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, rewards: { living_resin: 100 } }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  assert.deepEqual(read(p), before);
  saved(p).buildings.home = 2;
  assert.throws(() => economy.commandDevEconomy(p.token, { ...command, expectedRevision: read(p).revision }, now), { code: 'ECONOMY_HOME_REQUIRED' });
  saved(p).buildings.home = 3; saved(p).wallet.pearls = 299; saved(p).wallet.coins = 100000;
  const poor = read(p); assert.throws(() => buy(p), { code: 'ECONOMY_PEARLS' }); assert.deepEqual(read(p), poor);
  assert.equal(saved(p).leaftailShop, undefined);
});

test('full storage and market escrow preserve the pearl wallet and unconsumed finding', () => {
  const p = player(); saved(p).inventory = { wood: 50 };
  const before = read(p), command = request(p);
  assert.throws(() => economy.commandDevEconomy(p.token, command, now), { code: 'ECONOMY_STORAGE_FULL' }); assert.deepEqual(read(p), before);
  saved(p).inventory = { wood: 51 }; assert.throws(() => buy(p), { code: 'ECONOMY_STORAGE_FULL' });
  saved(p).inventory = { wood: 49 };
  const owner = p.me.user.publicId, id = crypto.randomUUID();
  globalThis.__zhivDevEconomyStore.listings.set(id, { id, sellerPublicId: owner,
    sellerName: 'Seller', itemId: 'stone', quantity: 1, totalPrice: 1, status: 'active', createdAt: new Date(now).toISOString(), closedAt: null });
  assert.equal(read(p).storage.available, 0); assert.throws(() => buy(p), { code: 'ECONOMY_STORAGE_FULL' });
  assert.deepEqual(read(p).wallet, { coins: 10000, pearls: 1000 }); assert.equal(saved(p).leaftailShop, undefined);
});

test('UTC midnight resets once; yesterday receipt replays without consuming a new delivery', () => {
  const p = player(), command = request(p), first = economy.commandDevEconomy(p.token, command, now);
  const before = read(p, midnight), yesterday = { ...command, expectedRevision: before.revision, requestId: crypto.randomUUID() };
  assert.ok(stock(p, midnight).offers.every(item => item.remaining === item.stock));
  assert.throws(() => economy.commandDevEconomy(p.token, yesterday, midnight), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  const replay = economy.commandDevEconomy(p.token, command, midnight);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, first.state.wallet);
  const itemId = quote(read(p, midnight), undefined, midnight).itemId, second = buy(p, itemId, midnight).state;
  assert.equal(second.inventory[itemId], (first.state.inventory[itemId] ?? 0) + 1); assert.equal(second.wallet.pearls, 400);
  assert.equal(stock(p, midnight + 1).offers.find(item => item.itemId === itemId).remaining, 0);
  assert.equal(shop.leaftailShopView({ ...saved(p), ownerPublicId: second.ownerPublicId }, now).offers.find(item => item.itemId === itemId).remaining, 0);
});

test('purchase UI revalidates the account, revision, cycle, selected currency and capacity', () => {
  const p = player(), state = read(p), q = quote(state), ready = controller(state);
  assert.equal(leaftailPurchaseReason(ready, q, true), null);
  assert.match(leaftailPurchaseReason(ready, q, false), /соединение/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshotConfirmed: false }, q, true), /подтверждения/);
  assert.match(leaftailPurchaseReason({ ...ready, pendingProductionCount: 1 }, q, true), /подтверждения/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, ownerPublicId: 'OTHER' } }, q, true), /обновились/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, revision: state.revision + 1 } }, q, true), /обновились/);
  assert.match(leaftailPurchaseReason({ ...ready, now: midnight }, q, true), /Поставка изменилась/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, wallet: { ...state.wallet, pearls: 0 } } }, q, true), /Не хватает/);
  assert.equal(leaftailPurchaseReason({ ...ready, snapshot: { ...state, wallet: { ...state.wallet, coins: 0 } } }, q, true), null);
  assert.match(leaftailPurchaseReason(ready, { ...q, currency: 'coins' }, true), /Поставка изменилась/);
  assert.match(leaftailPurchaseReason({ ...ready, snapshot: { ...state, storage: { ...state.storage, available: 0 } } }, q, true), /мест[оа]/);
  const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy: ready, isOnline: true, introduced: true }));
  assert.equal((html.match(/data-leaftail-item=/g) ?? []).length, 2); assert.match(html, /03:00 МСК/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>.*?Одежда/s); assert.match(html, />Припасы<\/button>/);
  assert.match(html, /жемчуг/i); assert.doesNotMatch(html, /Заказы жителей|Редкие товары появятся/);
});

test('the travelling merchant shows no stock, tabs, purchase copy or delivery before home 3', () => {
  for (const level of [1, 2]) {
    const p = player(level), state = read(p), original = structuredClone(state);
    const economy = { ...controller(state), error: "Проверяем покупку", uncertain: true,
      notice: "Покупка у Листохвоста отправлена в кладовую", act() { assert.fail("an absent merchant cannot buy anything"); } };
    const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy, isOnline: true }));
    assert.match(html, /data-leaftail-away/);
    assert.match(html, /Путник в дороге\. Он вернётся, когда дом достигнет 3-го уровня\./);
    assert.doesNotMatch(html, /Листохвост|data-leaftail-item|data-leaftail-purchase|role="tab|Купить|покупк|Собрал кое-что|Ваши монеты|поставка|поставку|Поставка|Припасы|Находки|2400/);
    assert.deepEqual(state, original);
    const eligible = { ...state, buildings: { ...state.buildings, home: 3 } };
    const q = quote(eligible);
    assert.match(leaftailPurchaseReason(controller(state), q, true), /Листохвост в путешествии/);
    assert.throws(() => commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: state.revision, action: 'buy_leaftail_item', targetId: q.targetId, quantity: 1, totalPrice: q.price }, now), { code: 'ECONOMY_HOME_REQUIRED' });
    assert.deepEqual(read(p), original, "the existing command fence also rejects supply bundles");
  }
});

test('an eligible house does not expose the merchant identity, stock or actions before his physical arrival', () => {
  const p = player(), state = read(p), original = structuredClone(state);
  const economy = { ...controller(state), error: "Проверяем покупку", uncertain: true,
    notice: "Покупка у Листохвоста отправлена в кладовую", act() { assert.fail("the pending arrival cannot buy anything"); } };
  const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy, isOnline: true, introduced: false }));
  assert.match(html, /Домик путника/);
  assert.match(html, /Путник ещё в дороге\. Дождитесь прибытия\./);
  assert.doesNotMatch(html, /Листохвост|<button|<canvas|data-leaftail-item|data-leaftail-purchase|role="tab|2400|Купить|покупк|Ваши монеты|Находки|Припасы/);
  assert.deepEqual(state, original);
});


test('a cached far-future delivery cannot crash the merchant or replenish unit stock', () => {
  const p = player(), state = structuredClone(read(p));
  state.leaftailShop = { cycle: Number.MAX_SAFE_INTEGER, purchased: {} };
  const supply = shop.leaftailShopView(state, now, state.catalog).offers.find(item => item.section === 'supplies');
  state.leaftailShop.purchased[supply.id] = supply.stock;
  assert.equal(model.economyViewSchema.safeParse(state).success, true);
  const savedStock = structuredClone(state.leaftailShop), unconfirmed = { ...controller(state), snapshotConfirmed: false };
  const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy: unconfirmed, isOnline: true, introduced: true }));
  assert.match(html, /Проверяем время новой поставки/);
  assert.equal((html.match(/data-leaftail-purchase=/g) ?? []).length, 2); assert.doesNotMatch(html, /Подтвердить/);
  assert.equal(shop.leaftailShopView(state, now).cycle, Number.MAX_SAFE_INTEGER);
  assert.equal(shop.leaftailShopView(state, now).offers.find(item => item.id === supply.id).remaining, 0);
  assert.match(leaftailPurchaseReason(unconfirmed, quote(state), true), /подтверждения/); assert.deepEqual(state.leaftailShop, savedStock);
});

test('retained stock and confirmation callbacks cannot buy after the current resident introduction is withdrawn', async () => {
  const hooksId = 'virtual:leaftail-introduction-hooks';
  const runtime = await createServer({ appType: 'custom', configFile: false, root, cacheDir: `/tmp/zhiv-leaftail-quote-hooks-${process.pid}`,
    resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [{ name: 'leaftail-introduction-hooks', enforce: 'pre',
      resolveId(id) { if (id === hooksId) return `\0${id}`; },
      load(id) { if (id === `\0${hooksId}`) return `
        let slots = [], cursor = 0;
        export function render() { cursor = 0; }
        export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
        export function useState(initial) { const slot = useRef(initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
        export function useId() { return useRef('leaftail-quote').current; }
        export function useEffect() {}
        export function useLayoutEffect(effect) { effect(); }
      `; },
      transform(source, id) { if (id.endsWith('/features/economy/ui/market/world-leaftail-market.tsx')) return source.replace('from "react";', `from "${hooksId}";`); },
    }] });
  try {
    const hooks = await runtime.ssrLoadModule(hooksId);
    const { WorldLeaftailMarket: Market } = await runtime.ssrLoadModule('/features/economy/ui/market/world-leaftail-market.tsx');
    const p = player(), calls = [], economy = { ...controller(read(p)), act: (...args) => { calls.push(args); return true; } };
    const render = introduced => {
      hooks.render(); const tree = Market({ economy, isOnline: true, introduced }), nodes = [];
      const visit = element => { if (React.isValidElement(element)) { nodes.push(element); React.Children.forEach(element.props.children, visit); } };
      visit(tree); return { tree, nodes };
    };
    render(true).nodes.find(element => element.props.role === 'tab' && React.Children.toArray(element.props.children).includes('Реликвии')).props.onClick();
    const purchase = render(true).nodes.find(element => element.props['data-leaftail-purchase'] === quote(economy.snapshot).itemId);
    purchase.props.onClick();
    const confirm = render(true).nodes.find(element => element.type === 'button' && element.props.children?.[0] === 'Подтвердить');
    assert.ok(confirm, 'a deliberate item selection opens the real quote confirmation');
    const hidden = render(false);
    assert.doesNotMatch(renderToStaticMarkup(hidden.tree), /Листохвост|<button|data-leaftail-item/);
    purchase.props.onClick(); confirm.props.onClick();
    assert.deepEqual(calls, [], 'neither a retained stock button nor its quote can act after the introduction closes');
    const restored = render(true).nodes.find(element => element.type === 'button' && element.props.children?.[0] === 'Подтвердить');
    restored.props.onClick(); restored.props.onClick();
    const q = quote(economy.snapshot);
    assert.deepEqual(calls, [['buy_leaftail_item', q.targetId, 1, q.price]], 'the introduced merchant still accepts one ordinary confirmed purchase');
  } finally { await runtime.close(); }
});


test('supplies sell selected individual units across multiple exact transactions and retain stock counts', () => {
  const p = player(), offer = stock(p).offers.find(item => item.section === 'supplies' && item.stock >= 5);
  assert.ok(offer); const original = read(p), purchased = [];
  for (const quantity of [2, 3]) {
    const before = read(p), command = request(p, offer.itemId, now, { quantity, totalPrice: offer.unitPrice * quantity });
    const result = economy.commandDevEconomy(p.token, command, now);
    assert.equal(result.state.inventory[offer.itemId], (before.inventory[offer.itemId] ?? 0) + quantity);
    assert.equal(result.state.wallet.coins, before.wallet.coins - offer.unitPrice * quantity);
    assert.equal(result.state.wallet.pearls, before.wallet.pearls);
    assert.deepEqual(inventoryGainFromReceipt(before, result, command).items, [{ itemId: offer.itemId, quantity }]);
    assert.equal(result.state.leaftailShop.purchased[offer.id], purchased.reduce((sum, n) => sum + n, quantity));
    assert.equal(economy.commandDevEconomy(p.token, command, now).replayed, true);
    purchased.push(quantity);
  }
  assert.equal(stock(p).offers.find(item => item.id === offer.id).remaining, offer.stock - 5);
  assert.equal(read(p).inventory[offer.itemId], 5); assert.equal(read(p).wallet.coins, original.wallet.coins - offer.unitPrice * 5);
});

test('current supply unit prices cannot mint coins via NPC resale and every quoted unit needs space', () => {
  const p = player(), original = read(p), offers = stock(p).offers.filter(item => item.section === 'supplies');
  for (const offer of offers) {
    const item = original.catalog.items.find(item => item.id === offer.itemId);
    assert.equal(offer.quantity, 1); assert.equal(offer.unitPrice, 2 * item.baseSellPrice);
  }
  const offer = offers.find(item => item.stock >= 10), itemId = offer.itemId;
  saved(p).inventory = { wood: 41 };
  let before = read(p), command = request(p, itemId, now, { quantity: 10, totalPrice: offer.unitPrice * 10 });
  assert.throws(() => economy.commandDevEconomy(p.token, command, now), { code: 'ECONOMY_STORAGE_FULL' }); assert.deepEqual(read(p), before);
  const q = quote(before, itemId); q.quantity = 10; q.itemQuantity = 10; q.price *= 10;
  assert.match(leaftailPurchaseReason(controller(before), q, true), /ещё 1/);
  saved(p).inventory = { wood: 40 };
  before = read(p); command = request(p, itemId, now, { quantity: 10, totalPrice: offer.unitPrice * 10 });
  assert.equal(economy.commandDevEconomy(p.token, command, now).state.storage.available, 0);
  const fresh = player(), freshOffer = stock(fresh).offers.find(item => item.section === 'supplies');
  saved(fresh).inventory = { [freshOffer.itemId]: model.ECONOMY_MAX_ITEMS };
  const capped = read(fresh);
  assert.throws(() => buy(fresh, freshOffer.itemId), { code: 'ECONOMY_CAPACITY' }); assert.deepEqual(read(fresh), capped);
});

test('unit confirmation pins currency, unit price and total quantity before sending', () => {
  const p = player(), state = read(p), offer = stock(p).offers.find(item => item.section === 'supplies'), q = quote(state, offer.itemId), ready = controller(state);
  assert.equal(q.quantity, 1); assert.equal(q.itemQuantity, 1); assert.equal(q.unitPrice, offer.unitPrice);
  assert.equal(leaftailPurchaseReason(ready, q, true), null);
  for (const changed of [{ ...q, itemQuantity: 10 }, { ...q, quantity: 2 }, { ...q, unitPrice: q.unitPrice + 1 }, { ...q, currency: 'pearls' }])
    assert.match(leaftailPurchaseReason(ready, changed, true), /Поставка изменилась/);
  const before = read(p);
  assert.throws(() => economy.commandDevEconomy(p.token, request(p, offer.itemId, now, { quantity: 2 }), now), { code: 'ECONOMY_LEAFTAIL_PRICE_CHANGED' });
  assert.deepEqual(read(p), before);
});

test('a known paid v11 bundle request replays after v12 without another debit or unit delivery', () => {
  const p = player(), profile = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId), cycle = stock(p).cycle;
  profile.state.inventory = { wood: 10 }; profile.state.wallet.coins = 9400; profile.revision = 1;
  profile.state.leaftailShop = { cycle, purchased: { wood_bundle: 1 } };
  const command = { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: 0,
    action: 'buy_leaftail_item', targetId: `${cycle}:wood_bundle`, quantity: 1, totalPrice: 600 };
  const signature = JSON.stringify([command.ownerPublicId, command.expectedRevision, command.action, command.targetId, command.quantity, command.totalPrice]);
  profile.receipts.set(command.requestId, { signature, message: 'Покупка у Листохвоста отправлена в кладовую', acceptedRevision: 1 });
  const before = read(p), replay = economy.commandDevEconomy(p.token, command, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, 1);
  assert.deepEqual(replay.state.wallet, before.wallet); assert.deepEqual(replay.state.inventory, before.inventory);
  assert.deepEqual(replay.state.leaftailShop, before.leaftailShop);
  assert.equal(localLeaftailPurchaseFromReceipt(before, replay, command), null);
  const stale = { ...command, requestId: crypto.randomUUID(), expectedRevision: before.revision };
  assert.throws(() => economy.commandDevEconomy(p.token, stale, now), { code: 'ECONOMY_LEAFTAIL_SHOP_CHANGED' });
  assert.deepEqual(read(p), before);
});
