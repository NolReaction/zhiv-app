import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule('/features/economy/domain/model.ts');
const { recipeFishGroupLabel } = await vite.ssrLoadModule('/features/economy/ui/food/food-recipe-labels.ts');
const { WorldRecipeDetail } = await vite.ssrLoadModule('/features/economy/ui/stations/world-object-menu.tsx');

test('kitchen names exact classes and reserves a distinct legendary recipe', () => {
  const hearty = economyCatalog.recipes.find(recipe => recipe.id === 'cook_hearty_fish');
  assert.equal(recipeFishGroupLabel(hearty, economyCatalog), 'Редкая рыба');
  assert.equal(recipeFishGroupLabel(economyCatalog.recipes.find(recipe => recipe.id === 'cook_epic_fish'), economyCatalog), 'Эпическая рыба');
  assert.equal(recipeFishGroupLabel(economyCatalog.recipes.find(recipe => recipe.id === 'cook_legendary_fish'), economyCatalog), 'Легендарная рыба');
  assert.ok(economyCatalog.recipes.every(recipe => !recipe.fishInput), 'no recipe needs collection species');
});

test('rare recipe preview shows exact class and both bonuses without substituting a more valuable class', () => {
  const recipe = economyCatalog.recipes.find(entry => entry.id === 'cook_hearty_fish');
  const forbidden = () => assert.fail('Reading a recipe may not spend or choose fish');
  const state = { ownerPublicId: 'TEST-0000-0001', revision: 1, catalog: economyCatalog, inventory: { fish_epic: 5 }, wallet: { coins: 0, pearls: 0 }, buildings: { home: 5, dryer: 5, warehouse: 5 }, jobs: [], storage: { capacity: 500, used: 5, reserved: 0, available: 495, overflow: 0 } };
  const economy = { snapshot: state, now: Date.parse('2026-10-07T12:00:00Z'), busy: false, uncertain: false, retryAt: 0, error: null, act: forbidden };
  const html = renderToStaticMarkup(createElement(WorldRecipeDetail, { economy, recipe, onCollapse: forbidden }));
  assert.match(html, /Редкая рыба/);
  assert.match(html, /data-item-icon="fish_rare"/);
  assert.doesNotMatch(html, /<select|data-item-icon="fish_epic"/);
  assert.match(html, /disabled=""[^>]*>Начать/);
  assert.match(html, /Вылазка \+60% · стройка \+50% к скорости/);
  assert.deepEqual(state.inventory, { fish_epic: 5 });
});
