import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "zhiv-owned-fish-ui-"));
const hooksId = "virtual:owned-fish-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "owned-fish-ui-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let frames = new Map(), slots = [], cursor = 0, effects = [];
      export function reset() { frames.clear(); }
      export function render(key) { slots = frames.get(key) ?? []; frames.set(key, slots); cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useId() { return useRef('owned-fish-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) { const old = useRef(null); if (!old.current || dependencies.some((value, i) => !Object.is(value, old.current[i]))) { old.current = dependencies; effects.push(effect); } }
      export const useLayoutEffect = useEffect;
    `; },
    transform(source, id) {
      if (["/ui/inventory/world-pantry-menu.tsx", "/ui/fishing/plesk-fishing-shop.tsx", "/ui/fishing/use-fishing-command.ts", "/ui/fishing/world-fish-selection.tsx"].some(path => id.endsWith(path)))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }] });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldPantryMenu, PantrySale } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { FishCounter, PleskFishTrade } = await vite.ssrLoadModule("/features/economy/ui/fishing/plesk-fishing-shop.tsx");
const { WorldFishStockList } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-fish-stock-list.tsx");
const { WorldFishSelection } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-fish-selection.tsx");
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyLocalSellPrice } = await vite.ssrLoadModule("/features/economy/domain/local-sale.ts");
const now = Date.parse("2026-10-15T07:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "stock-owner", revision: 12, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 10000, pearls: 500 }, inventory: { fish_common: 5, fish_epic: 7, wood: 3, grilled_fish: 2 },
    fishing: economyFishingSchema.parse({ catches: { fish_shark: 99, fish_sturgeon: 200 }, stock: { fish: 1, fish_silverfin: 2, fish_sturgeon: 2, fish_mirror_koi: 3 } }),
    buildings: { home: 5, dryer: 5, warehouse: 10, workshop: 5, woodlot: 5, kiln: 5 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, ...overrides };
  const calls = [];
  return { snapshot: { ...state, storage: economyStorage(state) }, now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", calls,
    act: (...args) => { calls.push(args); return true; }, retry() {}, refresh() {}, ...flags };
}
function elements(tree) {
  const nodes = [];
  const visit = node => { if (isValidElement(node)) { nodes.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return nodes;
}
function render(component, props, frame = component.name) { hooks.render(frame); const tree = component(props); hooks.flush(); return { tree, nodes: elements(tree) }; }
const child = (view, component) => view.nodes.find(node => node.type === component);
const attr = (view, attribute, value) => view.nodes.find(node => node.props[attribute] !== undefined && (value === undefined || node.props[attribute] === value));
const text = node => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";
const button = (view, label) => view.nodes.find(node => node.type === "button" && text(node).includes(label));
const input = view => view.nodes.find(node => node.type === "input");

test("owned stock rows show real species, exact counts and unidentified remainder without catch-book guesses", () => {
  const economy = controller(), before = structuredClone(economy.snapshot), selections = [];
  const view = render(WorldFishStockList, { state: economy.snapshot, classId: "fish_epic", onSelect: id => selections.push(id) });
  assert.deepEqual(view.nodes.filter(node => node.props["data-fish-stock-item"]).map(node => [node.props["data-fish-stock-item"], text(node)]),
    [["fish_sturgeon", "Золотой осётр×2"], ["fish_mirror_koi", "Зеркальный кои×3"], ["fish_epic", "Без указания вида×2"]]);
  assert.doesNotMatch(renderToStaticMarkup(createElement(WorldFishStockList, { state: economy.snapshot, classId: "fish_epic", onSelect() {} })), /data-hidden-fish|Теневая акула|×200/);
  attr(view, "data-fish-stock-item", "fish_mirror_koi").props.onClick(); assert.deepEqual(selections, ["fish_mirror_koi"]);
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before);
});

test("a refrigerator class expands in place and clicking its species prepares only that stock", () => {
  hooks.reset(); const economy = controller(), before = structuredClone(economy.snapshot), props = { economy, initialTab: "fridge", onUpgrade() {}, onExplore() {} };
  let view = render(WorldPantryMenu, props); assert.equal(child(view, WorldFishStockList), undefined);
  attr(view, "data-guide-pantry-item", "fish_epic").props.onClick(); view = render(WorldPantryMenu, props);
  assert.equal(attr(view, "data-guide-pantry-item", "fish_epic").props["aria-expanded"], true);
  const list = child(view, WorldFishStockList); assert.equal(list.props.classId, "fish_epic");
  const rows = render(WorldFishStockList, list.props); attr(rows, "data-fish-stock-item", "fish_sturgeon").props.onClick();
  view = render(WorldPantryMenu, props); const sale = child(view, PantrySale);
  assert.equal(sale.props.itemId, "fish_epic"); assert.equal(sale.props.fishItemId, "fish_sturgeon");
  attr(render(WorldFishStockList, child(view, WorldFishStockList).props), "data-fish-stock-all").props.onClick();
  view = render(WorldPantryMenu, props); assert.equal(child(view, PantrySale).props.fishItemId, undefined, "All species returns directly to group sale");
  attr(view, "data-guide-pantry-item", "fish_epic").props.onClick(); assert.equal(child(render(WorldPantryMenu, props), WorldFishStockList), undefined);
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before, "no extra inventory or storage units exist for the disclosure");
});

test("the catch counter expands one class and its species choice reaches the Pleska sale form", () => {
  hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, catalog: economy.snapshot.catalog.fishing };
  let view = render(FishCounter, props); const classes = view.nodes.filter(node => node.props["aria-expanded"] !== undefined);
  classes.find(node => node.props["aria-controls"].endsWith("fish_epic")).props.onClick(); view = render(FishCounter, props);
  const list = child(view, WorldFishStockList); assert.equal(list.props.classId, "fish_epic");
  list.props.onSelect("fish_mirror_koi"); view = render(FishCounter, props);
  const trade = child(view, PleskFishTrade); assert.equal(trade.props.itemId, "fish_epic"); assert.equal(trade.props.fishItemId, "fish_mirror_koi");
  assert.equal(view.nodes.filter(node => node.props["data-plesk-fish-stock"]).length, 1); assert.deepEqual(economy.calls, []);
});

test("pantry sells the chosen species with class pricing, its exact stock limit and one receipt", () => {
  hooks.reset(); const economy = controller(), props = { economy, itemId: "fish_epic", fishItemId: "fish_sturgeon" };
  let view = render(PantrySale, props); assert.equal(input(view).props.max, 2); assert.match(text(view.tree), /Золотой осётр/);
  assert.equal(attr(view, "data-fish-sale-item").props["data-fish-sale-item"], "fish_sturgeon");
  button(view, "Всё").props.onClick(); view = render(PantrySale, props); button(view, "Продать торговцу").props.onClick(); button(view, "Продать торговцу").props.onClick();
  const item = economy.snapshot.catalog.items.find(item => item.id === "fish_epic");
  assert.deepEqual(economy.calls, [["sell", "fish_epic", 2, economyLocalSellPrice(item.baseSellPrice, 2, economy.snapshot.catalog.localBuyer, "fish_epic"), { fish_sturgeon: 2 }]]);
  assert.equal(economy.snapshot.inventory.fish_epic, 7); assert.equal(economy.snapshot.fishing.stock.fish_sturgeon, 2);
});

test("Pleska sells the chosen species with full class price and never consumes its neighbours", () => {
  hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, itemId: "fish_epic", fishItemId: "fish_mirror_koi" };
  let view = render(PleskFishTrade, props); assert.equal(input(view).props.max, 3); assert.match(text(view.tree), /Зеркальный кои/);
  button(view, "Все").props.onClick(); view = render(PleskFishTrade, props); const sell = view.nodes.find(node => node.props["aria-label"] === "Продать Зеркальный кои: 3");
  sell.props.onClick(); sell.props.onClick(); assert.deepEqual(economy.calls, [["sell_fish", "fish_epic", 3, 0, { fish_mirror_koi: 3 }]]);
  assert.equal(economy.snapshot.fishing.stock.fish_sturgeon, 2);
});

test("unidentified remainder has an honest label and its own exact quantity limit", () => {
  for (const Component of [PantrySale, PleskFishTrade]) {
    hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, itemId: "fish_epic", fishItemId: "fish_epic" };
    let view = render(Component, props); assert.equal(input(view).props.max, 2); assert.match(text(view.tree), /Без указания вида/);
    input(view).props.onChange({ target: { value: "3" } }); view = render(Component, props);
    const sell = Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "));
    assert.equal(sell.props.disabled, true); sell.props.onClick(); assert.deepEqual(economy.calls, []);
  }
});

test("group sale opens a fish selection before spending and forwards only its final chosen mix", () => {
  for (const Component of [PantrySale, PleskFishTrade]) {
    hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, itemId: "fish_epic" };
    let view = render(Component, props);
    const sell = Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "));
    sell.props.onClick(); view = render(Component, props); assert.deepEqual(economy.calls, []);
    let picker = child(view, WorldFishSelection); assert.ok(picker); assert.deepEqual(picker.props.requiredItems, { fish_epic: 1 }); assert.equal(picker.props.confirmLabel, "Продать");
    assert.match(picker.props.summary, /^1 шт\. · \d+ монет$/);
    picker.props.onClose(); assert.deepEqual(economy.calls, []);
    view = render(Component, props); assert.equal(child(view, WorldFishSelection), undefined);
    assert.equal(picker.props.onConfirm({ fish_mirror_koi: 1 }), false, "closed quote cannot sell from its captured callback");
    (Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "))).props.onClick();
    picker = child(render(Component, props), WorldFishSelection);
    assert.equal(picker.props.onConfirm({ fish_mirror_koi: 1 }), true);
    assert.equal(economy.calls[0][0], Component === PantrySale ? "sell" : "sell_fish");
    assert.deepEqual(economy.calls[0][4], { fish_mirror_koi: 1 });
  }
});

test("captured species sales reject changed owners, revisions, stock, price and transport state", () => {
  for (const Component of [PantrySale, PleskFishTrade]) for (const mutate of [
    economy => economy.snapshot.ownerPublicId = "other", economy => economy.snapshot.revision++,
    economy => economy.snapshot.fishing.stock.fish_sturgeon = 0,
    economy => { economy.snapshot.catalog.items.find(item => item.id === "fish_epic").baseSellPrice += 50;
      if (economy.snapshot.catalog.localBuyer?.unitPrices?.fish_epic) economy.snapshot.catalog.localBuyer.unitPrices.fish_epic += 50; },
    economy => economy.busy = true, economy => economy.uncertain = true, economy => economy.retryAt = now + 1000,
  ]) {
    hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, itemId: "fish_epic", fishItemId: "fish_sturgeon" };
    const view = render(Component, props), sell = Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "));
    mutate(economy); sell.props.onClick(); assert.deepEqual(economy.calls, []);
  }
});

test("an explicit controller refusal permits a species sale retry and then blocks duplicate commands", () => {
  for (const Component of [PantrySale, PleskFishTrade]) {
    hooks.reset(); const economy = controller(); economy.act = (...args) => { economy.calls.push(args); return economy.calls.length > 1; };
    const props = { economy, state: economy.snapshot, itemId: "fish_epic", fishItemId: "fish_sturgeon" }, view = render(Component, props);
    const sell = Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "));
    sell.props.onClick(); sell.props.onClick(); sell.props.onClick(); assert.equal(economy.calls.length, 2);
  }
});

test("ordinary pantry stock keeps its direct sale without a fish picker", () => {
  hooks.reset(); const economy = controller(), props = { economy, itemId: "wood" }, view = render(PantrySale, props);
  button(view, "Продать торговцу").props.onClick(); assert.equal(economy.calls.length, 1); assert.equal(economy.calls[0].length, 4);
  assert.equal(child(render(PantrySale, props), WorldFishSelection), undefined);
});

test("changed quantities reject both captured species buttons and captured group-sale confirmation", () => {
  for (const Component of [PantrySale, PleskFishTrade]) for (const exact of [true, false]) {
    hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, itemId: "fish_epic", ...(exact ? { fishItemId: "fish_sturgeon" } : {}) };
    let view = render(Component, props);
    const oldButton = Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "));
    let oldPicker;
    if (!exact) { oldButton.props.onClick(); view = render(Component, props); oldPicker = child(view, WorldFishSelection); }
    input(view).props.onChange({ target: { value: "2" } }); view = render(Component, props);
    oldButton.props.onClick(); if (oldPicker) assert.equal(oldPicker.props.onConfirm({ fish_sturgeon: 1 }), false);
    assert.deepEqual(economy.calls, [], "old quantity is never silently sent after the field changed");
    if (exact) (Component === PantrySale ? button(view, "Продать торговцу") : view.nodes.find(node => node.props["aria-label"]?.startsWith("Продать "))).props.onClick();
    else { const currentPicker = child(view, WorldFishSelection); assert.deepEqual(currentPicker.props.requiredItems, { fish_epic: 2 }); assert.equal(currentPicker.props.onConfirm({ fish_sturgeon: 2 }), true); }
    assert.equal(economy.calls.length, 1); assert.equal(economy.calls[0][2], 2); assert.deepEqual(economy.calls[0][4], { fish_sturgeon: 2 });
  }
});
