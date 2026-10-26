import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-pantry-presentation-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { pantryItemRarity, pantryRecipeFishRarity, pantryRarities, pantryRarityNames, pantryItemRarities, pantryItemGroup, groupPantryItems } = await vite.ssrLoadModule("/features/economy/ui/inventory/pantry-item-presentation.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { fishClassForItem } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const { WorldPantryMenu } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const now = Date.parse("2026-10-16T15:00:00Z");
function controller(inventory = {}, catalog = structuredClone(economyCatalog)) {
  const snapshot = { ownerPublicId: "presentation-owner", revision: 1, serverTime: new Date(now).toISOString(), catalog,
    wallet: { coins: 1000, pearls: 0 }, inventory, buildings: { home: 5, warehouse: 10, workshop: 5, woodlot: 5, garden: 5, quarry: 5, kiln: 5, dryer: 5 }, jobs: [], completedExplorations: 0 };
  return { snapshot: { ...snapshot, storage: economyStorage(snapshot) }, now, retryAt: 0, busy: false, uncertain: false, error: null,
    act() { assert.fail("presentation and opening storage cannot issue an economy command"); }, retry() {} };
}
const render = (economy, initialTab = "supplies") => renderToStaticMarkup(createElement(WorldPantryMenu, { economy, initialTab, onExplore() {} }));
const groupsIn = html => [...html.matchAll(/data-pantry-item-group="([^"]+)"/g)].map(match => match[1]);
const cardFor = (html, id) => html.match(new RegExp(`<button[^>]*data-guide-pantry-item="${id}"[^>]*>`))?.[0];

test("every catalog item has an authored or existing fishing rarity without inferring from its price", () => {
  const catalog = structuredClone(economyCatalog), before = structuredClone(catalog);
  for (const item of catalog.items) {
    const explicit = fishClassForItem(item.id, catalog.fishing) || catalog.fishing.baits.some(bait => bait.itemId === item.id)
      || item.category === "special" || pantryRecipeFishRarity(item.id, catalog) || Object.hasOwn(pantryItemRarities, item.id);
    assert.ok(explicit, `Decide the presentation rarity for ${item.id}`);
    assert.ok(pantryRarities.includes(pantryItemRarity(item, catalog)), item.id);
    const original = pantryItemRarity(item, catalog);
    item.baseSellPrice = 9_999_999_999;
    assert.equal(pantryItemRarity(item, catalog), original, `${item.id}: a price cannot promote a visual tier`);
    item.baseSellPrice = before.items.find(entry => entry.id === item.id).baseSellPrice;
  }
  assert.deepEqual(catalog, before);
});

test("fish, species, baits and directly cooked dishes use the actual fishing class; alternatives use its stable minimum", () => {
  const catalog = structuredClone(economyCatalog);
  for (const item of catalog.items) {
    const group = fishClassForItem(item.id, catalog.fishing), bait = catalog.fishing.baits.find(entry => entry.itemId === item.id);
    if (group || bait) assert.equal(pantryItemRarity(item, catalog), (group ?? bait).rarity, item.id);
  }
  for (const [id, expected] of Object.entries({ grilled_fish: "common", fish_soup: "common", smoked_fish: "common", berry_fish: "uncommon", hearty_fish: "rare", epic_fish: "epic", legendary_fish: "legendary" })) {
    assert.equal(pantryItemRarity(catalog.items.find(item => item.id === id), catalog), expected, id);
  }
  const original = catalog.recipes.find(recipe => recipe.id === "cook_legendary_fish");
  catalog.recipes.push({ ...structuredClone(original), id: "alternative_fish", cost: { ...original.cost, items: { fish_epic: 1 } } });
  assert.equal(pantryRecipeFishRarity("legendary_fish", catalog), "epic");
  catalog.recipes.reverse(); assert.equal(pantryRecipeFishRarity("legendary_fish", catalog), "epic", "recipe ordering cannot recolor a dish");
});

test("all three relics have the same tier, and unknown IDs or legacy categories keep safe visible fallbacks", () => {
  const relics = economyCatalog.items.filter(item => item.category === "special"); assert.equal(relics.length, 3);
  assert.deepEqual(relics.map(item => pantryItemRarity(item, economyCatalog)), ["epic", "epic", "epic"]);
  for (const id of ["constructor", "toString", "future_drop"]) {
    const item = { id, category: "legacy_unknown" };
    assert.equal(pantryItemRarity(item, economyCatalog), "common", id);
    assert.equal(pantryItemGroup(item, economyCatalog), "other", id);
  }
  assert.equal(pantryItemGroup({ id: "new_harvest", category: "produce" }, economyCatalog), "harvest");
  assert.equal(pantryItemGroup({ id: "new_food", category: "provisions" }, economyCatalog), "other");
});

test("groups follow fixed type and catalog order, contain each input once and omit empty sections", () => {
  const selected = economyCatalog.items.filter(item => ["berries", "wood", "planks", "worm_bait", "berry_compote", "fish_common", "smoked_fish"].includes(item.id));
  const original = [...selected], groups = groupPantryItems([...selected].reverse(), economyCatalog);
  assert.deepEqual(groups.map(group => group.id), ["materials", "crafted", "berries", "bait", "drinks", "travel", "fish"]);
  const ids = groups.flatMap(group => group.items.map(item => item.id)); assert.equal(new Set(ids).size, selected.length);
  assert.deepEqual([...ids].sort(), selected.map(item => item.id).sort()); assert.deepEqual(selected, original);
  assert.deepEqual(groupPantryItems([], economyCatalog), []);
  const materials = economyCatalog.items.filter(item => item.category === "material");
  assert.deepEqual(groupPantryItems([...materials].reverse(), economyCatalog)[0].items.map(item => item.id), materials.map(item => item.id));
});

test("storage renders small nonempty supply sections and retains unknown stock with its original count", () => {
  const catalog = structuredClone(economyCatalog);
  catalog.items.push({ id: "future_drop", name: "Неизвестная находка", category: "legacy_unknown", baseSellPrice: 100, tradable: true });
  const economy = controller({ wood: 4, planks: 2, berries: 7, worm_bait: 3, future_drop: 6 }, catalog), before = structuredClone(economy.snapshot);
  const html = render(economy);
  assert.deepEqual(groupsIn(html), ["materials", "crafted", "berries", "bait", "other"]);
  for (const [id, name, count] of [["wood", "Бревно", 4], ["planks", "Доска", 2], ["berries", "Малина", 7], ["worm_bait", "Лесной червячок", 3], ["future_drop", "Неизвестная находка", 6]]) {
    const card = cardFor(html, id); assert.ok(card); assert.ok(card.includes(`aria-label="${name}: ${count}"`));
    const rarity = pantryItemRarity(catalog.items.find(item => item.id === id), catalog);
    assert.ok(card.includes(`data-item-rarity="${rarity}"`)); assert.ok(card.includes(`title="${name} · Редкость: ${pantryRarityNames[rarity]}"`));
    const description = card.match(/aria-describedby="([^"]+)"/)?.[1]; assert.ok(description);
    assert.ok(html.includes(`hidden="" id="${description}">Редкость: ${pantryRarityNames[rarity]}`));
  }
  assert.equal((html.match(/data-guide-pantry-item="future_drop"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-pantry-item-group="(?:fish-dishes|drinks|desserts|travel)"/);
  assert.deepEqual(economy.snapshot, before);
});

test("all provisions share the refrigerator, with compotes together and travel supplies separated from meals", () => {
  const provisions = economyCatalog.items.filter(item => item.category === "provisions"), inventory = Object.fromEntries(provisions.map(item => [item.id, 2]));
  const economy = controller({ ...inventory, berries: 3, wood: 4, fish_common: 2 }), before = structuredClone(economy.snapshot);
  const supplies = render(economy), fridge = render(economy, "fridge");
  assert.deepEqual(groupsIn(fridge), ["fish-dishes", "drinks", "desserts", "travel"]);
  for (const item of provisions) {
    assert.equal(cardFor(supplies, item.id), undefined, item.id);
    assert.ok(cardFor(fridge, item.id)?.includes(`aria-label="${item.name}: 2"`), item.id);
  }
  for (const id of ["berry_compote", "strawberry_compote", "blueberry_compote", "bottled_compote"]) assert.equal(pantryItemGroup(economyCatalog.items.find(item => item.id === id), economyCatalog), "drinks");
  for (const id of ["dried_berries", "smoked_fish", "trail_ration", "packed_berries"]) assert.equal(pantryItemGroup(economyCatalog.items.find(item => item.id === id), economyCatalog), "travel");
  assert.equal(pantryItemGroup(economyCatalog.items.find(item => item.id === "berry_gift"), economyCatalog), "desserts");
  assert.ok(fridge.indexOf('data-pantry-fish-class="fish_common"') < fridge.indexOf('data-pantry-item-group="fish-dishes"'));
  assert.deepEqual(economy.snapshot, before, "tabs share one unchanged stock and storage capacity");
});

test("rarity colors remain pale and readable through hover and selection, with symmetric relic styling", async () => {
  const css = await readFile(new URL("../features/economy/ui/inventory/world-pantry-menu.module.css", import.meta.url), "utf8");
  assert.match(css, /\.pantry \.item\[data-item-rarity\]:hover:not\(:disabled\)/);
  assert.match(css, /\.pantry \.item\[data-item-rarity\]\[aria-pressed="true"\][^}]*box-shadow:inset/);
  assert.doesNotMatch(css, /\.relicCard\[data-relic=/, "the three relics must not imply distinct rarity tiers");
  const luminance = hex => {
    const rgb = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const palettes = [...css.matchAll(/\.pantry \[data-item-rarity(?:="([^"]+)")?\] \{([^}]+)\}/g)];
  assert.equal(palettes.length, pantryRarities.length, "every visual tier needs its own checked palette");
  for (const match of palettes) {
    const values = Object.fromEntries([...match[2].matchAll(/--item-([\w]+):#([a-f\d]{6})/gi)].map(value => [value[1], value[2]]));
    for (const background of ["paper", "wash", "selected"]) {
      const a = luminance(values.tone), b = luminance(values[background]);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${match[1] ?? "common"}/${background}`);
    }
  }
  const economy = controller({ ancient_core: 1, moon_crystal: 2, living_resin: 3 });
  const html = render(economy, "relics"); assert.equal((html.match(/data-item-rarity="epic"/g) ?? []).length, 3);
});
