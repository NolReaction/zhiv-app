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
      if (["/ui/inventory/world-pantry-menu.tsx", "/ui/fishing/plesk-fishing-shop.tsx", "/ui/fishing/use-fishing-command.ts", "/ui/fishing/world-fish-selection.tsx", "/ui/fishing/fish-tap-feedback.tsx"].some(path => id.endsWith(path)))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }] });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldPantryMenu, PantrySale, PantryFishPopover, PantryFishClassRow } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { FishCounter, PleskFishTrade } = await vite.ssrLoadModule("/features/economy/ui/fishing/plesk-fishing-shop.tsx");
const { WorldFishStockList } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-fish-stock-list.tsx");
const { WorldFishSelection } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-fish-selection.tsx");
const { economyCatalog, economyFishingSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
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
const sessionControls = new WeakMap();
function render(component, props, frame = component.name) {
  hooks.render(frame); const tree = component(props); hooks.flush(); const nodes = elements(tree);
  if (component === PantryFishPopover) sessionControls.set(props, nodes.find(node => node.type === PantryFishClassRow)?.props);
  return { tree, nodes };
}
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

function fishSession(economy, extra = {}) {
  const props = { economy, classIds: ["fish_epic"], ...extra };
  return { props, get controls() { return sessionControls.get(props); } };
}
function fishElement() { return { isConnected: true, disabled: false, focus() {} }; }

test("fridge uses one nonmodal exact-species sale session and no group action", () => {
  hooks.reset(); const economy = controller(), before = structuredClone(economy.snapshot), props = { economy, initialTab: "fridge", onExplore() {} };
  const view = render(WorldPantryMenu, props), popup = child(view, PantryFishPopover); assert.ok(popup);
  let popupView = render(PantryFishPopover, popup.props);
  assert.equal(popupView.tree.props.open, false); assert.equal(popupView.tree.props.modal, false);
  const classes = popupView.nodes.filter(node => node.type === PantryFishClassRow);
  assert.deepEqual(classes.map(node => node.props.classId), ["fish_common", "fish_epic"]);
  const row = render(PantryFishClassRow, classes[1].props);
  assert.deepEqual(row.nodes.filter(node => node.props["data-pantry-fish-card"]).map(node => node.props["data-pantry-fish-card"]), ["fish_sturgeon", "fish_mirror_koi", "fish_epic"]);
  assert.doesNotMatch(text(row.tree), /Все виды/);
  const element = fishElement(); attr(row, "data-pantry-fish-card", "fish_sturgeon").props.onClick({ currentTarget: element });
  popupView = render(PantryFishPopover, popup.props);
  const content = attr(popupView, "data-pantry-fish-popover"); assert.equal(content.props["data-pantry-fish-popover"], "fish_epic");
  assert.equal(content.props["data-pantry-fish-owner"], economy.snapshot.ownerPublicId);
  assert.equal(content.props.collisionPadding, 12); assert.equal(content.props.sideOffset, 8);
  assert.equal(child(popupView, WorldFishStockList), undefined);
  const sale = child(popupView, PantrySale);
  assert.equal(sale.props.itemId, "fish_epic"); assert.equal(sale.props.fishItemId, "fish_sturgeon"); assert.equal(sale.props.compact, true);
  assert.equal(sale.props.quantityControl.text, "1");
  assert.equal(popupView.nodes.filter(node => node.props.virtualRef)[0].props.virtualRef.current, element);
  assert.equal(child(view, PantrySale), undefined, "fish sales never create an inline inventory section");
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before);
});

test("rapid repeated taps add one until the real species limit and switching resets to one", () => {
  hooks.reset(); const economy = controller(), session = fishSession(economy);
  let view = render(PantryFishPopover, session.props); const element = fishElement();
  const tap = session.controls.onSelectFish;
  tap("fish_epic", "fish_mirror_koi", element); tap("fish_epic", "fish_mirror_koi", element); tap("fish_epic", "fish_mirror_koi", element);
  view = render(PantryFishPopover, session.props);
  assert.equal(child(view, PantrySale).props.quantityControl.text, "3");
  assert.equal(child(view, PantrySale).props.tapFeedback.kind, "added");
  session.controls.onSelectFish("fish_epic", "fish_mirror_koi", element); view = render(PantryFishPopover, session.props);
  assert.equal(child(view, PantrySale).props.quantityControl.text, "3"); assert.equal(child(view, PantrySale).props.tapFeedback.kind, "limit");
  session.controls.onSelectFish("fish_epic", "fish_sturgeon", element); view = render(PantryFishPopover, session.props);
  assert.equal(view.tree.props.open, true); assert.equal(child(view, PantrySale).props.fishItemId, "fish_sturgeon");
  assert.equal(child(view, PantrySale).props.quantityControl.text, "1");
  session.controls.onSelectFish("fish_epic", "fish_epic", element); view = render(PantryFishPopover, session.props);
  const sale = child(view, PantrySale); assert.equal(sale.props.fishItemId, "fish_epic"); assert.equal(sale.props.quantityControl.text, "1");
  const form = render(PantrySale, sale.props); button(form, "Продать").props.onClick();
  assert.deepEqual(economy.calls[0][4], { fish_epic: 1 }, "unknown remainder stays an explicit stock selection");
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

test("Escape, real outside and close restore the latest species focus without selling", () => {
  for (const way of ["escape", "outside", "close"]) {
    hooks.reset(); const economy = controller(), focus = [], notices = [], session = fishSession(economy, { onFishSaleOpenChange: value => notices.push(value) });
    let view = render(PantryFishPopover, session.props);
    const element = { isConnected: true, disabled: false, focus: options => focus.push(["fish", options]) };
    const host = attr(view, "data-pantry-fish-session"); host.props.ref.current = { isConnected: true, contains() { return false; } };
    session.controls.onSelectFish("fish_epic", "fish_sturgeon", element); view = render(PantryFishPopover, session.props);
    const content = attr(view, "data-pantry-fish-popover"), close = view.nodes.find(node => node.type === "button" && node.props["aria-label"] === "Закрыть выбор рыбы");
    close.props.ref.current = { focus: options => focus.push(["close", options]) };
    content.props.onOpenAutoFocus({ preventDefault() {} });
    let stopped = 0, blocked = 0;
    if (way === "escape") content.props.onEscapeKeyDown({ stopPropagation() { stopped++; } });
    if (way === "outside") content.props.onInteractOutside({ target: { closest() { return null; } }, preventDefault() { blocked++; } });
    view.tree.props.onOpenChange(false); render(PantryFishPopover, session.props);
    content.props.onCloseAutoFocus({ preventDefault() {} });
    assert.equal(stopped, way === "escape" ? 1 : 0); assert.equal(blocked, 0);
    assert.deepEqual(focus, [["fish", { preventScroll: true }]], "opening keeps the stock card focused for repeated keyboard activation");
    assert.deepEqual(notices, [false, true, false]); assert.deepEqual(economy.calls, []);
  }
});

test("fish cards inside the same pantry switch without outside dismissal; unrelated cards do not", () => {
  hooks.reset(); const economy = controller(), session = fishSession(economy);
  let view = render(PantryFishPopover, session.props);
  const inside = { closest() { return {}; } }, unrelated = { closest() { return {}; } };
  attr(view, "data-pantry-fish-session").props.ref.current = { isConnected: true, contains(target) { return target === inside; } };
  session.controls.onSelectFish("fish_epic", "fish_sturgeon", fishElement()); view = render(PantryFishPopover, session.props);
  const content = attr(view, "data-pantry-fish-popover"); let blocked = 0;
  content.props.onInteractOutside({ target: inside, preventDefault() { blocked++; } }); assert.equal(blocked, 1);
  content.props.onInteractOutside({ target: unrelated, preventDefault() { blocked++; } }); assert.equal(blocked, 1);
  session.controls.onSelectFish("fish_epic", "fish_mirror_koi", fishElement()); view = render(PantryFishPopover, session.props);
  assert.equal(view.tree.props.open, true); assert.equal(child(view, PantrySale).props.fishItemId, "fish_mirror_koi");
  const sale = child(view, PantrySale); sale.props.onFishPickerOpenChange(true);
  content.props.onInteractOutside({ target: unrelated, preventDefault() { blocked++; } }); assert.equal(blocked, 2);
  let blockedEscape = 0; content.props.onEscapeKeyDown({ stopPropagation() {}, preventDefault() { blockedEscape++; } }); assert.equal(blockedEscape, 1);
  sale.props.onFishPickerOpenChange(false); assert.deepEqual(economy.calls, []);
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

test("dismissal refuses detached, disabled, removed-host or different-owner focus targets", () => {
  for (const change of ["detached", "disabled", "host", "owner"]) {
    hooks.reset(); const economy = controller(), focuses = [], session = fishSession(economy);
    let view = render(PantryFishPopover, session.props);
    const element = { isConnected: true, disabled: false, focus: options => focuses.push(options) }, host = { isConnected: true };
    attr(view, "data-pantry-fish-session").props.ref.current = host;
    session.controls.onSelectFish("fish_epic", "fish_sturgeon", element); view = render(PantryFishPopover, session.props);
    const content = attr(view, "data-pantry-fish-popover");
    if (change === "detached") element.isConnected = false;
    if (change === "disabled") element.disabled = true;
    if (change === "host") host.isConnected = false;
    if (change === "owner") economy.snapshot.ownerPublicId = "other";
    content.props.onCloseAutoFocus({ preventDefault() {} }); assert.deepEqual(focuses, [], change); assert.deepEqual(economy.calls, []);
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

test("an exhausted species closes its layer and releases the guide without substituting neighbours", () => {
  hooks.reset(); const economy = controller(), notices = [], session = fishSession(economy, { onFishSaleOpenChange: value => notices.push(value) });
  render(PantryFishPopover, session.props); session.controls.onSelectFish("fish_epic", "fish_sturgeon", fishElement());
  let view = render(PantryFishPopover, session.props); const sale = child(view, PantrySale);
  const form = render(PantrySale, sale.props), oldSell = button(form, "Продать");
  economy.snapshot.fishing.stock.fish_sturgeon = 0; view = render(PantryFishPopover, session.props);
  assert.equal(view.tree.props.open, false); assert.equal(child(view, PantrySale), undefined);
  assert.equal(sale.props.quantityControl.isCurrent(), false); oldSell.props.onClick();
  assert.deepEqual(notices, [false, true, false]); assert.deepEqual(economy.calls, []); assert.equal(economy.snapshot.fishing.stock.fish_mirror_koi, 3);
  economy.snapshot.fishing.stock.fish_sturgeon = 2; view = render(PantryFishPopover, session.props);
  assert.equal(view.tree.props.open, false, "newly received stock cannot reopen an expired sale session");
});

test("tap limits honor wallet headroom and batch size, including a zero-capacity first tap", () => {
  for (const cap of [0, 1, 10000]) {
    hooks.reset(); const economy = controller(), state = economy.snapshot;
    const unit = state.catalog.localBuyer.unitPrices.fish_epic;
    if (cap < 2) state.wallet.coins = ECONOMY_MAX_BALANCE - unit * cap;
    else { state.inventory.fish_epic = 20000; state.fishing.stock = { fish_sturgeon: 20000 }; }
    const session = fishSession(economy); render(PantryFishPopover, session.props);
    session.controls.onSelectFish("fish_epic", "fish_sturgeon", fishElement());
    let view = render(PantryFishPopover, session.props), sale = child(view, PantrySale);
    if (cap === 10000) { sale.props.quantityControl.onChange("10000", "manual"); view = render(PantryFishPopover, session.props); }
    session.controls.onSelectFish("fish_epic", "fish_sturgeon", fishElement()); view = render(PantryFishPopover, session.props); sale = child(view, PantrySale);
    assert.equal(Number(sale.props.quantityControl.text), cap);
    assert.equal(sale.props.tapFeedback.kind, "limit"); assert.deepEqual(economy.calls, []);
  }
});

test("stale sale and tap handlers refuse a switched species, changed quantity, closed session or owner", () => {
  for (const change of ["species", "quantity", "closed", "owner", "revision", "busy", "uncertain", "retry"]) {
    hooks.reset(); const economy = controller(), session = fishSession(economy);
    render(PantryFishPopover, session.props); const oldTap = session.controls.onSelectFish;
    oldTap("fish_epic", "fish_sturgeon", fishElement()); let view = render(PantryFishPopover, session.props);
    const oldForm = render(PantrySale, child(view, PantrySale).props), oldSell = button(oldForm, "Продать");
    if (change === "species") session.controls.onSelectFish("fish_epic", "fish_mirror_koi", fishElement());
    if (change === "quantity") session.controls.onSelectFish("fish_epic", "fish_sturgeon", fishElement());
    if (change === "closed") view.tree.props.onOpenChange(false);
    if (change === "owner") economy.snapshot.ownerPublicId = "other";
    if (change === "revision") economy.snapshot.revision++;
    if (change === "busy") economy.busy = true;
    if (change === "uncertain") economy.uncertain = true;
    if (change === "retry") economy.retryAt = now + 1000;
    oldSell.props.onClick(); assert.deepEqual(economy.calls, [], change);
    if (["owner", "revision", "busy", "uncertain", "retry"].includes(change)) {
      oldTap("fish_epic", "fish_mirror_koi", fishElement()); view = render(PantryFishPopover, session.props);
      if (change === "owner") assert.equal(view.tree.props.open, false);
      else assert.equal(child(view, PantrySale).props.fishItemId, "fish_sturgeon", change);
    }
  }
});


test("keyboard activation keeps the same fish button and ArrowDown reaches quantity without a sale", () => {
  hooks.reset(); const economy = controller(), session = fishSession(economy);
  let view = render(PantryFishPopover, session.props);
  const element = fishElement(); session.controls.onSelectFish("fish_epic", "fish_mirror_koi", element);
  view = render(PantryFishPopover, session.props);
  const content = attr(view, "data-pantry-fish-popover"); let prevented = 0, focused = 0;
  content.props.onOpenAutoFocus({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  content.props.ref.current = { querySelector(selector) { assert.equal(selector, "input"); return { focus() { focused++; } }; } };
  const row = render(PantryFishClassRow, child(view, PantryFishClassRow).props);
  const card = attr(row, "data-pantry-fish-card", "fish_mirror_koi");
  assert.equal(card.props["aria-controls"], content.props.id);
  card.props.onClick({ currentTarget: element }); card.props.onClick({ currentTarget: element });
  view = render(PantryFishPopover, session.props); assert.equal(child(view, PantrySale).props.quantityControl.text, "3");
  card.props.onKeyDown({ key: "ArrowDown", preventDefault() { prevented++; } }); assert.equal(focused, 1);
  card.props.onKeyDown({ key: "Enter", preventDefault() { assert.fail("native button activation stays intact"); } });
  assert.equal(prevented, 2); assert.deepEqual(economy.calls, []);
});


test("unstable owner callbacks do not reopen, close or renotify an unchanged sale", () => {
  hooks.reset(); const economy = controller(), notices = [], session = fishSession(economy, { onFishSaleOpenChange: value => notices.push(value) });
  render(PantryFishPopover, session.props); session.controls.onSelectFish("fish_epic", "fish_sturgeon", fishElement()); render(PantryFishPopover, session.props);
  session.props.onFishSaleOpenChange = value => notices.push(value); render(PantryFishPopover, session.props);
  assert.deepEqual(notices, [false, true]); assert.deepEqual(economy.calls, []);
});
