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

test('kitchen advertises all qualifying rare/epic fish and reserves a distinct legendary recipe', () => {
  const hearty = economyCatalog.recipes.find(recipe => recipe.id === 'cook_hearty_fish');
  assert.equal(recipeFishGroupLabel(hearty, economyCatalog), 'Любая редкая или эпическая рыба');
  assert.equal(recipeFishGroupLabel(economyCatalog.recipes.find(recipe => recipe.id === 'cook_epic_fish'), economyCatalog), 'Любая эпическая рыба');
  assert.equal(recipeFishGroupLabel(economyCatalog.recipes.find(recipe => recipe.id === 'cook_legendary_fish'), economyCatalog), 'Любая легендарная рыба');
  const restricted = { ...hearty, fishInput: { itemIds: ['fish_mooncarp'] } };
  assert.equal(recipeFishGroupLabel(restricted, economyCatalog), 'Рыба на выбор', 'a restricted future recipe must not promise every rare species');
});

test('rare recipe preview explains alternatives and both bonuses without auto-selecting an owned valuable fish', () => {
  const recipe = economyCatalog.recipes.find(entry => entry.id === 'cook_hearty_fish');
  const forbidden = () => assert.fail('Reading a recipe may not spend or choose fish');
  const state = { ownerPublicId: 'TEST-0000-0001', revision: 1, catalog: economyCatalog, inventory: { fish_mirror_koi: 5 }, wallet: { coins: 0, pearls: 0 }, buildings: { home: 5, dryer: 5, warehouse: 5 }, jobs: [], storage: { capacity: 500, used: 5, reserved: 0, available: 495, overflow: 0 } };
  const economy = { snapshot: state, now: Date.parse('2026-10-07T12:00:00Z'), busy: false, uncertain: false, retryAt: 0, error: null, act: forbidden };
  const html = renderToStaticMarkup(createElement(WorldRecipeDetail, { economy, recipe, onCollapse: forbidden }));
  assert.match(html, /Любая редкая или эпическая рыба/);
  for (const id of recipe.fishInput.itemIds) assert.ok(html.includes(`value="${id}"`));
  assert.match(html, /value="fish_mooncarp" selected=""/);
  assert.doesNotMatch(html, /value="fish_mirror_koi" selected=""/);
  assert.match(html, /Вылазка \+60% · стройка \+50% к скорости/);
  assert.deepEqual(state.inventory, { fish_mirror_koi: 5 });
});
