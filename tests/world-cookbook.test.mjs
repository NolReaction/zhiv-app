import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: false, appType: 'custom', root, cacheDir: `/tmp/cookbook-tests-${process.pid}`, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const { WorldObjectMenu } = await vite.ssrLoadModule('/features/economy/ui/stations/world-object-menu.tsx');
const { CookbookPot } = await vite.ssrLoadModule('/features/economy/ui/food/cookbook-pot.tsx');
const { cookbookProducts, cookbookFishRarity } = await vite.ssrLoadModule('/features/economy/ui/food/cookbook-recipes.ts');
const now = Date.parse('2026-11-01T12:00:00Z');
const recipes = economyCatalog.recipes.filter(recipe => !recipe.retired && recipe.buildingId === 'dryer');
function snapshot(extra = {}) { return { ownerPublicId: 'ME', revision: 3, catalog: economyCatalog, buildings: { home: 5, dryer: 5, warehouse: 5, garden: 5, workshop: 5, kiln: 5, woodlot: 5, quarry: 5 }, inventory: { berries: 8, fish_common: 3, charcoal: 2 }, familiarItems: economyCatalog.items.map(item => item.id), wallet: { coins: 50000, pearls: 1000 }, fishing: economyFishingSchema.parse({ stock: { fish: 1, fish_silverfin: 2 } }), progression: { recipes: {}, routes: {} }, jobs: [], storage: { capacity: 1000, used: 13, available: 987, reserved: 0, overflow: 0 }, ...extra }; }
function render(state, initialRecipeId, extra = {}) { return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place: 'campfire', objectId: 'campfire', x: 140, y: 200, viewportWidth: 320, viewportHeight: 500 }, economy: { snapshot: state, now, busy: false, uncertain: false, retryAt: 0, error: null, act() { assert.fail('Reading the cookbook must never issue a command'); } }, onClose() {}, initialRecipeId, ...extra })); }
function job(extra = {}) { return { id: 'cooking', kind: 'production', targetId: 'dryer', recipeId: 'cook_compote', startedAt: new Date(now - 10000).toISOString(), finishesAt: new Date(now + 120000).toISOString(), rewards: { berry_compote: 1 }, cost: { coins: 0, items: { berries: 2 } }, catalogVersion: economyCatalog.version, ...extra }; }

test('book categories contain every product exactly once and group named fish by their actual ingredient rarity', () => {
  const state = snapshot(), before = structuredClone(state), products = cookbookProducts(state, recipes);
  assert.equal(products.length, new Set(products.map(product => product.key)).size);
  for (const recipe of recipes.filter(recipe => !recipe.experiment)) assert.ok(products.some(product => product.methods.some(method => method.id === recipe.id)));
  for (const recipe of recipes.filter(recipe => recipe.experiment)) assert.equal(products.some(product => product.methods.some(method => method.id === recipe.id)), false);
  assert.equal(cookbookFishRarity(state, recipes.find(recipe => recipe.id === 'cook_grilled_silverfin')), 'common');
  assert.equal(cookbookFishRarity(state, recipes.find(recipe => recipe.id === 'cook_hearty_fish')), 'rare');
  assert.equal(cookbookFishRarity(state, recipes.find(recipe => recipe.id === 'cook_compote')), null);
  assert.deepEqual(state, before);
});

test('standalone book opens a read-only recipe list, with only one category and no production queue consuming the screen', () => {
  const html = render(snapshot());
  assert.match(html, /aria-modal="true"/); assert.match(html, /Книга рецептов/); assert.match(html, /data-cookbook-view="recipes"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 5);
  assert.match(html, /data-cookbook-rarity="common"/); assert.match(html, /data-cookbook-rarity="legendary"/);
  assert.doesNotMatch(html, /data-production-slots=|data-recipe-order|data-cooking-duration=/);
  assert.match(html, /data-cookbook-queue/); assert.match(html, /Найти рецепт/); assert.match(html, /Есть ингредиенты/);
});

test('source navigation opens its recipe despite active jobs and shows class versus exact species without changing costs', () => {
  const state = snapshot({ jobs: [job()] }), before = structuredClone(state);
  const exact = render(state, 'cook_grilled_silverfin');
  assert.match(exact, /data-cookbook-view="detail"/); assert.match(exact, /data-recipe="cook_grilled_silverfin"/);
  assert.match(exact, /Нужен именно этот вид рыбы/); assert.match(exact, /data-item-icon="fish_silverfin"/);
  assert.doesNotMatch(exact, /data-production-slots=/); assert.match(exact, /data-cookbook-pot="cooking"/);
  const ordinary = render(state, 'cook_grilled_fish');
  assert.match(ordinary, /Подойдёт любая рыба этого класса/); assert.match(ordinary, /data-item-icon="fish_common"/);
  assert.deepEqual(state, before);
});

test('confirmed running work opens queue, finished and pending jobs never animate the pot', () => {
  const running = render(snapshot({ jobs: [job()] }));
  assert.match(running, /data-cookbook-view="queue"/); assert.match(running, /data-production-slot="1" data-state="working"/); assert.match(running, /data-cookbook-pot="cooking"/);
  const ready = render(snapshot({ jobs: [job({ finishesAt: new Date(now).toISOString() })] }));
  assert.match(ready, /data-state="ready"/); assert.match(ready, /data-cookbook-pot="idle"/); assert.match(ready, /Забрать/);
  for (const extra of [{ jobs: [job({ startedAt: 'invalid' })] }, { jobs: [job()] }]) {
    const html = renderToStaticMarkup(createElement(CookbookPot, { economy: { snapshot: snapshot(extra), now, pendingProductionIds: ['cooking'] } }));
    assert.match(html, /data-cookbook-pot="idle"/);
  }
});

test('a learned recipe remains inspectable below its current building requirement', () => {
  const html = render(snapshot({ buildings: { home: 1, dryer: 0, warehouse: 1 }, progression: { recipes: { cook_compote: 1 }, routes: {} } }), 'cook_compote');
  assert.match(html, /data-cookbook-view="detail"/); assert.match(html, /Доступно с 1 уровня костра/);
  assert.match(html, /data-guide-station-upgrade="dryer"/); assert.match(html, /data-recipe="cook_compote"[^>]*data-blocked="true"/);
});

test('diversity and cooking totals come from confirmed recipe receipts and show the supplied achievements entry', () => {
  const state = snapshot({ jobs: [job()], progression: { recipes: { cook_grilled_fish: 4, cook_compote: 3 }, routes: {} } });
  const html = render(state, undefined, { achievements: createElement('button', { 'data-kitchen-achievements': true }, 'Достижения') });
  assert.match(html.replace(/<!--.*?-->/g, ''), /Знакомо рецептов: \d+ · освоено 2/); assert.match(html, /приготовлено 7/); assert.match(html, /data-kitchen-achievements/);
});

test('undiscovered experiments expose their clue and exact wager without revealing the dish before collection', () => {
  for (const recipe of recipes.filter(recipe => recipe.experiment)) {
    const level = economyCatalog.skills.levels[recipe.experiment.requiredCookingLevel - 1];
    const state = snapshot({ progression: { recipes: {}, routes: {}, skills: { cookingSeconds: level.requiredSeconds } } });
    const before = structuredClone(state), output = Object.keys(recipe.rewards)[0];
    const name = state.catalog.items.find(item => item.id === output).name;
    const html = render(state, recipe.id);
    assert.match(html, /data-experiment-terms/); assert.ok(html.includes(`Успех ${(recipe.experiment.successBps + level.cookingBonusBps) / 100}%`));
    assert.ok(html.includes(recipe.experiment.title)); assert.ok(html.includes(recipe.experiment.hint));
    assert.match(html, /Ингредиенты будут потрачены в любом случае/); assert.match(html, /При неудаче блюдо не получится/);
    assert.ok(!html.includes(name), name); assert.ok(!html.includes(`data-item-icon="${output}"`));
    const running = render(snapshot({ jobs: [job({ recipeId: recipe.id, rewards: recipe.rewards, cooking: { successChanceBps: 8500, workSeconds: recipe.seconds } })] }));
    assert.match(running, /Кулинарный опыт/); assert.ok(!running.includes(name));
    const discovered = snapshot({ progression: { recipes: { [recipe.id]: 1 }, routes: {} } });
    assert.ok(render(discovered, recipe.id).includes(name));
    assert.ok(cookbookProducts(discovered, recipes).some(product => product.recipe.id === recipe.id));
    assert.deepEqual(state, before);
  }
});

test('cooking skill gates experiments and improves the displayed chance without affecting guaranteed recipes', () => {
  const recipe = recipes.find(recipe => recipe.experiment?.requiredCookingLevel > 1);
  assert.ok(recipe);
  const unskilled = render(snapshot(), recipe.id);
  assert.doesNotMatch(unskilled, /data-experiment-terms/);
  assert.ok(!unskilled.includes(`data-recipe="${recipe.id}"`), 'the direct focus cannot expose an experiment before its cooking level');
  const skilled = snapshot({ progression: { recipes: {}, routes: {}, skills: { version: 1, cookingSeconds: economyCatalog.skills.levels.at(-1).requiredSeconds, travelSeconds: 0 } } });
  assert.match(render(skilled, recipe.id), /Успех 95%/);
  assert.doesNotMatch(render(skilled, 'cook_grilled_fish'), /data-experiment-terms/);
});
