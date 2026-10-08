import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:inline-help-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "inline-help-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return useRef('inline-help').current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) {
        const previous = useRef(null);
        if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); }
      }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/economy/ui/stations/world-object-menu.tsx") || id.endsWith("/features/economy/ui/construction/world-upgrade-dialog.tsx")) return source.replace('from "react";', `from "${hookModule}";`);
    },
  }],
});
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldRecipeDetail } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldUpgradeContent, WorldUpgradeDialog } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { ExpeditionRouteDetails, WorldExpeditionSector, ActiveExpedition } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-07T12:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 10_000, pearls: 0 }, inventory: {},
    buildings: { home: 3, garden: 2, warehouse: 1, workshop: 2, dryer: 2 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { snapshot: { ...state, storage: overrides.storage ?? economyStorage(state) }, market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() { assert.fail("Opening help cannot send an economy command"); }, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...flags };
}
function elements(tree) {
  const result = [];
  const walk = element => { if (isValidElement(element)) { result.push(element); Children.forEach(element.props.children, walk); } };
  walk(tree); return result;
}
const helpButton = nodes => nodes.find(element => element.type === "button" && element.props.children?.includes?.("Как продолжить?"));
function hooked(component, props) { hooks.render(); const nodes = elements(component(props)); hooks.flush(); return nodes; }
function probe(component, props) {
  let nodes;
  function Probe() { const tree = component(props); nodes = elements(tree); return tree; }
  renderToStaticMarkup(createElement(Probe)); return nodes;
}
function recipeProps(economy, id = "make_planks", extra = {}) {
  return { economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === id), onCollapse() {}, ...extra };
}

test("recipe help appears for missing materials, locked stations and occupied slots, but not an available recipe or transient send", () => {
  for (const [economy, expected] of [
    [controller(), true],
    [controller({ inventory: { wood: 2 } }), false],
    [controller({ inventory: { wood: 2 }, buildings: { home: 1, warehouse: 1 } }), true],
    [controller({ inventory: { wood: 2 }, jobs: [{ id: "paid", kind: "production", targetId: "workshop", recipeId: "make_planks" }] }), true],
    [controller({ inventory: { wood: 2 } }, { busy: true }), false],
    [controller({ inventory: { wood: 2 } }, { uncertain: true }), true],
    [controller({ inventory: { wood: 2 } }, { retryAt: now + 1000 }), true],
  ]) {
    hooks.reset(); const opened = [], before = structuredClone(economy.snapshot);
    const nodes = hooked(WorldRecipeDetail, recipeProps(economy, "make_planks", { onOpenHelp: context => opened.push(context) }));
    assert.equal(Boolean(helpButton(nodes)), expected);
    if (expected) {
      helpButton(nodes).props.onClick();
      assert.deepEqual(opened, [{ intent: "production", stationId: "workshop", recipeId: "make_planks", fishItemId: undefined, quantity: 1 }]);
    }
    assert.deepEqual(economy.snapshot, before);
  }
});

test("recipe context follows an explicit fish choice and quantity, preserving the canonical recipe and avoiding repeat effects", () => {
  hooks.reset(); const economy = controller(), contexts = [], opened = [];
  const props = recipeProps(economy, "cook_grilled_fish", { onOpenHelp: value => opened.push(value), onHelpContextChange: value => contexts.push(value) });
  let nodes = hooked(WorldRecipeDetail, props);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].fishItemId, "fish");
  const fish = props.recipe.fishInput.itemIds.find(id => id !== "fish");
  const selector = nodes.find(element => element.type === "select");
  selector.props.onChange({ target: { value: fish } });
  nodes = hooked(WorldRecipeDetail, props);
  nodes.find(element => element.props["aria-label"] === "Увеличить партию").props.onClick();
  nodes = hooked(WorldRecipeDetail, props);
  helpButton(nodes).props.onClick();
  assert.deepEqual(opened, [{ intent: "production", stationId: "dryer", recipeId: "cook_grilled_fish", fishItemId: fish, quantity: 2 }]);
  assert.deepEqual(contexts.at(-1), opened[0]);
  const count = contexts.length;
  hooked(WorldRecipeDetail, props); hooked(WorldRecipeDetail, { ...props, economy: { ...economy, now: now + 1000 } });
  assert.equal(contexts.length, count, "time ticks cannot repeat context callbacks and rerender the world");
});

test("construction help includes material deficits that have no duplicate error paragraph, and does not interrupt paid work", () => {
  const opened = [];
  for (const [economy, expected] of [
    [controller(), true],
    [controller({ inventory: Object.fromEntries(economyCatalog.items.map(item => [item.id, 100])), wallet: { coins: 1_000_000, pearls: 0 } }), false],
    [controller({ jobs: [{ id: "paid", kind: "construction", targetId: "warehouse", targetLevel: 2 }] }), false],
  ]) {
    const nodes = elements(WorldUpgradeContent({ stationId: "warehouse", economy, onClose() {}, onOpenHelp: value => opened.push(value) }));
    assert.equal(Boolean(helpButton(nodes)), expected);
    if (expected) helpButton(nodes).props.onClick();
  }
  assert.deepEqual(opened, [{ intent: "construction", stationId: "warehouse" }]);
});

test("leaving the upgrade dialog for help suppresses old focus restoration, while normal close retains it", () => {
  for (const openingHelp of [false, true]) {
    hooks.reset(); let restored = 0, prevented = 0; const opened = [];
    const nodes = hooked(WorldUpgradeDialog, { stationId: "warehouse", economy: controller(), onClose() {}, onCloseAutoFocus() { restored++; }, onOpenHelp: value => opened.push(value) });
    const detail = nodes.find(element => element.type === WorldUpgradeContent);
    const dialog = nodes.find(element => element.props["data-upgrade-station"] === "warehouse");
    if (openingHelp) detail.props.onOpenHelp({ intent: "construction", stationId: "warehouse" });
    dialog.props.onCloseAutoFocus({ preventDefault() { prevented++; } });
    assert.equal(restored, openingHelp ? 0 : 1);
    assert.equal(prevented, openingHelp ? 1 : 0);
    assert.equal(opened.length, openingHelp ? 1 : 0);
  }
});

test("route help keeps the selected route, remains readable under command locks and is absent on a free route", () => {
  for (const [economy, routeId, expected] of [[controller(), "forest", false], [controller({ storage: { capacity: 10, used: 0, reserved: 0, available: 10, overflow: 0 } }), "shore_camp", true], [controller({}, { uncertain: true }), "forest", true]]) {
    const opened = [], route = economy.snapshot.catalog.explorations.find(entry => entry.id === routeId);
    const nodes = probe(ExpeditionRouteDetails, { economy, state: economy.snapshot, route, exploring: false, onOpenPantry() {}, onOpenHelp: value => opened.push(value) });
    assert.equal(Boolean(helpButton(nodes)), expected);
    if (expected) { helpButton(nodes).props.onClick(); assert.deepEqual(opened, [{ intent: "expedition", routeId }]); }
  }
  const economy = controller(), onOpenHelp = () => {};
  const nodes = probe(WorldExpeditionSector, { economy, state: economy.snapshot, sectorId: "shore", selectedRoute: "shore_camp", exploring: false, onOpenPantry() {}, onSelectRoute() {}, onOpenHelp });
  assert.equal(nodes.find(element => element.type === ExpeditionRouteDetails).props.onOpenHelp, onOpenHelp);
});

test("ready trip with full storage offers help without claiming or cancelling its saved reward", () => {
  const job = { id: "paid", kind: "exploration", targetId: "forest", startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: { wood: 5 }, cost: { coins: 0, items: {} } };
  const economy = controller({ jobs: [job], storage: { capacity: 100, used: 100, reserved: 0, available: 0, overflow: 0 } }), opened = [];
  const before = structuredClone(economy.snapshot);
  const nodes = probe(ActiveExpedition, { economy, state: economy.snapshot, job, onOpenPantry() {}, confirmationKey: null, onConfirmation() {}, onCancellationSent() {}, onOpenHelp: value => opened.push(value) });
  helpButton(nodes).props.onClick();
  assert.deepEqual(opened, [{ intent: "expedition", routeId: "forest" }]);
  assert.deepEqual(economy.snapshot, before);
});
