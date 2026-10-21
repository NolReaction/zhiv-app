import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const book = await vite.ssrLoadModule("/features/world/domain/collection-book.ts");
const { WorldCollections, CollectionBookFinds } = await vite.ssrLoadModule("/features/world/ui/collections/world-collections.tsx");
const { collectionBookPage, COLLECTION_PAGE_SIZE } = await vite.ssrLoadModule("/features/world/ui/collections/collection-book-page.ts");
const { createCollectionBookSwipe } = await vite.ssrLoadModule("/features/world/ui/collections/collection-book-swipe.ts");
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
  const inventory = structuredClone(economy.inventory);
  const travel = book.collectionBookEntries("travel", ["acorn", "winged_seed", "river_pearl", "unknown"], economy);
  assert.deepEqual(travel.filter(entry => entry.owned).map(entry => entry.id), ["acorn", "feather", "winged_seed"]);
  assert.deepEqual(book.collectionBookEntries("quarry", [], economy).filter(entry => entry.owned).map(entry => entry.id), ["quartz_cluster"]);
  assert.deepEqual(economy.inventory, inventory);
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
  assert.match(html, /До одной находки за работу/);
  assert.match(html, /Короткие задания копят прогресс/);
  assert.match(html, /За одну работу учитывается до 2 ч/);
  assert.match(html, /Продажа рыбы и материалов их не стирает/);
  assert.match(html, /Страница 1 из 2/);
  assert.match(html, /data-page-content="true" data-page-index="0"/);
  assert.match(html, /Листайте страницы ↔/);
  assert.equal((html.match(/role="listitem"/g) ?? []).length, COLLECTION_PAGE_SIZE);
  assert.doesNotMatch(html, /листайте влево и вправо/);
  assert.doesNotMatch(html, /Лесной альбом|прежних путешествий.<\/p><\/div>|Мохлику ·/);
});

test("book pages filter permanent ownership without mutating the catalogue or leaving an invalid page", () => {
  const entries = Object.freeze(Array.from({ length: 11 }, (_, id) => Object.freeze({ id, owned: id % 2 === 0 })));
  const all = collectionBookPage(entries, "all", 1);
  assert.deepEqual(all.entries.map(entry => entry.id), [4, 5, 6, 7]);
  assert.equal(all.pages, 3);
  const owned = collectionBookPage(entries, "owned", 99);
  assert.deepEqual(owned.entries.map(entry => entry.id), [8, 10]);
  assert.equal(owned.page, 1); assert.equal(owned.count, 6);
  assert.deepEqual(collectionBookPage(entries, "missing", -3).entries.map(entry => entry.id), [1, 3, 5, 7]);
  assert.equal(collectionBookPage(entries, "all", NaN).page, 0);
  assert.deepEqual(collectionBookPage([], "owned", 8), { entries: [], page: 0, pages: 1, count: 0 });
  assert.deepEqual(entries.map(entry => entry.id), Array.from({ length: 11 }, (_, id) => id));
});

test("fish pages have explicit bounded navigation and keep unearned names and illustrations hidden", () => {
  const economy = fresh(); economy.fishing.catches = { fish: 1, fish_mooncarp: 1 };
  const entries = book.collectionBookEntries("fishing", [], economy), calls = [];
  const render = (filter = "all", page = 0, rows = entries) => CollectionBookFinds({ entries: rows, filter, page,
    onFilterChange: value => calls.push(["filter", value]), onPageChange: value => calls.push(["page", value]) });
  const elements = tree => {
    const result = [];
    function visit(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, visit); }
    visit(tree); return result;
  };
  const first = render(), html = renderToStaticMarkup(first);
  assert.equal((html.match(/role="listitem"/g) ?? []).length, COLLECTION_PAGE_SIZE);
  assert.match(html, /Неизвестная рыба/);
  for (const entry of entries.filter(entry => !entry.owned)) assert.ok(!html.includes(entry.name));
  assert.deepEqual(calls, [], "rendering never changes ownership or chooses a page");
  const previous = elements(first).find(node => node.props["aria-label"] === "Предыдущая страница находок");
  assert.equal(previous.props.disabled, true); previous.props.onClick(); assert.deepEqual(calls, []);
  elements(first).find(node => node.props["aria-label"] === "Следующая страница находок").props.onClick();
  assert.deepEqual(calls, [["page", 1]]);
  const last = render("all", 99);
  const next = elements(last).find(node => node.props["aria-label"] === "Следующая страница находок");
  assert.equal(next.props.disabled, true); next.props.onClick(); assert.equal(calls.length, 1);
  elements(last).find(node => node.props["aria-label"] === "Показать находки").props.onChange({ target: { value: "owned" } });
  assert.deepEqual(calls.at(-1), ["filter", "owned"]);
  const pages = elements(first).find(node => node.props["aria-label"] === "Выбрать страницу находок");
  pages.props.onChange({ target: { value: "2" } });
  assert.deepEqual(calls.at(-1), ["page", 2], "a page can be selected directly without stepping through the book");
  const count = calls.length;
  for (const value of ["-1", "100", "1.5", "oops"]) pages.props.onChange({ target: { value } });
  assert.equal(calls.length, count);
  const owned = renderToStaticMarkup(render("owned", 99));
  assert.match(owned, /Страница 1 из 1/); assert.equal((owned.match(/data-owned="true"/g) ?? []).length, 2);
  assert.doesNotMatch(owned, /Неизвестная рыба/);
  assert.doesNotMatch(owned, /Листайте страницы ↔/);
  const empty = render("owned", 9, entries.map(entry => ({ ...entry, owned: false })));
  assert.match(renderToStaticMarkup(empty), /пока нет открытых находок/);
  assert.ok(elements(empty).filter(node => node.type === "button").every(node => node.props.disabled));
});

const swipePoint = (x, y = 20, extra = {}) => ({ pointerId: 1, pointerType: "touch", isPrimary: true,
  clientX: x, clientY: y, timeStamp: 100, ...extra });
const swipeContext = { key: "all:catalogue", page: 1, pages: 3 };

test("a horizontal touch or pen turns exactly one bounded page on release", () => {
  for (const pointerType of ["touch", "pen"]) {
    const swipe = createCollectionBookSwipe();
    swipe.down(swipePoint(150, 20, { pointerType }), swipeContext);
    swipe.move(swipePoint(10, 25, { pointerType, timeStamp: 250 }), swipeContext);
    assert.equal(swipe.up(swipePoint(10, 25, { pointerType, timeStamp: 300 }), swipeContext), 2);
    assert.equal(swipe.up(swipePoint(10, 25, { pointerType, timeStamp: 300 }), swipeContext), null);
    swipe.down(swipePoint(50, 20, { pointerType }), swipeContext);
    assert.equal(swipe.up(swipePoint(150, 25, { pointerType, timeStamp: 300 }), swipeContext), 0);
  }
  for (const [page, start, end] of [[0, 50, 150], [2, 150, 50]]) {
    const swipe = createCollectionBookSwipe(), context = { ...swipeContext, page };
    swipe.down(swipePoint(start), context);
    assert.equal(swipe.up(swipePoint(end, 20, { timeStamp: 300 }), context), null);
  }
});

test("tap, long press, vertical or diagonal scrolling, cancellation and mouse cannot turn a page", () => {
  for (const end of [swipePoint(145, 22, { timeStamp: 300 }), swipePoint(20, 20, { timeStamp: 900 }),
    swipePoint(20, 150, { timeStamp: 300 }), swipePoint(20, 110, { timeStamp: 300 })]) {
    const swipe = createCollectionBookSwipe(); swipe.down(swipePoint(150), swipeContext);
    assert.equal(swipe.up(end, swipeContext), null);
  }
  const scroll = createCollectionBookSwipe(); scroll.down(swipePoint(150), swipeContext);
  scroll.move(swipePoint(148, 60), swipeContext);
  assert.equal(scroll.up(swipePoint(20, 60, { timeStamp: 300 }), swipeContext), null, "a scroll cannot become a late horizontal swipe");
  const cancel = createCollectionBookSwipe(); cancel.down(swipePoint(150), swipeContext); cancel.cancel(1);
  assert.equal(cancel.up(swipePoint(20, 20, { timeStamp: 300 }), swipeContext), null);
  cancel.down(swipePoint(150, 20, { pointerType: "mouse" }), swipeContext);
  assert.equal(cancel.up(swipePoint(20, 20, { pointerType: "mouse", timeStamp: 300 }), swipeContext), null);
});

test("a second contact and changed catalogue, filter or page invalidate an unfinished swipe", () => {
  const swipe = createCollectionBookSwipe(); swipe.down(swipePoint(150), swipeContext);
  swipe.down(swipePoint(170, 20, { pointerId: 2, isPrimary: false }), swipeContext);
  assert.equal(swipe.up(swipePoint(20, 20, { timeStamp: 300 }), swipeContext), null);
  assert.equal(swipe.up(swipePoint(30, 20, { pointerId: 2, isPrimary: false, timeStamp: 300 }), swipeContext), null);
  swipe.down(swipePoint(150), swipeContext);
  assert.equal(swipe.up(swipePoint(20, 20, { timeStamp: 300 }), swipeContext), 2, "a new single contact works after pinch ends");
  for (const changed of [{ ...swipeContext, key: "owned:catalogue" }, { ...swipeContext, key: "all:new-entry" },
    { ...swipeContext, page: 0 }, { ...swipeContext, pages: 2 }]) {
    swipe.down(swipePoint(150), swipeContext);
    assert.equal(swipe.up(swipePoint(20, 20, { timeStamp: 300 }), changed), null);
  }
});
