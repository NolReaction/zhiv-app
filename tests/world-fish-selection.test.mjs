import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "zhiv-fish-selection-"));
const hooksId = "virtual:fish-selection-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "fish-selection-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let frames = new Map(), slots = [], cursor = 0, effects = [];
      export function reset() { frames.clear(); }
      export function render(key) { slots = frames.get(key) ?? []; frames.set(key, slots); cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useId() { return useRef('fish-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) { const old = useRef(null); if (!old.current || dependencies.some((value, i) => !Object.is(value, old.current[i]))) { old.current = dependencies; effects.push(effect); } }
      export const useLayoutEffect = useEffect;
    `; },
    transform(source, id) {
      if (["/ui/fishing/world-fish-selection.tsx", "/ui/production/world-production-card.tsx", "/ui/food/world-resident-order-board.tsx"].some(path => id.endsWith(path)))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }] });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldFishSelection } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-fish-selection.tsx");
const { WorldProductionCard } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
const { ResidentOrderCard, ResidentOrderBoard, FishOrderAction } = await vite.ssrLoadModule("/features/economy/ui/food/world-resident-order-board.tsx");
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { normalizedResidentOrders, residentOrderBoard } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { newTutorialOrder, tutorialResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { stageResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const now = Date.parse("2026-10-14T23:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "fish-owner", revision: 1, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 10000, pearls: 500 }, inventory: { fish_common: 4, fish_epic: 5, berries: 8, hardwood: 3, charcoal: 3 },
    fishing: economyFishingSchema.parse({ ownedRods: economyCatalog.fishing.rods.map(rod => rod.id),
      catches: { fish_eel: 99 }, stock: { fish_sturgeon: 1, fish_mirror_koi: 3, fish_silverfin: 2 } }),
    buildings: { home: 5, dryer: 5, warehouse: 10, workshop: 5, woodlot: 5, kiln: 5, quarry: 5 }, jobs: [],
    progression: { recipes: {} }, completedExplorations: 0, migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, ...overrides };
  const calls = [];
  return { snapshot: { ...state, storage: economyStorage(state) }, now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", calls,
    act: (...args) => { calls.push(args); return true; }, refresh() {}, ...flags };
}
function elements(tree) {
  const nodes = [];
  const walk = node => { if (isValidElement(node)) { nodes.push(node); Children.forEach(node.props.children, walk); } };
  walk(tree); return nodes;
}
function render(component, props, key = component.name) { hooks.render(key); const tree = component(props); hooks.flush(); return { tree, nodes: elements(tree) }; }
const find = (view, attribute) => view.nodes.find(node => node.props[attribute] !== undefined);
const buttons = view => view.nodes.filter(node => node.type === "button");
const add = (view, itemId) => buttons({ nodes: elements(view.nodes.find(node => node.props["data-fish-choice"] === itemId)) }).find(node => node.props["aria-label"]?.startsWith("Добавить:"));
const minus = (view, itemId) => buttons({ nodes: elements(view.nodes.find(node => node.props["data-fish-choice"] === itemId)) }).find(node => node.props["aria-label"]?.startsWith("Убрать одну:"));
function pickerProps(economy, extra = {}) { return { economy, requiredItems: { fish_epic: 1 }, contextId: "recipe:epic", confirmLabel: "Готовить", onClose() {}, onConfirm() { return true; }, ...extra }; }

test("picker offers only owned eligible species and honest unidentified class stock", () => {
  hooks.reset(); const economy = controller(), before = structuredClone(economy.snapshot), view = render(WorldFishSelection, pickerProps(economy));
  assert.deepEqual(view.nodes.filter(node => node.props["data-fish-choice"]).map(node => node.props["data-fish-choice"]), ["fish_sturgeon", "fish_mirror_koi", "fish_epic"]);
  assert.equal(find(view, "data-fish-confirm").props.disabled, false, "one class fish is already auto-selected");
  assert.ok(add(view, "fish_epic").props["aria-label"].includes("Без указания вида"));
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before);
  view.tree.props.onOpenChange(false); assert.deepEqual(economy.calls, []);
});

test("one tap replaces the prefilled class fish with a chosen species and confirms once", () => {
  hooks.reset(); const economy = controller(), selections = [], props = pickerProps(economy, { onConfirm: choice => { selections.push(choice); return true; } });
  let view = render(WorldFishSelection, props); add(view, "fish_sturgeon").props.onClick();
  view = render(WorldFishSelection, props); const confirm = find(view, "data-fish-confirm");
  confirm.props.onClick(); confirm.props.onClick();
  assert.deepEqual(selections, [{ fish_sturgeon: 1 }]); assert.deepEqual(economy.calls, []);
});

test("rapid species taps, decrement and autofill respect exact counts across classes", () => {
  hooks.reset(); const economy = controller(), selections = [], props = pickerProps(economy, { requiredItems: { fish_common: 3, fish_epic: 2 },
    onConfirm: choice => { selections.push(choice); return true; } });
  let view = render(WorldFishSelection, props); find(view, "data-fish-clear").props.onClick();
  view = render(WorldFishSelection, props); const epic = add(view, "fish_mirror_koi"); epic.props.onClick(); epic.props.onClick();
  const common = add(view, "fish_silverfin"); common.props.onClick(); common.props.onClick(); common.props.onClick();
  view = render(WorldFishSelection, props); assert.equal(find(view, "data-fish-confirm").props.disabled, true, "three common fish are needed, only two are selected");
  add(view, "fish_common").props.onClick(); view = render(WorldFishSelection, props);
  assert.equal(find(view, "data-fish-confirm").props.disabled, false);
  minus(view, "fish_mirror_koi").props.onClick(); view = render(WorldFishSelection, props); assert.equal(find(view, "data-fish-confirm").props.disabled, true);
  find(view, "data-fish-autofill").props.onClick(); view = render(WorldFishSelection, props); find(view, "data-fish-confirm").props.onClick();
  assert.deepEqual(selections, [{ fish_common: 2, fish_silverfin: 1, fish_epic: 1, fish_mirror_koi: 1 }]);
});

test("an explicit refusal unlocks retry without spending or accepting a second successful press", () => {
  hooks.reset(); const economy = controller(), attempts = [], props = pickerProps(economy, { onConfirm: choice => { attempts.push(choice); return attempts.length > 1; } });
  let view = render(WorldFishSelection, props), confirm = find(view, "data-fish-confirm"); confirm.props.onClick();
  view = render(WorldFishSelection, props); assert.equal(find(view, "data-fish-confirm").props.disabled, false);
  find(view, "data-fish-confirm").props.onClick(); find(view, "data-fish-confirm").props.onClick(); assert.equal(attempts.length, 2);
});

test("captured picker handlers refuse stale owners, revisions, inventory and transport locks", () => {
  for (const mutate of [economy => economy.snapshot.ownerPublicId = "other", economy => economy.snapshot.revision++,
    economy => economy.snapshot.inventory.fish_epic = 0, economy => economy.busy = true, economy => economy.uncertain = true,
    economy => economy.retryAt = now + 1000]) {
    hooks.reset(); const economy = controller(), selections = [], props = pickerProps(economy, { onConfirm: choice => { selections.push(choice); return true; } });
    const view = render(WorldFishSelection, props); mutate(economy); find(view, "data-fish-confirm").props.onClick(); assert.deepEqual(selections, []);
  }
});

test("a changed recipe resets the draft and old confirmation cannot submit it", () => {
  hooks.reset(); const economy = controller(), selections = [], props = pickerProps(economy, { onConfirm: choice => { selections.push(choice); return true; } });
  const old = find(render(WorldFishSelection, props), "data-fish-confirm");
  const changed = { ...props, contextId: "order:common", requiredItems: { fish_common: 2 }, confirmLabel: "Отдать заказ" };
  render(WorldFishSelection, changed); const view = render(WorldFishSelection, changed); old.props.onClick(); assert.deepEqual(selections, []);
  find(view, "data-fish-confirm").props.onClick(); assert.deepEqual(selections, [{ fish_common: 2 }]);
});

test("a selected specimen that disappeared cannot be replaced silently with another fish", () => {
  hooks.reset(); const economy = controller(), selections = [], props = pickerProps(economy, { onConfirm: choice => { selections.push(choice); return true; } });
  let view = render(WorldFishSelection, props); add(view, "fish_sturgeon").props.onClick(); view = render(WorldFishSelection, props);
  economy.snapshot.fishing.stock.fish_sturgeon = 0;
  find(view, "data-fish-confirm").props.onClick(); assert.deepEqual(selections, []);
  assert.equal(economy.snapshot.inventory.fish_epic, 5, "other fish in the same class do not authorize this species choice");
});

test("fish cooking opens without a debit and final choice reaches the exact production command", () => {
  hooks.reset(); const economy = controller(), recipe = economy.snapshot.catalog.recipes.find(entry => entry.id === "cook_epic_fish");
  const props = { economy, recipe }, card = render(WorldProductionCard, props); find(card, "data-recipe-order").props.onClick();
  assert.deepEqual(economy.calls, []);
  const picker = render(WorldProductionCard, props).nodes.find(node => node.type === WorldFishSelection); assert.ok(picker);
  let view = render(WorldFishSelection, picker.props); add(view, "fish_mirror_koi").props.onClick(); view = render(WorldFishSelection, picker.props);
  find(view, "data-fish-confirm").props.onClick(); find(view, "data-fish-confirm").props.onClick();
  assert.deepEqual(economy.calls, [["start_production", "cook_epic_fish", 1, 0, { fish_mirror_koi: 1 }]]);
});

test("fish cooking retry survives controller refusal and no-fish products retain one tap", () => {
  hooks.reset(); const economy = controller(), recipe = economy.snapshot.catalog.recipes.find(entry => entry.id === "cook_epic_fish");
  const props = { economy, recipe }; find(render(WorldProductionCard, props), "data-recipe-order").props.onClick();
  let picker = render(WorldProductionCard, props).nodes.find(node => node.type === WorldFishSelection);
  economy.act = (...args) => { economy.calls.push(args); return economy.calls.length > 1; };
  let view = render(WorldFishSelection, picker.props); find(view, "data-fish-confirm").props.onClick();
  picker = render(WorldProductionCard, props).nodes.find(node => node.type === WorldFishSelection); assert.ok(picker);
  view = render(WorldFishSelection, picker.props); find(view, "data-fish-confirm").props.onClick(); assert.equal(economy.calls.length, 2);
  hooks.reset(); const normal = controller({ inventory: { wood: 2 } });
  const normalView = render(WorldProductionCard, { economy: normal, recipe: normal.snapshot.catalog.recipes.find(entry => entry.id === "make_planks") });
  find(normalView, "data-recipe-order").props.onClick(); assert.deepEqual(normal.calls, [["start_production", "make_planks", 1]]);
});

test("normal, tutorial and stage board requests all forward their chosen species", () => {
  for (const kind of ["normal", "tutorial", "stage"]) {
    hooks.reset(); const economy = controller(); let offer;
    if (kind === "normal") {
      economy.snapshot.residentOrders = normalizedResidentOrders(economy.snapshot, now); offer = residentOrderBoard(economy.snapshot, now).offers[0];
      economy.snapshot.residentOrders.slots[0].terms.items = { fish_epic: 1 }; offer = residentOrderBoard(economy.snapshot, now).offers[0];
    } else if (kind === "tutorial") {
      const terms = { ...economy.snapshot.catalog.onboarding.residentOrders[0], items: { fish_epic: 1 } };
      economy.snapshot.tutorialOrder = { ...newTutorialOrder(), terms }; offer = tutorialResidentOrder(economy.snapshot);
    } else {
      economy.snapshot.buildings.home = 2; const course = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 2);
      economy.snapshot.stageOrders = { version: 1, stages: { 2: { step: 0, completed: false, terms: { ...course.orders[0], items: { fish_epic: 1 } } } } };
      offer = stageResidentOrder(economy.snapshot);
    }
    const board = render(ResidentOrderBoard, { economy }), cardNode = board.nodes.find(node => node.type === ResidentOrderCard && node.props.offer.id === offer.id);
    assert.ok(cardNode, kind); const card = render(ResidentOrderCard, cardNode.props), actionNode = card.nodes.find(node => node.type === FishOrderAction);
    const action = render(FishOrderAction, actionNode.props); find(action, "data-guide-order-submit").props.onClick(); assert.deepEqual(economy.calls, []);
    const picker = render(FishOrderAction, actionNode.props).nodes.find(node => node.type === WorldFishSelection);
    let view = render(WorldFishSelection, picker.props); add(view, "fish_sturgeon").props.onClick(); view = render(WorldFishSelection, picker.props);
    find(view, "data-fish-confirm").props.onClick(); find(view, "data-fish-confirm").props.onClick();
    assert.deepEqual(economy.calls, [["complete_resident_order", offer.id, 1, 0, { fish_sturgeon: 1 }]], kind);
  }
});

test("board receipt latch clears on a rejected fish command and blocks the accepted retry double press", () => {
  hooks.reset(); const economy = controller();
  economy.snapshot.residentOrders = normalizedResidentOrders(economy.snapshot, now);
  economy.snapshot.residentOrders.slots[0].terms.items = { fish_epic: 1 };
  const offer = residentOrderBoard(economy.snapshot, now).offers[0];
  economy.act = (...args) => { economy.calls.push(args); return economy.calls.length > 1; };
  let board = render(ResidentOrderBoard, { economy });
  const first = board.nodes.find(node => node.type === ResidentOrderCard && node.props.offer.id === offer.id);
  assert.equal(first.props.onComplete(offer, { fish_sturgeon: 1 }), false);
  board = render(ResidentOrderBoard, { economy });
  const retry = board.nodes.find(node => node.type === ResidentOrderCard && node.props.offer.id === offer.id);
  assert.equal(retry.props.onComplete(offer, { fish_sturgeon: 1 }), true);
  assert.equal(retry.props.onComplete(offer, { fish_sturgeon: 1 }), false);
  assert.equal(economy.calls.length, 2);
});

test("Escape and cancellation restore focus to the recipe or order initiator without a command", () => {
  for (const kind of ["recipe", "order"]) for (const closeWay of ["escape", "cancel"]) {
    hooks.reset(); const economy = controller(), focuses = [];
    const component = kind === "recipe" ? WorldProductionCard : FishOrderAction;
    const props = kind === "recipe" ? { economy, recipe: economy.snapshot.catalog.recipes.find(entry => entry.id === "cook_epic_fish") }
      : { economy, offer: { id: "focus-order", items: { fish_epic: 1 } }, disabled: false, onSubmit() { assert.fail("closing cannot fulfill an order"); } };
    const initial = render(component, props), trigger = find(initial, kind === "recipe" ? "data-recipe-order" : "data-guide-order-submit");
    trigger.props.ref.current = { isConnected: true, disabled: false, focus: options => focuses.push(options) };
    trigger.props.onClick();
    const picker = render(component, props).nodes.find(node => node.type === WorldFishSelection), view = render(WorldFishSelection, picker.props);
    const content = find(view, "data-fish-selection"); let escaped = 0, prevented = 0;
    if (closeWay === "escape") content.props.onEscapeKeyDown({ stopPropagation() { escaped++; } });
    view.tree.props.onOpenChange(false);
    content.props.onCloseAutoFocus({ preventDefault() { prevented++; } });
    assert.equal(escaped, closeWay === "escape" ? 1 : 0); assert.equal(prevented, 1);
    assert.deepEqual(focuses, [{ preventScroll: true }]); assert.deepEqual(economy.calls, []);
    assert.equal(render(component, props).nodes.some(node => node.type === WorldFishSelection), false);
  }
});

test("closing a picker cannot focus a detached, replaced, disabled or different-context initiator", () => {
  for (const kind of ["recipe", "order"]) for (const change of ["detached", "unmounted", "replaced", "disabled", "owner", "context"]) {
    hooks.reset(); const economy = controller(), focuses = [];
    const component = kind === "recipe" ? WorldProductionCard : FishOrderAction;
    const props = kind === "recipe" ? { economy, recipe: economy.snapshot.catalog.recipes.find(entry => entry.id === "cook_epic_fish") }
      : { economy, offer: { id: "focus-order", items: { fish_epic: 1 } }, disabled: false, onSubmit() { assert.fail("closing cannot fulfill an order"); } };
    const initial = render(component, props), trigger = find(initial, kind === "recipe" ? "data-recipe-order" : "data-guide-order-submit");
    const element = { isConnected: true, disabled: false, focus: options => focuses.push(options) }; trigger.props.ref.current = element;
    trigger.props.onClick(); const picker = render(component, props).nodes.find(node => node.type === WorldFishSelection);
    if (change === "detached") element.isConnected = false;
    if (change === "unmounted") trigger.props.ref.current = null;
    if (change === "replaced") trigger.props.ref.current = { ...element };
    if (change === "disabled") element.disabled = true;
    if (change === "owner") economy.snapshot.ownerPublicId = "another-owner";
    if (change === "context") {
      if (kind === "recipe") props.recipe = economy.snapshot.catalog.recipes.find(entry => entry.id === "cook_legendary_fish");
      else props.offer = { ...props.offer, id: "different-order" };
      render(component, props);
    }
    let prevented = 0; picker.props.onCloseAutoFocus({ preventDefault() { prevented++; } });
    assert.equal(prevented, 1); assert.deepEqual(focuses, [], `${kind}: ${change}`); assert.deepEqual(economy.calls, []);
  }
});
