import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const book = await vite.ssrLoadModule("/features/world/domain/collection-book.ts");
const { WorldCollections } = await vite.ssrLoadModule("/features/world/ui/collections/world-collections.tsx");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const fresh = () => ({ ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 }), catalog: economyCatalog });

test("the book has three chapters with permanent finds and every current fish species", () => {
  assert.deepEqual(book.COLLECTION_CHAPTERS.map(entry => entry.title), ["Путешествия", "Рыбалка", "Каменоломня"]);
  assert.equal(book.BOOK_COLLECTION_COUNT, 10 + economyCatalog.fishing.fish.length);
  assert.deepEqual(book.COLLECTION_CHAPTERS.map(entry => book.collectionBookEntries(entry.id, [], fresh()).length), [6, economyCatalog.fishing.fish.length, 4]);
  assert.equal(new Set(book.bookFindIds).size, book.bookFindIds.length);
});

test("legacy forest ownership and new finds combine without duplicate progress or new resources", () => {
  const economy = fresh(); economy.progression.collections.finds = ["acorn", "feather", "quartz_cluster"];
  const travel = book.collectionBookEntries("travel", ["acorn", "winged_seed", "river_pearl", "unknown"], economy);
  assert.deepEqual(travel.filter(entry => entry.owned).map(entry => entry.id), ["acorn", "feather", "winged_seed"]);
  assert.deepEqual(book.collectionBookEntries("quarry", [], economy).filter(entry => entry.owned).map(entry => entry.id), ["quartz_cluster"]);
  assert.deepEqual(economy.inventory, {});
});

test("fish ownership in inventory never fills a chapter but verified catches survive sale", () => {
  const economy = fresh(); economy.inventory = { fish_mooncarp: 10, fish: 50 };
  assert.equal(book.collectionBookEntries("fishing", [], economy).filter(entry => entry.owned).length, 0);
  economy.inventory = {}; economy.fishing.catches = { fish_mooncarp: 1, fish: 4 };
  assert.deepEqual(book.collectionBookEntries("fishing", [], economy).filter(entry => entry.owned).map(entry => entry.id), ["fish", "fish_mooncarp"]);
});

test("progress reports completed work and keeps the partial interval", () => {
  const economy = fresh(); economy.progression.collections.travelSeconds = 9000; economy.progression.collections.quarrySeconds = 18000;
  assert.deepEqual(book.collectionBookProgress("travel", economy), { completed: 1800, seconds: 7200 });
  assert.deepEqual(book.collectionBookProgress("quarry", economy), { completed: 3600, seconds: 14400 });
  assert.equal(book.collectionBookProgress("fishing", economy), null);
});

test("book UI renders accessible chapter tabs, owned records and current acquisition rules", () => {
  const state = newWorldState(); state.collection = ["acorn"]; state.inventory.push("explorer_cap");
  const html = renderToStaticMarkup(createElement(WorldCollections, { state, gifts: [], economy: fresh() }));
  assert.match(html, /Книга коллекций/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-selected="true"/);
  assert.ok(html.includes(`1/${book.BOOK_COLLECTION_COUNT}`));
  assert.equal((html.match(/data-owned="true"/g) ?? []).length, 1);
  assert.match(html, /за каждые 2 ч завершённых работ/);
  assert.match(html, /Продажа рыбы и материалов их не стирает/);
  assert.doesNotMatch(html, /Лесной альбом|прежних путешествий.<\/p><\/div>|Мохлику ·/);
});
