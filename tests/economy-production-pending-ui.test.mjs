import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-pending-production-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldProductionSlots } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-slots.tsx");
const { WorldProductionCard } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { productionProjection } = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const time = Date.parse("2026-10-15T12:00:00Z");
function controller(entries = []) {
  const snapshot = economyViewSchema.parse({ ownerPublicId: "AAAA-0000-0001", revision: 2, serverTime: new Date(time).toISOString(), wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 1 },
    buildings: { home: 5, garden: 3, workshop: 3, dryer: 3, woodlot: 3, warehouse: 1 }, productionSlots: { garden: 3, workshop: 3 }, jobs: [],
    storage: { capacity: 50, used: 1, reserved: 0, available: 49, overflow: 0 }, migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
  const calls = [];
  return { snapshot, productionSnapshot: productionProjection(snapshot, entries), pendingProductionIds: entries.map(entry => entry.requestId), pendingProductionCount: entries.length,
    productionQueueAvailable: true, directActionsAvailable: false, now: time + 86_400_000, busy: false, uncertain: false, error: null, retryAt: time + 90_000_000,
    act(...args) { calls.push(args); return true; }, calls };
}
function elements(tree) {
  const found = [];
  function visit(node) { if (!isValidElement(node)) return; found.push(node); Children.forEach(node.props.children, visit); }
  visit(tree); return found;
}
function card(economy, recipeId) {
  let tree;
  function Probe() { return tree = WorldProductionCard({ economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === recipeId) }); }
  const html = renderToStaticMarkup(createElement(Probe));
  return { html, button: elements(tree).find(element => element.props["data-recipe"] === recipeId) };
}

test("pending cells show the actual product and saved state even after the preview deadline, without claim or cancellation", () => {
  const entry = { requestId: crypto.randomUUID(), targetId: "grow_berries" }, economy = controller([entry]);
  const html = renderToStaticMarkup(createElement(WorldProductionSlots, { economy, stationId: "garden" }));
  assert.match(html, /data-state="pending"/);
  assert.match(html, /data-item-icon="berries"/);
  assert.match(html, /Сохранено/);
  assert.doesNotMatch(html, /data-production-control|data-production-action|Забрать|Удалить|Готово/);
  assert.deepEqual(economy.snapshot.jobs, []);
});

test("production cards use reserved ingredients while independent nonfish slots remain available through retry cooldown", () => {
  const economy = controller([{ requestId: crypto.randomUUID(), targetId: "make_planks" }]);
  assert.equal(economy.productionSnapshot.inventory.wood, undefined);
  const exhausted = card(economy, "make_planks");
  assert.match(exhausted.html, /data-blocked="true"/);
  exhausted.button.props.onClick(); assert.deepEqual(economy.calls, []);
  const berry = card(economy, "grow_berries");
  assert.doesNotMatch(berry.html, /data-blocked="true"/);
  berry.button.props.onClick(); assert.deepEqual(economy.calls, [["start_production", "grow_berries", 1]]);
});

test("an unavailable direct gate never dispatches nonqueued fish cooking or a storage-less fallback", () => {
  for (const id of ["cook_grilled_fish", "grow_berries"]) {
    const economy = controller(); economy.productionQueueAvailable = false; economy.retryAt = 0;
    economy.snapshot.inventory.fish_common = 1;
    economy.productionSnapshot = economy.snapshot;
    const view = card(economy, id);
    assert.match(view.html, /data-blocked="true"/);
    view.button.props.onClick(); assert.deepEqual(economy.calls, []);
  }
});
