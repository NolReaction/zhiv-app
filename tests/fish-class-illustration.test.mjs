import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-fish-class-art-${process.pid}`, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishClassIllustration } = await vite.ssrLoadModule("/features/economy/ui/fishing/fish-class-illustration.ts");
const { PlayerItemIcon } = await vite.ssrLoadModule("/features/economy/ui/fishing/fish-discovery.tsx");
const { ItemIcon } = await vite.ssrLoadModule("/features/items/item-icon.tsx");
const { WorldPantryMenu } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState, economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const catalog = economyCatalog.fishing;
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const state = (inventory = {}, catches = {}) => {
  const value = { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 0 }),
    ownerPublicId: "FISH-ART-PLAYER", revision: 1, inventory, catalog: economyCatalog };
  value.fishing = { ...value.fishing, catches };
  return { ...value, storage: economyStorage(value) };
};

test("each fish class can use a personally caught species while keeping its original class identity", () => {
  for (const group of catalog.classes) {
    const species = catalog.fish.find(fish => fish.rarity === group.rarity && fish.itemId !== "fish");
    const value = state({ [group.itemId]: 2 }, { [species.itemId]: 7 });
    const before = structuredClone(value);
    assert.equal(fishClassIllustration(value, group.itemId), species.itemId);
    const html = render(PlayerItemIcon, { state: value, itemId: group.itemId, size: 20 });
    assert.ok(html.includes(`data-item-icon="${group.itemId}"`));
    assert.ok(html.includes(`data-fish-illustration="${species.itemId}"`));
    assert.deepEqual(value, before, "drawing cannot create species stock or change lifetime catches");
  }
});

test("bought or gifted class stock cannot invent a personal species discovery", () => {
  const value = state({ fish_epic: 50, fish_legendary: 4 });
  for (const itemId of ["fish_epic", "fish_legendary"]) {
    assert.equal(fishClassIllustration(value, itemId), undefined);
    assert.match(render(PlayerItemIcon, { state: value, itemId }), /data-fish-illustration="fish"/);
  }
});

test("class illustration uses only species of its own rarity and remains deterministic on ties", () => {
  const group = catalog.classes.find(group => group.rarity === "common");
  const candidates = catalog.fish.filter(fish => fish.rarity === group.rarity);
  const catches = Object.fromEntries(candidates.map(fish => [fish.itemId, 3]));
  catches.fish_shark = 500;
  const value = state({}, catches);
  assert.equal(fishClassIllustration(value, group.itemId), candidates[0].itemId);
  value.fishing.catches[candidates[1].itemId] = 4;
  assert.equal(fishClassIllustration(value, group.itemId), candidates[1].itemId);
});

test("invalid counts, unknown fish and absent snapshots do not produce a fabricated illustration", () => {
  const value = state({}, { fish_shark: Infinity, fish_sturgeon: -1, imaginary_fish: 10 });
  assert.equal(fishClassIllustration(value, "fish_legendary"), undefined);
  assert.equal(fishClassIllustration(value, "fish_epic"), undefined);
  assert.equal(fishClassIllustration(null, "fish_legendary"), undefined);
  assert.equal(fishClassIllustration(value, "wood"), undefined);
});

test("species visibility and ordinary item artwork retain their previous rules", () => {
  const value = state({}, { fish_shark: 1 });
  assert.match(render(PlayerItemIcon, { state: value, itemId: "fish_sturgeon" }), /data-hidden-fish="true"/);
  assert.doesNotMatch(render(PlayerItemIcon, { state: value, itemId: "fish_shark" }), /data-hidden-fish="true"/);
  assert.equal(render(ItemIcon, { itemId: "wood", fishSpecies: "fish_shark" }), render(ItemIcon, { itemId: "wood" }));
});

test("fridge draws remaining species and unidentified stock without borrowing lifetime collection illustrations", () => {
  const value = state({ fish_epic: 9, fish_legendary: 2 }, { fish_sturgeon: 40, fish_shark: 7 });
  const before = structuredClone(value);
  const economy = { snapshot: value, now: Date.now(), busy: false, uncertain: false, retryAt: 0, error: null,
    act() { assert.fail("drawing the fridge cannot issue a command"); } };
  const html = render(WorldPantryMenu, { economy, initialTab: "fridge", onUpgrade() {}, onExplore() {} });
  assert.match(html, /data-guide-pantry-item="fish_epic"/);
  assert.match(html, /aria-label="Эпическая рыба: 9"/);
  assert.match(html, /aria-label="Легендарная рыба: 2"/);
  assert.match(html, /aria-label="Без указания вида: 9"/);
  assert.match(html, /aria-label="Без указания вида: 2"/);
  assert.match(html, /data-fish-illustration="fish"/);
  assert.doesNotMatch(html, /data-fish-illustration="(?:fish_sturgeon|fish_shark)"/);
  assert.doesNotMatch(html, /data-guide-pantry-item="fish_sturgeon"|data-guide-pantry-item="fish_shark"/);
  assert.deepEqual(value, before);
  value.fishing.stock = { fish_mirror_koi: 3, fish_shark: 1 };
  const trackedBefore = structuredClone(value);
  const tracked = render(WorldPantryMenu, { economy, initialTab: "fridge", onUpgrade() {}, onExplore() {} });
  assert.match(tracked, /data-pantry-fish-card="fish_mirror_koi"/); assert.match(tracked, /aria-label="Зеркальный кои: 3"/);
  assert.match(tracked, /data-pantry-fish-card="fish_shark"/); assert.match(tracked, /aria-label="Теневая акула: 1"/);
  assert.match(tracked, /aria-label="Без указания вида: 6"/); assert.match(tracked, /aria-label="Без указания вида: 1"/);
  assert.doesNotMatch(tracked, /data-pantry-fish-card="fish_sturgeon"/);
  assert.deepEqual(value, trackedBefore);
});

test("tracked stocks use a fish still owned instead of an exhausted lifetime favourite", () => {
  const value = state({ fish_epic: 3 }, { fish_sturgeon: 900, fish_mirror_koi: 4 });
  value.fishing.stock = { fish_mirror_koi: 3 };
  assert.equal(fishClassIllustration(value, "fish_epic"), "fish_mirror_koi");
  value.fishing.stock = {};
  assert.equal(fishClassIllustration(value, "fish_epic"), undefined, "unidentified class stock cannot resurrect a consumed species");
});

test("owned species received by trade are visible goods without unlocking a personal collection entry", () => {
  const value = state({ fish_epic: 1 });
  value.fishing.stock = { fish_mirror_koi: 1 };
  const before = structuredClone(value);
  assert.doesNotMatch(render(PlayerItemIcon, { state: value, itemId: "fish_mirror_koi" }), /data-hidden-fish="true"/);
  assert.match(render(PlayerItemIcon, { state: value, itemId: "fish_sturgeon" }), /data-hidden-fish="true"/);
  assert.deepEqual(value.fishing.catches, {});
  assert.deepEqual(value, before);
});
