import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule('/lib/dev/api-store.ts');
const economy = await vite.ssrLoadModule('/lib/dev/economy-store.ts');
const model = await vite.ssrLoadModule('/features/economy/model.ts');
const rare = await vite.ssrLoadModule('/features/economy/rare-drops.ts');
const rules = await vite.ssrLoadModule('/features/economy/rules.ts');
after(() => vite.close());
beforeEach(() => identities.resetDevStoreForTests());
const now = Date.parse('2026-10-05T20:00:00Z'), spec = model.economyCatalog.rareDrops;
const player = (home = 3) => { const p = identities.createDevIdentity('Путешественник', crypto.randomUUID()); economy.getDevEconomy(p.token, now); saved(p).buildings.home = home; return p; };
const saved = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const request = (p, action, targetId, at = now, extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, request(p, action, targetId, at), at);
const clock = (seconds, itemId = 'living_resin') => ({ version: 1, remainingSeconds: seconds, itemId });

test('three special materials are barter-only stacks used by later homes, never ordinary coin goods', () => {
  assert.deepEqual(model.economyCatalog.items.filter(item => item.category === 'special').map(item => item.id).sort(), [...spec.itemIds].sort());
  const home = model.economyCatalog.buildings.find(building => building.id === 'home');
  for (const level of home.levels.filter(level => level.level <= 3)) assert.ok(spec.itemIds.every(id => !level.cost.items[id]));
  assert.equal(home.levels.find(level => level.level === 4).cost.items.living_resin, 1);
  assert.equal(home.levels.find(level => level.level === 5).cost.items.ancient_core, 1);
  assert.equal(home.levels.find(level => level.level === 5).cost.items.moon_crystal, 1);
  const p = player(); saved(p).inventory = Object.fromEntries(spec.itemIds.map(id => [id, 2]));
  assert.equal(read(p).storage.used, 6);
  for (const id of spec.itemIds) {
    assert.throws(() => issue(p, 'sell', id), { code: 'ECONOMY_ITEM' });
    assert.throws(() => issue(p, 'buy_fishing_item', id), { code: 'ECONOMY_FISHING_ITEM' });
  }
});

test('server interval bounds and type draws are independent and have the documented 96-hour mean', () => {
  let values = [0, 0];
  assert.deepEqual(rare.prepareRareDrop(null, 1800, spec, () => values.shift()).clock, clock(spec.minSeconds, spec.itemIds[0]));
  values = [spec.maxSeconds - spec.minSeconds, 2];
  assert.deepEqual(rare.prepareRareDrop(null, 1800, spec, () => values.shift()).clock, clock(spec.maxSeconds, spec.itemIds[2]));
  assert.equal((spec.minSeconds + spec.maxSeconds) / 7200, 96);
  assert.throws(() => rare.prepareRareDrop(null, spec.minSeconds, spec));
});

test('request DTO cannot accept rewards private clock or a client random source', () => {
  const p = player(), command = request(p, 'start_exploration', 'forest');
  for (const field of ['rareDrop', 'rareDropState', 'rewards', 'rareRandom'])
    assert.equal(model.economyCommandSchema.safeParse({ ...command, [field]: 0 }).success, false);
});

test('home one and two do not initialize or accumulate the private clock; production never advances it', () => {
  for (const home of [1, 2]) {
    const p = player(home), job = issue(p, 'start_exploration', 'forest_camp').state.jobs[0];
    assert.equal(job.rareDrop, undefined); assert.equal(saved(p).rareDropState, undefined);
    issue(p, 'claim_job', job.id, Date.parse(job.finishesAt));
    assert.equal(saved(p).rareDropState, undefined);
  }
  const p = player(); saved(p).rareDropState = clock(12_345); saved(p).buildings.woodlot = 1;
  const recipe = model.economyCatalog.recipes.find(recipe => recipe.buildingId === 'woodlot');
  const job = issue(p, 'start_production', recipe.id).state.jobs[0];
  assert.equal(job.rareDrop, undefined);
  issue(p, 'claim_job', job.id, Date.parse(job.finishesAt));
  assert.deepEqual(saved(p).rareDropState, clock(12_345));
});

test('private state never appears in views and cancelling repeated starts or changing routes cannot reroll it', () => {
  const p = player();
  const first = issue(p, 'start_exploration', 'forest_camp').state;
  assert.equal(first.rareDropState, undefined);
  const fixed = structuredClone(saved(p).rareDropState);
  assert.ok(fixed.remainingSeconds >= spec.minSeconds && fixed.remainingSeconds <= spec.maxSeconds);
  issue(p, 'cancel_exploration', first.jobs[0].id);
  for (const route of ['forest', 'shore', 'forest_camp']) {
    const job = issue(p, 'start_exploration', route).state.jobs[0];
    assert.deepEqual(saved(p).rareDropState, fixed); assert.equal(job.rareDrop.itemId, null);
    issue(p, 'cancel_exploration', job.id);
  }
  assert.equal(economy.getDevEconomyAchievementState(p.me.user.publicId).rareDropState, undefined);
});

test('eight-hour preview cannot be rerolled by completing a cheap half-hour trip', () => {
  const p = player(); saved(p).rareDropState = clock(9 * 3600);
  const preview = issue(p, 'start_exploration', 'forest_camp').state.jobs[0];
  assert.equal(preview.rareDrop.itemId, null); issue(p, 'cancel_exploration', preview.id);
  const short = issue(p, 'start_exploration', 'forest').state.jobs[0];
  const end = Date.parse(short.finishesAt); issue(p, 'claim_job', short.id, end);
  assert.deepEqual(saved(p).rareDropState, clock(8.5 * 3600));
  const again = issue(p, 'start_exploration', 'forest_camp', end).state.jobs[0];
  assert.equal(again.rareDrop.itemId, null);
});

test('saved rare delivery is credited once, late collection adds no time, and overflow blocks both clock and reward', () => {
  const p = player(); saved(p).rareDropState = clock(900, 'ancient_core');
  const startRequest = request(p, 'start_exploration', 'forest');
  const started = economy.commandDevEconomy(p.token, startRequest, now), job = started.state.jobs[0];
  assert.equal(job.rewards.ancient_core, 1); assert.equal(job.rareDrop.itemId, 'ancient_core');
  assert.deepEqual(economy.commandDevEconomy(p.token, startRequest, now).state.jobs, started.state.jobs);
  const end = Date.parse(job.finishesAt) + 7 * 86400000;
  saved(p).inventory = { wood: 200 };
  assert.throws(() => issue(p, 'claim_job', job.id, end), { code: 'ECONOMY_STORAGE_FULL' });
  assert.deepEqual(saved(p).rareDropState, clock(900, 'ancient_core'));
  saved(p).inventory = {};
  const claim = request(p, 'claim_job', job.id, end), first = economy.commandDevEconomy(p.token, claim, end);
  const nextClock = structuredClone(saved(p).rareDropState);
  assert.equal(first.state.inventory.ancient_core, 1);
  assert.ok(nextClock.remainingSeconds >= spec.minSeconds - 900 && nextClock.remainingSeconds <= spec.maxSeconds - 900);
  assert.equal(economy.commandDevEconomy(p.token, claim, end + 1000).replayed, true);
  assert.equal(read(p).inventory.ancient_core, 1); assert.deepEqual(saved(p).rareDropState, nextClock);
});

test('long and short trips deliver the same materials and next countdown for equal completed hours', () => {
  function complete(parts) {
    let current = clock(10 * 3600), finds = 0;
    for (const seconds of parts) {
      const next = rare.prepareRareDrop(current, seconds, spec, () => 0);
      finds += Object.values(next.rewards).reduce((a, b) => a + b, 0);
      current = rare.settleRareDrop(current, next.delivery, spec, () => 0);
    }
    return { current, finds };
  }
  assert.deepEqual(complete(Array(96).fill(1800)), complete(Array(6).fill(28800)));
  assert.equal(complete(Array(6).fill(28800)).finds, 1);
});

test('old jobs without a delivery marker finish unchanged and cannot earn retroactive rare progress', () => {
  const p = player(), state = saved(p); state.rareDropState = clock(100);
  state.jobs = [{ id: crypto.randomUUID(), kind: 'exploration', targetId: 'forest', recipeId: null, targetLevel: null,
    startedAt: new Date(now - 1800000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: { wood: 2 }, cost: { coins: 0, items: {} }, catalogVersion: 1 }];
  const parsed = model.economyJobSchema.parse(state.jobs[0]); assert.equal(parsed.rareDrop, undefined);
  issue(p, 'claim_job', parsed.id);
  assert.deepEqual(saved(p).rareDropState, clock(100)); assert.equal(read(p).inventory.living_resin, undefined);
});

test('merging retains the farther existing clock without adding hours, selecting a new type or generating entropy', () => {
  const far = clock(400000, 'moon_crystal'), near = clock(500, 'living_resin');
  assert.deepEqual(rare.mergeRareDropClocks(near, far), far);
  assert.deepEqual(rare.mergeRareDropClocks(far, near), far);
  assert.deepEqual(rare.mergeRareDropClocks(null, far), far);
  assert.deepEqual(rare.mergeRareDropClocks(far, null), far);
  assert.equal(rare.mergeRareDropClocks(null, null), null);
});

test('later house upgrades consume the required special stack and older paid construction needs no new charge', () => {
  const home = model.economyCatalog.buildings.find(building => building.id === 'home'), target = home.levels.find(level => level.level === 4);
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 0 });
  state.wallet.coins = target.cost.coins; state.inventory = { ...target.cost.items }; delete state.inventory.living_resin;
  Object.assign(state.buildings, target.requiredBuildings);
  const command = { action: 'start_construction', targetId: 'home', quantity: 1, totalPrice: 0 };
  assert.throws(() => rules.applyEconomyCommand(structuredClone(state), command, now, () => crypto.randomUUID()), { code: 'ECONOMY_RESOURCES' });
  state.inventory.living_resin = 1;
  rules.applyEconomyCommand(state, command, now, () => crypto.randomUUID());
  assert.equal(state.inventory.living_resin, undefined);
  const paid = state.jobs[0]; delete paid.cost.items.living_resin;
  rules.applyEconomyCommand(state, { action: 'claim_job', targetId: paid.id, quantity: 1, totalPrice: 0 }, Date.parse(paid.finishesAt), () => crypto.randomUUID());
  assert.equal(state.buildings.home, 4);
});
