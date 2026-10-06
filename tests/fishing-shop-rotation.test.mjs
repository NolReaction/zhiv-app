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
const { createFishingShop, refreshFishingShop, canRefreshFishingShop } = await vite.ssrLoadModule('/features/economy/fishing-shop.ts');
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
        const item = (offer.kind === 'rod' ? spec.rods : offer.kind === 'hook' ? spec.hooks : spec.baits)
          .find(item => (item.id ?? item.itemId) === offer.itemId);
        assert.ok(item.requiredHomeLevel <= home);
        assert.equal(offer.remaining, offer.kind === 'bait' ? 5 : 1);
      }
    }
  }
  const first = createFishingShop(state, now, () => 0, '00000000-0000-4000-8000-000000000001');
  const last = createFishingShop(state, now, max => max - 1, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(first.offers.map(offer => offer.itemId), ['river_rod', 'barbed_hook', 'crumb_bait', 'worm_bait']);
  assert.deepEqual(last.offers.map(offer => offer.itemId), ['starfall_rod', 'leviathan_hook', 'firefly_bait', 'glow_bait']);
  state.fishing.ownedRods = spec.rods.map(item => item.id); state.fishing.ownedHooks = spec.hooks.map(item => item.id);
  assert.deepEqual(createFishingShop(state, now, () => 0).offers.map(offer => offer.kind), ['bait', 'bait', 'bait', 'bait']);
});

test('only the stored offer can be bought, stock decrements once, replay and concurrent stale commands never double spend', () => {
  const p = player(), initial = fund(p), offer = initial.fishingShop.offers.find(offer => offer.itemId === 'worm_bait');
  const wrong = command(p, initial, 'buy_fishing_item', offer.itemId, 1, offer.unitPrice);
  assert.throws(() => economy.commandDevEconomy(p.token, wrong, now), { code: 'ECONOMY_FISHING_SHOP_CHANGED' });
  const request = buy(p, initial, offer, 4), concurrent = { ...request, requestId: crypto.randomUUID() };
  const result = economy.commandDevEconomy(p.token, request, now);
  assert.equal(result.state.inventory.worm_bait, 4); assert.deepEqual(result.state.fishing.catches, {});
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


test('paid replacement excludes every prior item including sold-out stock across repeated refreshes', () => {
  const p = player(); fund(p);
  const state = persisted(p); state.buildings.home = 5;
  state.fishingShop = createFishingShop(state, now, () => 0);
  let seed = 1729;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let index = 0; index < 200; index++) {
    const old = structuredClone(state.fishingShop);
    state.fishingShop.offers[0].remaining = 0;
    assert.equal(canRefreshFishingShop(state), true);
    const next = refreshFishingShop(state, now + index, random);
    assert.equal(next.offers.length, old.offers.length);
    assert.equal(new Set(next.offers.map(offer => offer.itemId)).size, next.offers.length);
    assert.ok(next.offers.every(offer => !old.offers.some(previous => previous.itemId === offer.itemId)));
    state.fishingShop = next;
  }
});

test('replacement shares weighted deterministic vectors with Kotlin without guaranteed rod or hook slots', () => {
  const p = player(); fund(p);
  const state = persisted(p); state.buildings.home = 5;
  state.fishingShop = createFishingShop(state, now, () => 0);
  assert.deepEqual(refreshFishingShop(state, now, () => 0).offers.map(offer => offer.itemId),
    ['willow_rod', 'tide_rod', 'starfall_rod', 'silver_hook']);
  assert.deepEqual(refreshFishingShop(state, now, max => max - 1).offers.map(offer => offer.itemId),
    ['firefly_bait', 'glow_bait', 'leviathan_hook', 'tide_hook']);
  // Every item remains selected by its original rarity weight, not a guaranteed category slot.
  const totals = [];
  refreshFishingShop(state, now, max => { totals.push(max); return max - 1; });
  assert.deepEqual(totals, [113, 103, 78, 74]);
});

test('insufficient replacement stock never draws or charges and natural replenishment remains free', () => {
  const p = player(), before = fund(p);
  assert.equal(canRefreshFishingShop(persisted(p)), false);
  assert.equal(refreshFishingShop(persisted(p), now, () => { throw Error('must not draw'); }), null);
  assert.throws(() => economy.commandDevEconomy(p.token,
    command(p, before, 'refresh_fishing_shop', before.fishingShop.id, 1, 100), now),
    { code: 'ECONOMY_FISHING_SHOP_NO_REPLACEMENT' });
  assert.deepEqual(read(p), before);
  assert.equal(globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).receipts.size, 0);
  const next = read(p, Date.parse(before.fishingShop.refreshAt));
  assert.notEqual(next.fishingShop.id, before.fishingShop.id);
  assert.deepEqual(next.wallet, before.wallet);
  assert.equal(next.fishingShop.offers.length, 4);
});

test('owning tackle cannot exhaust the weighted choice to guarantee the remaining legendary stock', () => {
  const p = player(); fund(p);
  const state = persisted(p); state.buildings.home = 5;
  state.fishingShop = createFishingShop(state, now, () => 0);
  state.fishing.ownedRods.push('willow_rod', 'tide_rod');
  state.fishing.ownedHooks.push('silver_hook');
  // Five alternatives with two legendaries would force at least one in four slots.
  assert.equal(canRefreshFishingShop(state), false);
  assert.equal(refreshFishingShop(state, now, () => { throw Error('must not draw'); }), null);
  state.fishing.ownedHooks.push('tide_hook');
  // Exactly four alternatives remain, so charging would force all four, including both legendaries.
  assert.equal(canRefreshFishingShop(state), false);
  assert.equal(refreshFishingShop(state, now, () => { throw Error('must not draw'); }), null);
  state.fishing.ownedRods = economyCatalog.fishing.rods.map(item => item.id);
  state.fishing.ownedHooks = economyCatalog.fishing.hooks.map(item => item.id);
  state.fishingShop = createFishingShop(state, now, () => 0);
  assert.equal(canRefreshFishingShop(state), false, 'a bait-only counter has no new stock to sell for pearls');
});
