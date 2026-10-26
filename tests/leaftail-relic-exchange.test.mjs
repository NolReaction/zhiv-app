import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog, ECONOMY_MAX_ITEMS: maxItems } = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const { newEconomyState, applyEconomyCommand, economyStorage } = await vite.ssrLoadModule('/features/economy/domain/rules.ts');
const { leaftailRelicExchangeOffer: offer, leaftailRelicExchangeItems: items } = await vite.ssrLoadModule('/features/economy/domain/leaftail-relic-exchange.ts');
const { inventoryGainFromReceipt } = await vite.ssrLoadModule('/features/economy/domain/inventory-gain.ts');
const identities = await vite.ssrLoadModule('/lib/dev/api-store.ts');
const economy = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
const now = Date.parse('2026-10-26T12:00:00Z');
const fee = catalog.leaftailShop.relicExchange.priceCoins;
const relics = ['ancient_core', 'moon_crystal', 'living_resin'];
const initial = () => ({ ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 }),
  wallet: { coins: 100_000, pearls: 300 }, inventory: { moon_crystal: 4 },
  rareDropState: { version: 1, remainingSeconds: 9000, itemId: 'living_resin' },
  minerRareDropState: { version: 1, remainingSeconds: 12000, itemId: 'ancient_core' } });
const command = (extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: 'ABCD-EFGH-JKMP', expectedRevision: 0,
  action: 'exchange_leaftail_relic', targetId: 'moon_crystal:ancient_core', quantity: 1, totalPrice: fee, ...extra });
const apply = (state, request = command(), reserved = {}) => applyEconomyCommand(state, request, now, () => assert.fail('Exchange cannot create jobs'), reserved, () => assert.fail('Exchange cannot draw randomness'));
const unchangedFailure = (state, request, code, reserved = {}) => {
  const before = structuredClone(state); assert.throws(() => apply(state, request, reserved), { code }); assert.deepEqual(state, before);
};
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });

test('all six relic pairs cost two copies and 20000 coins, preserving free drop clocks and permanent progress', () => {
  assert.deepEqual(items(), relics);
  assert.equal(fee, 20_000);
  for (const from of relics) for (const to of relics.filter(id => id !== from)) {
    const state = initial(); state.inventory = { [from]: 2 }; const before = structuredClone(state);
    assert.equal(apply(state, command({ targetId: `${from}:${to}` })), 'Реликвии обменены. Находка отправлена в кладовую');
    assert.deepEqual(state.inventory, { [to]: 1 }); assert.equal(state.wallet.coins, before.wallet.coins - fee);
    assert.equal(state.wallet.pearls, before.wallet.pearls);
    for (const key of ['rareDropState', 'minerRareDropState', 'jobs', 'progression', 'completedExplorations', 'tradeRelations', 'leaftailShop'])
      assert.deepEqual(state[key], before[key], key);
  }
});

test('the offer is readonly, follows confirmed home level, and never treats unrelated items as relics', () => {
  const state = initial(), before = structuredClone(state), result = offer(state, 'moon_crystal', 'ancient_core');
  assert.equal(result.unlocked, true); assert.equal(result.canAfford, true); assert.equal(result.quantity, 2);
  assert.equal(result.availableQuantity, 4); assert.equal(result.requiredHomeLevel, 4); assert.deepEqual(state, before);
  state.buildings.home = 3;
  state.jobs = [{ id: 'home-upgrade', kind: 'construction', targetId: 'home', level: 4, quantity: 1, rewards: {}, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 1000).toISOString() }];
  assert.equal(offer(state, 'moon_crystal', 'ancient_core').unlocked, false);
  unchangedFailure(state, command(), 'ECONOMY_HOME_REQUIRED');
  for (const id of ['wood', 'fish', 'leaf_cap', 'pearls', 'missing']) assert.equal(offer(initial(), id, 'ancient_core'), null);
});

test('pending private rewards and their frozen price and speed survive exchange unchanged', () => {
  const state = initial();
  state.jobs = [{ id: crypto.randomUUID(), kind: 'exploration', targetId: 'quarry', actorId: 'miner',
    recipeId: null, targetLevel: null, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 90_000).toISOString(),
    rewards: { ancient_core: 1, stone: 4 }, cost: { coins: 123, items: { wood: 2 } }, catalogVersion: 14, tradeSpeedBps: 700,
    rareDrop: { version: 1, seconds: 90, itemId: 'ancient_core' }, expeditionFinds: { moon_crystal: 1 } }];
  state.tradeRelations.reputation = { miner: 1600 }; state.tradeRelations.activity = { miner: { pointsBps: 7500, updatedAt: '2026-10-16T12:00:00Z' } };
  const before = structuredClone(state); apply(state);
  assert.deepEqual(state.jobs, before.jobs); assert.deepEqual(state.tradeRelations, before.tradeRelations);
  assert.deepEqual(state.progression, before.progression); assert.deepEqual(state.rareDropState, before.rareDropState);
});

test('invalid pair, quantity, fish selection, changed quote and insufficient resources never debit anything', () => {
  for (const targetId of ['moon_crystal:moon_crystal', 'wood:ancient_core', 'moon_crystal:wood', 'moon_crystal', 'moon_crystal:ancient_core:living_resin', ':ancient_core', 'moon_crystal:'])
    unchangedFailure(initial(), command({ targetId }), 'INVALID_ECONOMY_COMMAND');
  for (const quantity of [0, 2, 100]) unchangedFailure(initial(), command({ quantity }), 'INVALID_ECONOMY_COMMAND');
  unchangedFailure(initial(), command({ fishSelection: { fish_common: 1 } }), 'INVALID_ECONOMY_COMMAND');
  for (const totalPrice of [0, fee - 1, fee + 1]) unchangedFailure(initial(), command({ totalPrice }), 'ECONOMY_LEAFTAIL_PRICE_CHANGED');
  unchangedFailure({ ...initial(), wallet: { coins: fee - 1, pearls: 100000 } }, command(), 'ECONOMY_RESOURCES');
  unchangedFailure({ ...initial(), inventory: { moon_crystal: 1 } }, command(), 'ECONOMY_RESOURCES', { moon_crystal: 100 });
});

test('exchange frees one place even in existing overflow, but validates target cap including market escrow before debit', () => {
  for (const extra of [0, 1]) {
    const state = initial(); state.inventory.wood = economyStorage(state).capacity - 4 + extra;
    const before = economyStorage(state); apply(state);
    assert.equal(economyStorage(state).used, before.used - 1);
  }
  const saturated = { ...initial(), inventory: { moon_crystal: 2, ancient_core: maxItems } };
  unchangedFailure(saturated, command(), 'ECONOMY_CAPACITY');
  unchangedFailure({ ...initial(), inventory: { moon_crystal: 2, ancient_core: maxItems - 1 } }, command(), 'ECONOMY_CAPACITY', { ancient_core: 1 });
  const escrow = initial(); apply(escrow, command(), { stone: 50 }); assert.equal(escrow.inventory.ancient_core, 1);
});

test('round trips consume three relics and 60000 coins with no daily cooldown or payout loop', () => {
  const state = initial(); apply(state); apply(state); apply(state, command({ targetId: 'ancient_core:moon_crystal' }));
  assert.deepEqual(state.inventory, { moon_crystal: 1 }); assert.equal(state.wallet.coins, 40_000);
  assert.equal(state.tradeRelations.reputation?.leaftail ?? 0, 0);
});

test('DEV persists one receipt and confirmed inventory gain, fences owner and signature, and replays without second debit', () => {
  const p = identities.createDevIdentity('Обмен реликвий', crypto.randomUUID());
  economy.getDevEconomy(p.token, now);
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state = initial();
  const before = economy.getDevEconomy(p.token, now);
  const request = command({ ownerPublicId: before.ownerPublicId, expectedRevision: before.revision });
  const stranger = identities.createDevIdentity('Другой игрок', crypto.randomUUID()); economy.getDevEconomy(stranger.token, now);
  assert.throws(() => economy.commandDevEconomy(stranger.token, request, now), { code: 'ECONOMY_OWNER_CHANGED' });
  const done = economy.commandDevEconomy(p.token, request, now);
  assert.equal(done.state.wallet.coins, 80_000); assert.equal(done.acceptedRevision, before.revision + 1);
  assert.deepEqual(inventoryGainFromReceipt(before, done, request).items, [{ itemId: 'ancient_core', quantity: 1 }]);
  assert.equal(inventoryGainFromReceipt(done.state, done, request), null);
  assert.equal(inventoryGainFromReceipt(before, { ...done, state: { ...done.state, wallet: before.wallet } }, request), null);
  const replay = economy.commandDevEconomy(p.token, request, now + 1);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, done.state.wallet); assert.deepEqual(replay.state.inventory, done.state.inventory);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, targetId: 'moon_crystal:living_resin' }, now), { code: 'ECONOMY_REQUEST_CONFLICT' });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, requestId: crypto.randomUUID() }, now), { code: 'ECONOMY_REVISION_CONFLICT' });
});
