import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "zhiv-plesk-row-quantity-"));
const hookId = "virtual:plesk-row-quantity-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "plesk-row-quantity-hooks", enforce: "pre",
    resolveId(id) { if (id === hookId) return `\0${id}`; },
    load(id) { if (id === `\0${hookId}`) return `
      let frames = new Map(), slots = [], cursor = 0, effects = [];
      export function reset() { frames.clear(); }
      export function render(key) { slots = frames.get(key) ?? []; frames.set(key, slots); cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useId() { return useRef('plesk-row-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) { const old = useRef(null); if (!old.current || dependencies.some((value, i) => !Object.is(value, old.current[i]))) { old.current = dependencies; effects.push(effect); } }
      export const useLayoutEffect = useEffect;
    `; },
    transform(source, id) { if (["/ui/fishing/plesk-fishing-shop.tsx", "/ui/fishing/use-fishing-command.ts", "/ui/fishing/fish-tap-feedback.tsx"].some(path => id.endsWith(path))) return source.replace('from "react";', `from "${hookId}";`); },
  }] });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hookId);
const { FishCounter, PleskFishTrade } = await vite.ssrLoadModule("/features/economy/ui/fishing/plesk-fishing-shop.tsx");
const { WorldFishStockList } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-fish-stock-list.tsx");
const { economyCatalog, economyFishingSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-10-15T07:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "quantity-owner", revision: 12, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 10000, pearls: 500 }, inventory: { fish_common: 5, fish_epic: 12 },
    fishing: economyFishingSchema.parse({ catches: { fish_sturgeon: 200 }, stock: { fish: 1, fish_sturgeon: 3, fish_mirror_koi: 6 } }),
    buildings: { home: 5, warehouse: 10 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, ...overrides };
  const calls = [];
  return { snapshot: { ...state, storage: economyStorage(state) }, now, retryAt: 0, busy: false, uncertain: false, error: null, calls,
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
const input = view => view.nodes.find(node => node.type === "input");
function counter(economy = controller()) {
  hooks.reset(); const props = { economy, state: economy.snapshot, catalog: economy.snapshot.catalog.fishing };
  let view;
  const draw = () => { view = render(FishCounter, props); return view; };
  const trade = () => { draw(); const element = child(view, PleskFishTrade); assert.ok(element); return render(PleskFishTrade, element.props, "same-trade-instance"); };
  const rows = () => { draw(); const list = child(view, WorldFishStockList); assert.ok(list); return render(WorldFishStockList, list.props); };
  const tap = id => { const row = attr(rows(), "data-fish-stock-item", id); assert.ok(row); row.props.onClick(); };
  const open = (id = "fish_epic") => { draw(); const card = view.nodes.find(node => node.props["aria-controls"]?.endsWith(id)); assert.ok(card); card.props.onClick(); draw(); };
  draw(); return { economy, props, draw, trade, rows, tap, open };
}

test("Pleska starts collapsed; the first species tap selects one and repeated taps add without selling", () => {
  const view = counter(), before = structuredClone(view.economy.snapshot);
  assert.equal(child(view.draw(), PleskFishTrade), undefined); view.open();
  view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "1");
  view.tap("fish_mirror_koi"); view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "3");
  assert.equal(child(view.draw(), PleskFishTrade).key, "fish_epic", "row taps retain the same trade component identity");
  assert.deepEqual(view.economy.calls, []); assert.deepEqual(view.economy.snapshot, before);
});

test("multiple row events in one frame accumulate while another species starts a new quantity of one", () => {
  const view = counter(); view.open();
  const list = child(view.draw(), WorldFishStockList);
  list.props.onSelect("fish_mirror_koi"); list.props.onSelect("fish_mirror_koi"); list.props.onSelect("fish_mirror_koi");
  assert.equal(input(view.trade()).props.value, "3");
  list.props.onSelect("fish_sturgeon"); assert.equal(input(view.trade()).props.value, "1");
  assert.equal(child(view.draw(), PleskFishTrade).props.fishItemId, "fish_sturgeon");
  view.tap("fish_sturgeon"); assert.equal(input(view.trade()).props.value, "2");
});

test("manual input, All and repeated row taps edit the same draft up to exact species stock", () => {
  const view = counter(); view.open(); view.tap("fish_mirror_koi");
  input(view.trade()).props.onChange({ target: { value: "3" } }); view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "4");
  const all = view.trade().nodes.find(node => node.type === "button" && text(node) === "Все"); assert.ok(all); all.props.onClick();
  assert.equal(input(view.trade()).props.value, "6"); view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "6");
  view.tap("fish_sturgeon"); assert.equal(input(view.trade()).props.value, "1"); assert.equal(input(view.trade()).props.max, 3);
  assert.deepEqual(view.economy.calls, []);
});

test("row increments respect class batch and remaining wallet capacity without changing class prices", () => {
  for (const [kind, maximum] of [["wallet", 2], ["batch", 3]]) {
    const economy = controller(), price = economy.snapshot.catalog.items.find(item => item.id === "fish_epic").baseSellPrice;
    if (kind === "wallet") economy.snapshot.wallet.coins = ECONOMY_MAX_BALANCE - maximum * price;
    else economy.snapshot.catalog.maxBatch = maximum;
    const view = counter(economy); view.open();
    for (let i = 0; i < 8; i++) view.tap("fish_mirror_koi");
    const sale = view.trade(); assert.equal(input(sale).props.value, String(maximum)); assert.equal(input(sale).props.max, maximum);
    const sell = sale.nodes.find(node => node.props["aria-label"] === `Продать Зеркальный кои: ${maximum}`); assert.ok(sell); sell.props.onClick(); sell.props.onClick();
    assert.deepEqual(economy.calls, [["sell_fish", "fish_epic", maximum, 0, { fish_mirror_koi: maximum }]]);
  }
});

test("unidentified remainder has its own tap quantity and all species resets the general sale to one", () => {
  const view = counter(); view.open(); view.tap("fish_epic"); view.tap("fish_epic");
  assert.equal(input(view.trade()).props.value, "2"); assert.equal(input(view.trade()).props.max, 3);
  attr(view.rows(), "data-fish-stock-all").props.onClick();
  assert.equal(child(view.draw(), PleskFishTrade).props.fishItemId, undefined); assert.equal(input(view.trade()).props.value, "1");
  const sell = view.trade().nodes.find(node => node.props["aria-label"] === "Продать Эпическая рыба: 1"); assert.ok(sell); sell.props.onClick();
  assert.deepEqual(view.economy.calls, [], "general sale still requires an explicit fish-selection confirmation");
});

test("unrelated timer and confirmed revision renders keep the quantity draft instead of resetting it", () => {
  const view = counter(); view.open(); view.tap("fish_mirror_koi"); view.tap("fish_mirror_koi");
  for (const changed of [
    () => { view.economy.now += 1000; },
    () => { view.economy.snapshot = { ...view.economy.snapshot, revision: 13 }; view.props.state = view.economy.snapshot; },
  ]) { changed(); view.draw(); assert.equal(input(view.trade()).props.value, "2"); }
  view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "3"); assert.deepEqual(view.economy.calls, []);
});

test("row handlers reject busy, uncertain, cooldown and changed owner or revision snapshots", () => {
  for (const mutate of [
    view => { view.economy.busy = true; }, view => { view.economy.uncertain = true; }, view => { view.economy.retryAt = now + 1; },
    view => { view.economy.snapshot = { ...view.economy.snapshot, ownerPublicId: "OTHER" }; },
    view => { view.economy.snapshot = { ...view.economy.snapshot, revision: 99 }; },
  ]) {
    const view = counter(); view.open(); view.tap("fish_mirror_koi"); const old = attr(view.rows(), "data-fish-stock-item", "fish_mirror_koi");
    mutate(view); old.props.onClick(); view.draw(); assert.equal(input(view.trade()).props.value, "1");
    const list = child(view.draw(), WorldFishStockList); assert.equal(list.props.disabled, true); assert.deepEqual(view.economy.calls, []);
  }
});

test("removed, unknown, non-owned and zero-price-cap rows cannot increment a retained handler", () => {
  for (const mutate of [
    view => { view.economy.snapshot.fishing.stock.fish_mirror_koi = 0; },
    view => { view.economy.snapshot.inventory.fish_epic = 0; },
    view => { view.economy.snapshot.wallet.coins = ECONOMY_MAX_BALANCE; },
  ]) {
    const view = counter(); view.open(); view.tap("fish_mirror_koi"); const list = child(view.draw(), WorldFishStockList);
    mutate(view); list.props.onSelect("fish_mirror_koi");
    assert.equal(child(view.draw(), PleskFishTrade)?.props.quantityControl.value ?? "1", "1"); assert.deepEqual(view.economy.calls, []);
  }
  const view = counter(); view.open(); view.tap("fish_mirror_koi"); const list = child(view.draw(), WorldFishStockList);
  list.props.onSelect("fish_shark"); list.props.onSelect("unknown_fish"); assert.equal(input(view.trade()).props.value, "1");
});

test("stock decrease clamps the next tap; a previous species or quantity cannot authorize a stale sale", () => {
  const view = counter(); view.open(); view.tap("fish_mirror_koi"); input(view.trade()).props.onChange({ target: { value: "5" } });
  const old = view.trade().nodes.find(node => node.props["aria-label"] === "Продать Зеркальный кои: 5"); assert.ok(old);
  view.economy.snapshot.fishing.stock.fish_mirror_koi = 2; view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "2");
  old.props.onClick(); assert.deepEqual(view.economy.calls, []);
  const beforeSwitch = view.trade().nodes.find(node => node.props["aria-label"] === "Продать Зеркальный кои: 2");
  view.tap("fish_sturgeon"); view.trade(); beforeSwitch.props.onClick(); assert.deepEqual(view.economy.calls, []);
});

test("single species starts at one and a deliberate first tap does not count twice", () => {
  const economy = controller(); economy.snapshot.inventory.fish_epic = 6; economy.snapshot.fishing.stock = { fish_mirror_koi: 6 };
  const view = counter(economy); view.open(); assert.equal(input(view.trade()).props.value, "1");
  view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "1");
  view.tap("fish_mirror_koi"); assert.equal(input(view.trade()).props.value, "2");
});

test("a disappeared selected species never transfers its amount to another remaining species", () => {
  const view = counter(); view.open(); view.tap("fish_mirror_koi"); view.tap("fish_mirror_koi");
  assert.equal(input(view.trade()).props.value, "2");
  view.economy.snapshot.fishing.stock = { fish_sturgeon: 3 }; view.economy.snapshot.inventory.fish_epic = 3;
  assert.equal(child(view.draw(), PleskFishTrade).props.fishItemId, "fish_sturgeon");
  assert.equal(input(view.trade()).props.value, "1"); assert.deepEqual(view.economy.calls, []);
});

test("every genuine species increment gets a fresh plus-one event shared by its artwork and quantity", () => {
  const view = counter(); view.open();
  for (let quantity = 1; quantity <= 3; quantity++) {
    view.tap("fish_mirror_koi");
    const event = child(view.draw(), WorldFishStockList).props.feedback;
    assert.equal(event.kind, "added"); assert.equal(event.quantity, quantity); assert.equal(event.itemId, "fish_mirror_koi");
    assert.equal(event.sequence, quantity);
    assert.equal(child(view.draw(), PleskFishTrade).props.quantityFeedback, event);
    assert.equal(input(view.trade()).props.value, String(quantity));
  }
  assert.deepEqual(view.economy.calls, []);
});

test("stock and wallet caps produce limit feedback instead of a fake increment", () => {
  for (const maximum of [2, 6]) {
    const economy = controller(), price = economy.snapshot.catalog.items.find(item => item.id === "fish_epic").baseSellPrice;
    if (maximum === 2) economy.snapshot.wallet.coins = ECONOMY_MAX_BALANCE - 2 * price;
    const view = counter(economy); view.open();
    for (let index = 0; index < maximum; index++) view.tap("fish_mirror_koi");
    const before = child(view.draw(), WorldFishStockList).props.feedback;
    view.tap("fish_mirror_koi");
    const capped = child(view.draw(), WorldFishStockList).props.feedback;
    assert.equal(capped.kind, "limit"); assert.equal(capped.sequence, before.sequence + 1); assert.equal(capped.quantity, maximum);
    assert.equal(input(view.trade()).props.value, String(maximum));
    view.tap("fish_mirror_koi"); assert.equal(child(view.draw(), WorldFishStockList).props.feedback.sequence, capped.sequence + 1);
    assert.deepEqual(economy.calls, []);
  }
});

test("manual values feed genuine row feedback while a typed over-limit quantity is clamped without plus one", () => {
  const view = counter(); view.open(); view.tap("fish_mirror_koi");
  input(view.trade()).props.onChange({ target: { value: "3" } }); view.tap("fish_mirror_koi");
  assert.equal(child(view.draw(), WorldFishStockList).props.feedback.kind, "added");
  assert.equal(child(view.draw(), WorldFishStockList).props.feedback.quantity, 4);
  input(view.trade()).props.onChange({ target: { value: "20" } }); view.tap("fish_mirror_koi");
  assert.equal(input(view.trade()).props.value, "6"); assert.equal(child(view.draw(), WorldFishStockList).props.feedback.kind, "limit");
  view.tap("fish_sturgeon"); const changed = child(view.draw(), WorldFishStockList).props.feedback;
  assert.equal(changed.kind, "added"); assert.equal(changed.quantity, 1); assert.equal(changed.itemId, "fish_sturgeon");
});

test("opening, all-species navigation, stale taps and foreign owners never create an added event", () => {
  const view = counter(); view.open(); assert.equal(child(view.draw(), WorldFishStockList).props.feedback, null);
  view.tap("fish_mirror_koi");
  attr(view.rows(), "data-fish-stock-all").props.onClick(); assert.equal(child(view.draw(), WorldFishStockList).props.feedback, null);
  const stale = child(view.draw(), WorldFishStockList); view.economy.uncertain = true; stale.props.onSelect("fish_mirror_koi");
  assert.equal(child(view.draw(), WorldFishStockList).props.feedback, null);
  view.economy.uncertain = false; view.tap("fish_mirror_koi");
  view.economy.snapshot = { ...view.economy.snapshot, ownerPublicId: "NEW_OWNER" }; view.props.state = view.economy.snapshot;
  assert.equal(child(view.draw(), WorldFishStockList).props.feedback, null); assert.deepEqual(view.economy.calls, []);
});
