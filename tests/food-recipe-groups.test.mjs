import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, cacheDir: `/tmp/zhiv-simple-food-groups-${process.pid}`, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const { recipeFishGroupLabel } = await vite.ssrLoadModule('/features/economy/ui/food/food-recipe-labels.ts');
const { WorldProductionCard } = await vite.ssrLoadModule('/features/economy/ui/production/world-production-card.tsx');

test('ordinary meals name exact classes while the six species dishes name their actual catch', () => {
  const hearty = economyCatalog.recipes.find(recipe => recipe.id === 'cook_hearty_fish');
  assert.equal(recipeFishGroupLabel(hearty, economyCatalog), 'Редкая рыба');
  assert.equal(recipeFishGroupLabel(economyCatalog.recipes.find(recipe => recipe.id === 'cook_epic_fish'), economyCatalog), 'Эпическая рыба');
  assert.equal(recipeFishGroupLabel(economyCatalog.recipes.find(recipe => recipe.id === 'cook_legendary_fish'), economyCatalog), 'Легендарная рыба');
  for (const id of ['cook_hearty_fish', 'cook_epic_fish', 'cook_legendary_fish'])
    assert.equal(economyCatalog.recipes.find(recipe => recipe.id === id).fishInput, undefined);
  const speciesRecipes = economyCatalog.recipes.filter(recipe => recipe.fishInput?.exactSpecies);
  assert.equal(speciesRecipes.length, 6);
  assert.equal(economyCatalog.food.meals.length, 17);
  for (const recipe of speciesRecipes) {
    const names = recipe.fishInput.itemIds.map(id => economyCatalog.items.find(item => item.id === id).name);
    assert.equal(recipeFishGroupLabel(recipe, economyCatalog), names.join(' + '));
    assert.ok(recipe.fishInput.itemIds.every(id => recipe.cost.items[id] > 0));
  }
});

test('rare recipe preview shows exact class and both bonuses without substituting a more valuable class', () => {
  const recipe = economyCatalog.recipes.find(entry => entry.id === 'cook_hearty_fish');
  const forbidden = () => assert.fail('Reading a recipe may not spend or choose fish');
  const state = { ownerPublicId: 'TEST-0000-0001', revision: 1, catalog: economyCatalog, inventory: { fish_epic: 5 }, wallet: { coins: 0, pearls: 0 }, buildings: { home: 5, dryer: 5, warehouse: 5 }, jobs: [], storage: { capacity: 500, used: 5, reserved: 0, available: 495, overflow: 0 } };
  const economy = { snapshot: state, now: Date.parse('2026-10-07T12:00:00Z'), busy: false, uncertain: false, retryAt: 0, error: null, act: forbidden };
  const html = renderToStaticMarkup(createElement(WorldProductionCard, { economy, recipe }));
  assert.match(html, /Редкая рыба/);
  assert.match(html, /data-item-icon="fish_rare"/);
  assert.doesNotMatch(html, /<select|data-item-icon="fish_epic"/);
  assert.match(html, /data-blocked="true"/);
  assert.doesNotMatch(html, /disabled=|Все рецепты|Способ производства/);
  assert.match(html, /Вылазки \+60% · запас на 2 ч работы/);
  assert.match(html, /Одна стройка \+50% скорости/);
  assert.match(html, /Скорость вылазки \+60%, стройки \+50%/);
  assert.deepEqual(state.inventory, { fish_epic: 5 });
});
