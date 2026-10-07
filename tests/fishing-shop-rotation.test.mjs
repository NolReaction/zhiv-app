import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule('/lib/dev/api-store.ts');
const economy = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule('/features/economy/model.ts');
const { createFishingShop, refreshFishingShop, canRefreshFishingShop, fishingShopRefreshPrice } = await vite.ssrLoadModule('/features/economy/fishing-shop.ts');
const now = Date.parse('2026-10-05T20:00:00Z');
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
const player = () => identities.createDevIdentity('Shopper', crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const persisted = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const fund = p => { read(p); persisted(p).wallet = { coins: 1000000, pearls: 1000 }; return read(p); };
const command = (p, before, action, targetId, quantity = 1, totalPrice = 0) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: before.revision, action, targetId, quantity, totalPrice });
const buy = (p, view, offer, quantity = 1) => command(p, view, 'buy_fishing_item', offer.id, quantity, offer.unitPrice * quantity);

test('initial stock belongs to revision zero, repeated reads and a restarted adapter never reroll it', async () => {
  const p = player(), first = read(p), saved = structuredClone(first.fishingShop);
  assert.equal(first.revision, 0);
  assert.equal(saved.offers.length, 4);
  assert.equal(new Set(saved.offers.map(offer => offer.itemId)).size, 4);
  assert.equal(Date.parse(saved.refreshAt) - Date.parse(saved.openedAt), 6 * 3600000);
  assert.deepEqual(economyViewSchema.parse(first).fishingShop, saved);
  const reopened = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
  for (const at of [now, now + 1, Date.parse(saved.refreshAt) - 1]) {
    const next = reopened.getDevEconomy(p.token, at);
    assert.equal(next.revision, first.revision); assert.deepEqual(next.fishingShop, saved);
  }
  const legacy = structuredClone(first); delete legacy.fishingShop;
  assert.equal(economyViewSchema.parse(legacy).fishingShop, null);
});

test('stock is private to each player, gated by home, weighted by rarity and excludes owned gear on the next roll', () => {
  const p = player(), q = player(); fund(p);
  assert.notEqual(read(p).fishingShop.id, read(q).fishingShop.id);
  const state = persisted(p), spec = economyCatalog.fishing;
  for (let home = 1; home <= 5; home++) {
    state.buildings.home = home;
    for (const random of [() => 0, max => max - 1]) {
      const shop = createFishingShop(state, now, random, '00000000-0000-4000-8000-000000000001');
      for (const offer of shop.offers) {
        const item = (offer.kind === 'rod' ? spec.rods : offer.kind === 'hook' ? spec.hooks : offer.kind === 'fish' ? spec.fish : spec.baits)
          .find(item => (item.id ?? item.itemId) === offer.itemId);
        assert.ok((item.requiredHomeLevel ?? 1) <= home);
        assert.equal(offer.remaining, offer.kind === 'bait' ? 5 : offer.kind === 'fish' ? 3 : 1);
      }
    }
  }
  const first = createFishingShop(state, now, () => 0, '00000000-0000-4000-8000-000000000001');
  const last = createFishingShop(state, now, max => max - 1, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(first.offers.map(offer => offer.itemId), ['river_rod', 'barbed_hook', 'crumb_bait', 'fish']);
  assert.deepEqual(last.offers.map(offer => offer.itemId), ['starfall_rod', 'leviathan_hook', 'firefly_bait', 'fish_rudd']);
  state.fishing.ownedRods = spec.rods.map(item => item.id); state.fishing.ownedHooks = spec.hooks.map(item => item.id);
  assert.deepEqual(createFishingShop(state, now, () => 0).offers.map(offer => offer.kind), ['bait', 'fish']);
});

test('only the stored offer can be bought, stock decrements once, replay and concurrent stale commands never double spend', () => {
  const p = player(), initial = fund(p), offer = initial.fishingShop.offers.find(offer => offer.kind === 'bait');
  const wrong = command(p, initial, 'buy_fishing_item', offer.itemId, 1, offer.unitPrice);
  assert.throws(() => economy.commandDevEconomy(p.token, wrong, now), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
  const request = buy(p, initial, offer, 4), concurrent = { ...request, requestId: crypto.randomUUID() };
  const result = economy.commandDevEconomy(p.token, request, now);
  assert.equal(result.state.inventory[offer.itemId], 4); assert.deepEqual(result.state.fishing.catches, {});
  assert.equal(result.state.fishingShop.offers.find(item => item.id === offer.id).remaining, 1);
  assert.equal(result.state.wallet.coins, initial.wallet.coins - 4 * offer.unitPrice);
  assert.equal(economy.commandDevEconomy(p.token, request, now).replayed, true);
  assert.throws(() => economy.commandDevEconomy(p.token, concurrent, now), { code: 'ECONOMY_REVISION_CONFLICT' });
  const exhausted = buy(p, read(p), offer, 2), before = read(p);
  assert.throws(() => economy.commandDevEconomy(p.token, exhausted, now), { code: 'ECONOMY_FISHING_STOCK' });
  assert.deepEqual(read(p), before);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, quantity: 3 }, now), { code: 'ECONOMY_REQUEST_CONFLICT' });
});

test('paid refresh uses a bounded accepted pearl price and one durable receipt, invalidating every old offer', () => {
  const p = player(); fund(p); persisted(p).buildings.home = 5;
  persisted(p).fishingShop = createFishingShop(persisted(p), now, max => max - 1);
  const before = read(p), shop = before.fishingShop;
  const request = command(p, before, 'refresh_fishing_shop', shop.id, 1, shop.refreshPricePearls);
  const cheaper = { ...request, totalPrice: shop.refreshPricePearls - 1 };
  assert.throws(() => economy.commandDevEconomy(p.token, cheaper, now), { code: 'ECONOMY_FISHING_PRICE_CHANGED' });
  assert.deepEqual(read(p), before);
  const next = economy.commandDevEconomy(p.token, request, now + 1000).state;
  assert.equal(next.wallet.pearls, 900); assert.equal(next.wallet.coins, before.wallet.coins);
  assert.notEqual(next.fishingShop.id, shop.id);
  assert.ok(next.fishingShop.offers.every(offer => !shop.offers.some(old => old.itemId === offer.itemId)));
  assert.equal(next.fishingShop.offers.length, shop.offers.length);
  assert.equal(Date.parse(next.fishingShop.refreshAt), now + 1000 + 6 * 3600000);
  const replay = economy.commandDevEconomy(p.token, request, now + 2000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.fishingShop, next.fishingShop);
  assert.equal(replay.state.wallet.pearls, 900);
  assert.throws(() => economy.commandDevEconomy(p.token, buy(p, next, shop.offers[0]), now + 2000), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, requestId: crypto.randomUUID(), expectedRevision: next.revision }, now + 2000), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
});

test('expiry makes stale offers unusable and the first refresh GET creates exactly one free rotation', () => {
  const p = player(), before = fund(p), at = Date.parse(before.fishingShop.refreshAt);
  const request = buy(p, before, before.fishingShop.offers[0]);
  assert.throws(() => economy.commandDevEconomy(p.token, request, at), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
  assert.throws(() => economy.commandDevEconomy(p.token, command(p, before, 'refresh_fishing_shop', before.fishingShop.id, 1, 100), at), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
  const refreshed = read(p, at), again = read(p, at);
  assert.equal(refreshed.revision, before.revision + 1); assert.equal(again.revision, refreshed.revision);
  assert.deepEqual(refreshed.wallet, before.wallet); assert.deepEqual(refreshed.fishingShop, again.fishingShop);
  assert.notEqual(refreshed.fishingShop.id, before.fishingShop.id);
});

test('foreign owners, insufficient pearls, changed quotes and full storage cannot consume stock or produce receipts', () => {
  const p = player(), q = player(), before = fund(p), offer = before.fishingShop.offers.find(offer => offer.kind === 'bait');
  const request = buy(p, before, offer);
  assert.throws(() => economy.commandDevEconomy(q.token, request, now), { code: 'ECONOMY_OWNER_CHANGED' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, fishingShop: before.fishingShop }, now), { code: 'INVALID_ECONOMY_COMMAND' });
  persisted(p).inventory.wood = 200;
  assert.throws(() => economy.commandDevEconomy(p.token, request, now), { code: 'ECONOMY_STORAGE_FULL' });
  assert.deepEqual(read(p).fishingShop, before.fishingShop); assert.deepEqual(read(p).wallet, before.wallet);
  persisted(p).wallet.pearls = 0;
  assert.throws(() => economy.commandDevEconomy(p.token, command(p, read(p), 'refresh_fishing_shop', before.fishingShop.id, 1, 100), now), { code: 'ECONOMY_PEARLS' });
  assert.deepEqual(read(p).fishingShop, before.fishingShop);
  assert.equal(globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).receipts.size, 0);
});

test('a pre-rotation purchase receipt with the old catalog target replays without charging or requiring an active offer', () => {
  const p = player(), before = fund(p);
  const old = command(p, before, 'buy_fishing_item', 'river_rod', 1, 18000);
  const value = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  value.receipts.set(old.requestId, { signature: JSON.stringify([old.ownerPublicId, old.expectedRevision, old.action, old.targetId, old.quantity, old.totalPrice]),
    message: 'Удочка добавлена в коллекцию', acceptedRevision: 1 });
  value.revision = 1; value.state.wallet.coins -= 18000; value.state.fishing.ownedRods.push('river_rod');
  const paid = read(p);
  const replay = economy.commandDevEconomy(p.token, old, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, paid.wallet);
  assert.deepEqual(replay.state.fishingShop, paid.fishingShop);
  assert.deepEqual(replay.state.fishing.ownedRods, ['reed_rod', 'river_rod']);
});


test('new supplies always keep distinct categories and paid changes exclude even sold-out IDs', () => {
  const p = player(); fund(p); const state = persisted(p); state.buildings.home = 5;
  let seed = 1729;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  let replaced = 0;
  for (let index = 0; index < 1000; index++) {
    state.fishingShop = createFishingShop(state, now, random);
    const old = structuredClone(state.fishingShop);
    assert.deepEqual(old.offers.map(item => item.kind), ['rod', 'hook', 'bait', 'fish']);
    state.fishingShop.offers[0].remaining = 0;
    if (!canRefreshFishingShop(state)) {
      assert.equal(refreshFishingShop(state, now, () => { throw Error('must not draw'); }), null);
      continue;
    }
    const next = refreshFishingShop(state, now + index, random);
    assert.deepEqual(next.offers.map(item => item.kind), ['rod', 'hook', 'bait', 'fish']);
    assert.ok(next.offers.every(offer => !old.offers.some(previous => previous.itemId === offer.itemId)));
    replaced++;
  }
  assert.ok(replaced > 20, 'there are reachable paid changes without selling rarity guarantees');
});

test('shared Kotlin vectors keep category slots and fixed rare tickets with downward fallback', () => {
  const p = player(); fund(p); const state = persisted(p); state.buildings.home = 5;
  // Rare, rather than cheapest gear leaves guaranteed lower-tier replacements.
  state.fishingShop = createFishingShop(state, now, max => max === 10000 ? 6000 : 0);
  assert.deepEqual(state.fishingShop.offers.map(item => item.itemId), ['willow_rod', 'silver_hook', 'crumb_bait', 'fish']);
  assert.equal(canRefreshFishingShop(state), true);
  assert.deepEqual(refreshFishingShop(state, now, () => 0).offers.map(item => item.itemId),
    ['river_rod', 'barbed_hook', 'worm_bait', 'fish_silverfin']);
  const totals = [];
  assert.deepEqual(refreshFishingShop(state, now, max => { totals.push(max); return max - 1; }).offers.map(item => item.itemId),
    ['starfall_rod', 'leviathan_hook', 'firefly_bait', 'fish_rudd']);
  assert.deepEqual(totals, [10000, 1, 10000, 1, 95, 2]);
});

test('all 10000 tickets per home keep exact legendary odds even after collecting every lesser model', () => {
  const p = player(); fund(p); const state = persisted(p), spec = economyCatalog.fishing;
  const expected = [0, 0, 0, 400, 800];
  for (let home = 1; home <= 5; home++) {
    state.buildings.home = home;
    for (const exhausted of [false, true]) {
      state.fishing.ownedRods = spec.rods.filter(item => exhausted ? item.rarity !== 'legendary' : item.price === 0).map(item => item.id);
      state.fishing.ownedHooks = spec.hooks.filter(item => exhausted ? item.rarity !== 'legendary' : item.price === 0).map(item => item.id);
      let rods = 0, hooks = 0;
      for (let ticket = 0; ticket < 10000; ticket++) {
        const shop = createFishingShop(state, now, max => max === 10000 ? ticket : 0, '00000000-0000-4000-8000-000000000001');
        rods += shop.offers.some(item => item.itemId === 'starfall_rod');
        hooks += shop.offers.some(item => item.itemId === 'leviathan_hook');
        assert.ok(shop.offers.filter(item => item.kind === 'rod').length <= 1);
        assert.ok(shop.offers.filter(item => item.kind === 'hook').length <= 1);
      }
      assert.equal(rods, expected[home - 1]); assert.equal(hooks, expected[home - 1]);
    }
  }
});

test('excluding prior rare offers cannot redistribute tickets into epic or legendary gear', () => {
  const p = player(); fund(p); const state = persisted(p); state.buildings.home = 5;
  state.fishingShop = createFishingShop(state, now, max => max === 10000 ? 6000 : 0);
  const counts = { river_rod: 0, tide_rod: 0, starfall_rod: 0 };
  for (let ticket = 0; ticket < 10000; ticket++) {
    const next = refreshFishingShop(state, now, max => max === 10000 ? ticket : 0);
    counts[next.offers.find(item => item.kind === 'rod').itemId]++;
  }
  assert.deepEqual(counts, { river_rod: 7200, tide_rod: 2000, starfall_rod: 800 });
});

test('missing baseline replacement disables payment before draws and leaves natural replenishment free', () => {
  const p = player(); fund(p); const state = persisted(p);
  state.fishing.ownedRods.push('brook_rod'); state.fishing.ownedHooks.push('round_hook');
  state.fishingShop = createFishingShop(state, now, () => 0);
  const before = read(p);
  assert.equal(canRefreshFishingShop(state), false);
  assert.equal(refreshFishingShop(state, now, () => { throw Error('must not draw'); }), null);
  assert.throws(() => economy.commandDevEconomy(p.token,
    command(p, before, 'refresh_fishing_shop', before.fishingShop.id, 1, 100), now),
    { code: 'ECONOMY_FISHING_SHOP_NO_REPLACEMENT' });
  assert.deepEqual(read(p), before);
  assert.equal(globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).receipts.size, 0);
  const next = read(p, Date.parse(before.fishingShop.refreshAt));
  assert.notEqual(next.fishingShop.id, before.fishingShop.id);
  assert.deepEqual(next.wallet, before.wallet);
  state.buildings.home = 5;
  state.fishing.ownedRods = economyCatalog.fishing.rods.map(item => item.id);
  state.fishing.ownedHooks = economyCatalog.fishing.hooks.map(item => item.id);
  state.fishingShop = createFishingShop(state, now, () => 0);
  assert.equal(canRefreshFishingShop(state), true, 'a completed tackle collection can still replace bait and fish');
  assert.deepEqual(refreshFishingShop(state, now, () => 0).offers.map(item => item.kind), ['bait', 'fish']);
});

test('discount fish purchase has bounded stock, no collection unlock, no NPC arbitrage and durable replay', () => {
  const p = player(), before = fund(p), offer = before.fishingShop.offers.find(item => item.kind === 'fish');
  const fish = economyCatalog.fishing.fish.find(item => item.itemId === offer.itemId);
  assert.equal(fish.rarity, 'common');
  assert.equal(offer.unitPrice, Math.ceil(fish.buyPrice * 0.8));
  for (const entry of economyCatalog.fishing.fish.filter(item => item.rarity === 'common')) {
    const item = economyCatalog.items.find(item => item.id === entry.itemId);
    assert.ok(Math.ceil(entry.buyPrice * 0.8) > item.baseSellPrice);
  }
  const request = buy(p, before, offer, 3);
  const next = economy.commandDevEconomy(p.token, request, now).state;
  assert.equal(next.inventory[offer.itemId], (before.inventory[offer.itemId] ?? 0) + 3);
  assert.deepEqual(next.fishing.catches, before.fishing.catches);
  assert.deepEqual(next.progression, before.progression);
  assert.equal(next.fishingShop.offers.find(item => item.id === offer.id).remaining, 0);
  assert.equal(economy.commandDevEconomy(p.token, request, now).replayed, true);
  assert.throws(() => economy.commandDevEconomy(p.token, buy(p, next, offer), now), { code: 'ECONOMY_FISHING_STOCK' });
});

test('full storage rejects discounted fish atomically without spending coins or stock', () => {
  const p = player(); fund(p); persisted(p).inventory.wood = 200;
  const before = read(p), offer = before.fishingShop.offers.find(item => item.kind === 'fish');
  assert.throws(() => economy.commandDevEconomy(p.token, buy(p, before, offer), now), { code: 'ECONOMY_STORAGE_FULL' });
  assert.deepEqual(read(p), before);
});

test('invalid trusted random results cannot produce a shop', () => {
  const p = player(); fund(p);
  for (const random of [() => -1, max => max, () => NaN, () => 0.5]) {
    assert.throws(() => createFishingShop(persisted(p), now, random), /Invalid trusted shop draw/);
  }
});

test('ordinary paid offers really alternate within each category without a forced rarity promotion', () => {
  const p = player(); fund(p); const state = persisted(p);
  state.fishingShop = createFishingShop(state, now, () => 0);
  for (let i = 0; i < 10; i++) {
    const old = state.fishingShop;
    assert.equal(canRefreshFishingShop(state), true);
    const next = refreshFishingShop(state, now + i, () => 0);
    assert.deepEqual(next.offers.map(item => item.kind), ['rod', 'hook', 'bait', 'fish']);
    assert.ok(next.offers.every(item => !old.offers.some(previous => previous.itemId === item.itemId)));
    assert.ok(['river_rod', 'brook_rod'].includes(next.offers[0].itemId));
    state.fishingShop = next;
  }
});


test('refresh price falls by remaining time with exact steps cap and zero at expiry', () => {
  const p = player(); fund(p);
  const shop = read(p).fishingShop, end = Date.parse(shop.refreshAt);
  for (const [remaining, stored] of [[21600001, 100], [21600000, 100], [10800001, 52], [10800000, 50],
    [3600000, 18], [432001, 4], [432000, 2], [1, 2], [0, 0], [-1, 0]]) {
    assert.equal(fishingShopRefreshPrice(shop, end - remaining), stored);
  }
  assert.equal(fishingShopRefreshPrice({ ...shop, refreshPricePearls: 80 }, end - 10800000), 40, 'persisted full-period ceiling cannot be raised by a catalog change');
  let previous = 100;
  for (let elapsed = 0; elapsed <= 21600000; elapsed += 1000) {
    const price = fishingShopRefreshPrice(shop, now + elapsed);
    assert.ok(price <= previous && price >= 0 && price % 2 === 0); previous = price;
  }
});

test('delayed refresh charges the lower server quote once and a forged cheap quote cannot buy more time', () => {
  const p = player(); fund(p); persisted(p).buildings.home = 5;
  persisted(p).fishingShop = createFishingShop(persisted(p), now, max => max - 1);
  const before = read(p), shop = before.fishingShop, at = now + 3 * 3600000;
  const request = command(p, before, 'refresh_fishing_shop', shop.id, 1, 100);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, totalPrice: 48 }, at), { code: 'ECONOMY_FISHING_PRICE_CHANGED' });
  assert.equal(persisted(p).wallet.pearls, 1000);
  const result = economy.commandDevEconomy(p.token, request, at);
  assert.equal(result.state.wallet.pearls, 950);
  assert.equal(Date.parse(result.state.fishingShop.refreshAt), at + 6 * 3600000);
  const replay = economy.commandDevEconomy(p.token, request, at + 3600000);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.pearls, 950);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, requestId: crypto.randomUUID() }, at), { code: 'ECONOMY_REVISION_CONFLICT' });
});

test('the last paid shop step costs one visible pearl but natural restock cannot charge it', () => {
  for (const expired of [false, true]) {
    const p = player(); fund(p); persisted(p).buildings.home = 5;
    persisted(p).fishingShop = createFishingShop(persisted(p), now, max => max - 1);
    persisted(p).wallet.pearls = 2;
    const before = read(p), shop = before.fishingShop;
    const request = command(p, before, 'refresh_fishing_shop', shop.id, 1, 2);
    const end = Date.parse(shop.refreshAt);
    if (expired) {
      assert.throws(() => economy.commandDevEconomy(p.token, request, end), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
      assert.equal(read(p, end).wallet.pearls, 2);
    } else assert.equal(economy.commandDevEconomy(p.token, request, end - 1).state.wallet.pearls, 0);
  }
});
