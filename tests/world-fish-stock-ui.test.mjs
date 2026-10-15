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
const { WorldPantryMenu, PantrySale, PantryFishPopover, PantryFishClassRow } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
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

test("refrigerator class rails open a selected species directly and retain a separate group-sale action", () => {
  hooks.reset(); const economy = controller(), before = structuredClone(economy.snapshot), props = { economy, initialTab: "fridge", onUpgrade() {}, onExplore() {} };
  let view = render(WorldPantryMenu, props); assert.equal(child(view, WorldFishStockList), undefined);
  const classes = view.nodes.filter(node => node.type === PantryFishClassRow);
  assert.deepEqual(classes.map(node => node.props.classId), ["fish_common", "fish_epic"]);
  const row = render(PantryFishClassRow, classes[1].props);
  assert.deepEqual(row.nodes.filter(node => node.props["data-pantry-fish-card"]).map(node => node.props["data-pantry-fish-card"]), ["fish_sturgeon", "fish_mirror_koi", "fish_epic"]);
  const popup = row.nodes.find(node => node.type === PantryFishPopover && node.props.initialFishId === "fish_sturgeon"); assert.ok(popup);
  let popupView = render(PantryFishPopover, popup.props); assert.equal(popupView.tree.props.open, false); assert.equal(popupView.tree.props.modal, true);
  popupView.tree.props.onOpenChange(true); popupView = render(PantryFishPopover, popup.props);
  const content = attr(popupView, "data-pantry-fish-popover"); assert.equal(content.props["data-pantry-fish-popover"], "fish_epic");
  assert.equal(content.props.collisionPadding, 12); assert.equal(content.props.sideOffset, 8);
  assert.equal(child(popupView, WorldFishStockList), undefined, "the clicked species is already chosen without a second selection list");
  const sale = child(popupView, PantrySale);
  assert.equal(sale.props.itemId, "fish_epic"); assert.equal(sale.props.fishItemId, "fish_sturgeon"); assert.equal(sale.props.compact, true);
  const group = row.nodes.find(node => node.type === PantryFishPopover && node.props.initialFishId === undefined);
  let groupView = render(PantryFishPopover, group.props, "group"); groupView.tree.props.onOpenChange(true); groupView = render(PantryFishPopover, group.props, "group");
  assert.equal(child(groupView, WorldFishStockList).props.classId, "fish_epic");
  assert.equal(child(groupView, PantrySale).props.fishItemId, undefined, "All species opens the independent group choice");
  view = render(WorldPantryMenu, props);
  assert.deepEqual(view.nodes.filter(node => node.type === PantryFishClassRow).map(node => node.props.classId), ["fish_common", "fish_epic"]);
  assert.equal(child(view, PantrySale), undefined, "fish sales never create an inline inventory section");
  assert.equal(view.nodes.some(node => node.props["data-expanded"]), false);
  popupView.tree.props.onOpenChange(false); assert.equal(child(render(PantryFishPopover, popup.props), WorldFishStockList), undefined);
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before, "no extra inventory or storage units exist for the disclosure");
});

test("the catch counter expands one class and its species choice reaches the Pleska sale form", () => {
  hooks.reset(); const economy = controller(), props = { economy, state: economy.snapshot, catalog: economy.snapshot.catalog.fishing };
  let view = render(FishCounter, props); const classes = view.nodes.filter(node => node.props["aria-expanded"] !== undefined);
  assert.equal(child(view, WorldFishStockList), undefined); assert.equal(child(view, PleskFishTrade), undefined);
  assert.ok(classes.every(node => node.props["aria-expanded"] === false), "every catch class starts collapsed");
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

test("closing the fish popover by Escape, outside or close restores focus without selling", () => {
  for (const way of ["escape", "outside", "close"]) {
    hooks.reset(); const economy = controller(), focus = [], props = { economy, classId: "fish_epic", children: createElement("button", null, "Эпическая рыба") };
    let view = render(PantryFishPopover, props);
    const trigger = view.nodes.find(node => node.props.asChild && node.props.ref);
    trigger.props.ref.current = { isConnected: true, disabled: false, focus: options => focus.push(["trigger", options]) };
    view.tree.props.onOpenChange(true); view = render(PantryFishPopover, props);
    const content = attr(view, "data-pantry-fish-popover"), close = view.nodes.find(node => node.type === "button" && node.props["aria-label"] === "Закрыть выбор рыбы");
    close.props.ref.current = { focus: options => focus.push(["close", options]) };
    content.props.onOpenAutoFocus({ preventDefault() {} });
    let escaped = 0, blockedOutside = 0;
    if (way === "escape") content.props.onEscapeKeyDown({ stopPropagation() { escaped++; } });
    if (way === "outside") content.props.onInteractOutside({ preventDefault() { blockedOutside++; } });
    view.tree.props.onOpenChange(false); render(PantryFishPopover, props);
    content.props.onCloseAutoFocus({ preventDefault() {} });
    assert.equal(escaped, way === "escape" ? 1 : 0); assert.equal(blockedOutside, 0);
    assert.deepEqual(focus, [["close", { preventScroll: true }], ["trigger", { preventScroll: true }]]); assert.deepEqual(economy.calls, []);
  }
});

test("the nested fish confirmation keeps the popover open until the upper dialog closes", () => {
  hooks.reset(); const economy = controller(), props = { economy, classId: "fish_epic", children: createElement("button", null, "Эпическая рыба") };
  let view = render(PantryFishPopover, props); view.tree.props.onOpenChange(true); view = render(PantryFishPopover, props);
  const sale = child(view, PantrySale), content = attr(view, "data-pantry-fish-popover");
  let form = render(PantrySale, sale.props); button(form, "Продать").props.onClick();
  form = render(PantrySale, sale.props); const picker = child(form, WorldFishSelection); assert.ok(picker);
  let blocked = 0; content.props.onInteractOutside({ preventDefault() { blocked++; } }); assert.equal(blocked, 1);
  let blockedEscape = 0; content.props.onEscapeKeyDown({ stopPropagation() {}, preventDefault() { blockedEscape++; } }); assert.equal(blockedEscape, 1, "Escape cannot also dismiss the lower layer");
  picker.props.onClose(); render(PantrySale, sale.props);
  content.props.onInteractOutside({ preventDefault() { blocked++; } }); assert.equal(blocked, 1, "ordinary outside dismissal resumes");
  assert.equal(render(PantryFishPopover, props).tree.props.open, true, "closing the upper picker keeps its species panel");
  assert.deepEqual(economy.calls, []);
});

test("compact fish sales never scroll the inventory and omit repeated class explanations", () => {
  hooks.reset(); const economy = controller(), props = { economy, itemId: "fish_epic", compact: true };
  let form = render(PantrySale, props), scrolls = 0;
  form.tree.props.ref.current = { scrollIntoView() { scrolls++; } };
  form = render(PantrySale, { ...props, itemId: "fish_common" });
  assert.equal(scrolls, 0); assert.equal(form.nodes.filter(node => node.type === "h3").length, 0);
  assert.doesNotMatch(text(form.tree), /уценкой|округляется вниз|Плёска купит дороже/);
  assert.match(text(form.tree), /В запасе 5/); assert.match(text(form.tree), /монет\/шт\./);
});

test("popover dismissal never focuses a removed trigger or another owner or fish class", () => {
  for (const change of ["unmounted", "detached", "owner", "class", "species"]) {
    hooks.reset(); const economy = controller(), focuses = [], props = { economy, classId: "fish_epic", children: createElement("button", null, "Рыба") };
    let view = render(PantryFishPopover, props); const trigger = view.nodes.find(node => node.props.asChild && node.props.ref);
    const element = { isConnected: true, disabled: false, focus: options => focuses.push(options) }; trigger.props.ref.current = element;
    view.tree.props.onOpenChange(true); view = render(PantryFishPopover, props); const content = attr(view, "data-pantry-fish-popover");
    if (change === "unmounted") trigger.props.ref.current = null;
    if (change === "detached") element.isConnected = false;
    if (change === "owner") economy.snapshot.ownerPublicId = "another-owner";
    if (change === "class") { props.classId = "fish_common"; render(PantryFishPopover, props); }
    if (change === "species") { props.initialFishId = "fish_mirror_koi"; render(PantryFishPopover, props); }
    content.props.onCloseAutoFocus({ preventDefault() {} });
    assert.deepEqual(focuses, [], change); assert.deepEqual(economy.calls, []);
  }
});

test("horizontal rail hints follow actual clipped edges without intercepting vertical scrolling or selling", () => {
  hooks.reset(); const economy = controller(), props = { economy, classId: "fish_epic" };
  let view = render(PantryFishClassRow, props), rail = attr(view, "data-pantry-fish-rail");
  const element = { scrollLeft: 0, scrollWidth: 282, clientWidth: 220 };
  rail.props.ref.current = element; rail.props.onScroll({ currentTarget: element }); view = render(PantryFishClassRow, props);
  assert.deepEqual(view.nodes.filter(node => node.props["data-rail-edge"]).map(node => node.props["data-rail-edge"]), ["right"]);
  element.scrollLeft = 30; attr(view, "data-pantry-fish-rail").props.onScroll({ currentTarget: element }); view = render(PantryFishClassRow, props);
  assert.deepEqual(view.nodes.filter(node => node.props["data-rail-edge"]).map(node => node.props["data-rail-edge"]), ["left", "right"]);
  element.scrollLeft = 62; attr(view, "data-pantry-fish-rail").props.onScroll({ currentTarget: element }); view = render(PantryFishClassRow, props);
  assert.deepEqual(view.nodes.filter(node => node.props["data-rail-edge"]).map(node => node.props["data-rail-edge"]), ["left"]);
  element.scrollLeft = 0; element.clientWidth = 400; attr(view, "data-pantry-fish-rail").props.onScroll({ currentTarget: element }); view = render(PantryFishClassRow, props);
  assert.equal(view.nodes.some(node => node.props["data-rail-edge"]), false); assert.deepEqual(economy.calls, []);
});

test("a selected species disappearing never silently substitutes another fish in its sale popover", () => {
  hooks.reset(); const economy = controller(), props = { economy, classId: "fish_epic", initialFishId: "fish_sturgeon", children: createElement("button", null, "Золотой осётр") };
  let view = render(PantryFishPopover, props); view.tree.props.onOpenChange(true); view = render(PantryFishPopover, props);
  assert.equal(child(view, PantrySale).props.fishItemId, "fish_sturgeon");
  economy.snapshot.fishing.stock.fish_sturgeon = 0; view = render(PantryFishPopover, props);
  const sale = child(view, PantrySale); assert.equal(sale.props.fishItemId, "fish_sturgeon");
  const form = render(PantrySale, sale.props); assert.equal(button(form, "Продать").props.disabled, true);
  button(form, "Продать").props.onClick(); assert.deepEqual(economy.calls, []);
  assert.equal(economy.snapshot.fishing.stock.fish_mirror_koi, 3);
});
