import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ItemIcon } = await vite.ssrLoadModule("/features/items/item-icon.tsx");
const { WorldPantryMenu, PantrySale, RelicPantrySection } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { FISH_RARITY_LEVELS, FISH_RARITY_NAMES, FishRarityBadge, FishRarityScale } = await vite.ssrLoadModule("/features/economy/ui/fishing/fish-rarity.tsx");
const { economyCatalog, economyCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage, newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { PleskFishingShop } = await vite.ssrLoadModule("/features/economy/ui/fishing/plesk-fishing-shop.tsx");
const { PleskFishingBookPage, FISHING_BOOK_PAGE_SIZE } = await vite.ssrLoadModule("/features/economy/ui/fishing/plesk-fishing-book.tsx");
const { collectionBookEntries } = await vite.ssrLoadModule("/features/world/domain/collection-book.ts");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const fishPages = state => Array.from({ length: Math.ceil(state.catalog.fishing.fish.length / FISHING_BOOK_PAGE_SIZE) }, (_, page) =>
  render(PleskFishingBookPage, { state, catalog: state.catalog.fishing, chapter: "fish", page })).join("");
const fresh = (inventory = {}) => {
  const state = { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 0 }),
    inventory, catalog: structuredClone(economyCatalog), ownerPublicId: "ME", revision: 1, serverTime: new Date().toISOString() };
  return { ...state, storage: economyStorage(state) };
};
const controller = state => ({ snapshot: state, market: null, marketError: null, busy: false, uncertain: false, error: null,
  notice: "", now: Date.now(), retryAt: 0, act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {} });
const pantry = (state, initialTab = "supplies") => render(WorldPantryMenu, { economy: controller(state), initialTab, onUpgrade() {}, onExplore() {}, onOpenMarket() {} });

test("relic masters are distinct native illustrations without external artwork or shared SVG IDs", () => {
  const drawings = ["ancient_core", "moon_crystal", "living_resin"].map(itemId => render(ItemIcon, { itemId, size: 48 }));
  assert.equal(new Set(drawings.map(html => html.replace(/data-item-icon="[^"]+"/, ""))).size, 3);
  drawings.forEach(html => {
    assert.match(html, /viewBox="0 0 48 48"/); assert.match(html, /<path/);
    assert.doesNotMatch(html, /<image|<defs|\bid="|<use|(?:href|src)=/);
  });
});

test("supplies omit relic sale cards while their separate tab reports the actual units", () => {
  const state = fresh({ wood: 5, ancient_core: 2, moon_crystal: 1 });
  const supplies = pantry(state);
  assert.match(supplies, /aria-label="Бревно: 5"/);
  assert.doesNotMatch(supplies, /aria-label="Древнее ядро: 2"|aria-label="Лунный кристалл: 1"|data-relic=/);
  assert.match(supplies, /role="tab"[^>]*aria-selected="false"[^>]*>[\s\S]*?<small>3<\/small><span>Реликвии<\/span>/);
  const relics = pantry(state, "relics");
  assert.equal((relics.match(/data-relic=/g) ?? []).length, 3);
  assert.match(relics, /Древнее ядро[\s\S]*?aria-label="В наличии: 2">×2</);
  assert.match(relics, /Живая смола[\s\S]*?aria-label="В наличии: 0">×0</);
  assert.doesNotMatch(relics, /В наличии ·|ключевых улучшений|занимает одно место/);
  assert.equal((relics.match(/aria-label="В наличии:/g) ?? []).length, 3, "each relic shows its stock once");
  assert.doesNotMatch(relics, /aria-label="Предметы в кладовой"|Продать торговцу|Купить жемчуг/);
});

test("relic shelf shows stock and acquisition actions without building requirements", () => {
  const state = fresh({ living_resin: 1 });
  const html = render(RelicPantrySection, { state, onExplore() {} });
  assert.match(html, /домом ур\. 3/); assert.match(html, /В путь/);
  assert.doesNotMatch(html, /Дом Мохлика ·|Кладовая ·|Материалы для улучшения|шт\.\)/);
  assert.doesNotMatch(html, /редкие|редкая|редкий|Купить|Продать|монет/i);
});

test("even an old direct sale callback exposes no NPC quote or sell control for a relic", () => {
  const html = render(PantrySale, { economy: controller(fresh({ ancient_core: 1 })), itemId: "ancient_core" });
  assert.match(html, /Древнее ядро/); assert.match(html, /обменять с другими игроками/);
  assert.doesNotMatch(html, /Продать торговцу|Количество|монет|Infinity|NaN|<input/);
});

test("all five fish grades have shared readable labels and are accepted by the contract", () => {
  assert.deepEqual(FISH_RARITY_LEVELS, ["common", "uncommon", "rare", "epic", "legendary"]);
  assert.deepEqual(Object.values(FISH_RARITY_NAMES), ["Обычная", "Необычная", "Редкая", "Эпическая", "Легендарная"]);
  for (const rarity of FISH_RARITY_LEVELS) {
    const catalogue = structuredClone(economyCatalog); catalogue.fishing.fish[0].rarity = rarity;
    assert.equal(economyCatalogSchema.safeParse(catalogue).success, true);
    const badge = render(FishRarityBadge, { rarity });
    assert.match(badge, new RegExp(`data-fish-rarity="${rarity}"`)); assert.ok(badge.includes(FISH_RARITY_NAMES[rarity]));
  }
  const legend = render(FishRarityScale, {});
  assert.equal((legend.match(/data-fish-rarity=/g) ?? []).length, 5);
});

test("class stocks carry rarity while species remain independently discoverable", () => {
  assert.deepEqual(economyCatalog.fishing.classes.map(entry => entry.itemId), ["fish_common", "fish_uncommon", "fish_rare", "fish_epic", "fish_legendary"]);
  const state = fresh({ fish_rare: 2 });
  const shop = render(PleskFishingShop, { economy: controller(state), onFishing() {}, onOpenPantry() {} });
  assert.doesNotMatch(shop, /Мои снасти|Ваши снасти/);
  const book = fishPages(state);
  assert.match(book, /data-fish-rarity="uncommon"/); assert.match(book, /data-fish-rarity="rare"/);
  assert.match(pantry(state, "fridge"), /data-fish-rarity="rare"/);
  const entries = collectionBookEntries("fishing", [], state);
  assert.equal(entries.length, economyCatalog.fishing.fish.length); assert.equal(entries.find(entry => entry.id === "fish_mooncarp").rarity, "rare");
  assert.equal(entries.find(entry => entry.id === "fish_shark").rarity, "legendary");
  assert.equal(entries.filter(entry => entry.owned).length, 0, "purchased stock never counts as caught");
  state.fishing.catches.fish_mooncarp = 1; state.inventory = {};
  const collection = fishPages(state);
  assert.match(collection, /data-fish-rarity="rare"/); assert.match(collection, /Поймано: 1/);
  assert.equal(collectionBookEntries("fishing", [], state).filter(entry => entry.owned).length, 1);
});


test("fridge merges legacy species into five class stocks and keeps collection entries sealed", () => {
  const state = fresh({ fish_common: 2, fish_silverfin: 3, fish_uncommon: 1, fish_rare: 2, fish_epic: 3, fish_legendary: 1 });
  const before = structuredClone(state.inventory);
  const html = pantry(state, "fridge");
  assert.match(html, /aria-label="Обычная рыба: 5"/);
  for (const group of state.catalog.fishing.classes) {
    assert.ok(html.includes(`data-item-icon="${group.itemId}"`));
    assert.ok(html.includes(`data-fish-rarity="${group.rarity}"`));
  }
  assert.doesNotMatch(html, /Серебринка|data-item-icon="fish_silverfin"/);
  assert.deepEqual(state.inventory, before, "display cannot mutate account stock");
  assert.equal(collectionBookEntries("fishing", [], state).filter(entry => entry.owned).length, 0);
});
