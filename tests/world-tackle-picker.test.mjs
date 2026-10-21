import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-tackle-test-"));
const hookModule = "virtual:tackle-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "tackle-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return useRef('tackle-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) {
        const previous = useRef(null);
        if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); }
      }
      export const useLayoutEffect = useEffect;
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/fishing/world-tackle-picker.tsx") || id.endsWith("/features/economy/ui/fishing/use-fishing-command.ts")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldTacklePicker, fishingTackleOptions, fishingTackleChoice } = await vite.ssrLoadModule("/features/economy/ui/fishing/world-tackle-picker.tsx");
const { useFishingCommand } = await vite.ssrLoadModule("/features/economy/ui/fishing/use-fishing-command.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingClassOdds, fishingTripCost } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const now = Date.parse("2026-10-14T22:00:00Z");
function controller(overrides = {}, flags = {}) {
  const snapshot = { ownerPublicId: "fisher", revision: 4, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 1000, pearls: 0 }, inventory: { crumb_bait: 2, worm_bait: 3, star_bait: 1 }, buildings: { home: 5, warehouse: 1 }, jobs: [],
    fishing: { ownedRods: ["reed_rod", "river_rod", "starfall_rod"], equippedRodId: "river_rod", ownedHooks: ["bare_hook", "barbed_hook"], equippedHookId: "bare_hook", equippedBaitId: "worm_bait", catches: {} }, ...overrides };
  const calls = [];
  return { snapshot, calls, busy: false, uncertain: false, error: null, now, retryAt: 0, act: (...args) => { calls.push(args); return true; }, ...flags };
}
function elements(tree) {
  const result = [];
  function walk(node) { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, walk); } }
  walk(tree); return result;
}
function propsFor(economy, extra = {}) {
  return { economy, state: economy.snapshot, disabled: false, onChoose: (kind, id) => {
    if (!fishingTackleChoice(economy.snapshot, kind, id)) return false;
    economy.calls.push([kind, id]); return true;
  }, ...extra };
}
function render(props) { hooks.render(); const tree = WorldTacklePicker(props); hooks.flush(); return { tree, nodes: elements(tree) }; }
function roots(view) { return view.nodes.filter(node => node.type?.displayName === "Popover" || (node.props.onOpenChange && node.props.children)); }
function open(props, kind) {
  hooks.reset(); let view = render(props);
  const trigger = view.nodes.find(node => node.props["data-tackle-slot"] === kind);
  const popup = roots(view).find(node => elements(node).includes(trigger));
  assert.ok(popup); popup.props.onOpenChange(true); view = render(props);
  assert.ok(view.nodes.some(node => node.props["data-tackle-picker"] === kind)); return view;
}
const option = (view, id) => view.nodes.find(node => node.props["data-tackle-option"] === id);
const trigger = (view, kind) => view.nodes.find(node => node.props["data-tackle-slot"] === kind);

test("equipment slots show illustrations, names and purpose without native selects or purchases", () => {
  const economy = controller(), props = propsFor(economy); hooks.reset();
  const view = render(props), html = renderToStaticMarkup(view.tree);
  for (const kind of ["rod", "hook", "bait"]) assert.ok(trigger(view, kind));
  for (const name of ["Речная удочка", "Простой крючок", "Бонус для необычной рыбы", "В запасе 3 · за поход 1"]) assert.ok(html.includes(name));
  assert.doesNotMatch(html, /<select\b|Купить.*монет|Отправиться|Жемчуг/);
  assert.deepEqual(economy.calls, []);
});

test("each picker only offers owned rods and hooks, stocked bait and an explicit no-bait choice", () => {
  const economy = controller(), before = structuredClone(economy.snapshot), props = propsFor(economy);
  for (const [kind, ids] of [["rod", ["reed_rod", "river_rod", "starfall_rod"]], ["hook", ["bare_hook", "barbed_hook"]], ["bait", ["none", "crumb_bait", "worm_bait", "star_bait"]]]) {
    const view = open(props, kind);
    assert.deepEqual(view.nodes.filter(node => node.props["data-tackle-option"]).map(node => node.props["data-tackle-option"]), ids);
    assert.ok(view.nodes.find(node => node.props["data-tackle-picker-close"]));
  }
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before);
});

test("candidate percentages describe exact loadout odds including automatic incompatible-bait removal", () => {
  const economy = controller(), props = propsFor(economy);
  economy.snapshot.fishing.equippedRodId = "starfall_rod"; economy.snapshot.fishing.equippedBaitId = "star_bait";
  const view = open(props, "rod"), candidate = fishingTackleOptions(economy.snapshot, "rod").find(entry => entry.id === "reed_rod");
  assert.equal(candidate.removesBait, true); assert.deepEqual(candidate.override, { rodId: "reed_rod", baitId: null });
  assert.equal(fishingClassOdds(economy.snapshot, economy.snapshot.catalog.fishing, candidate.override).find(odd => odd.rarity === "common").probability, .85);
  const html = renderToStaticMarkup(option(view, "reed_rod"));
  assert.match(html, /85%/); assert.match(html, /data-tackle-odds="common"/); assert.match(html, /Наживка останется в кладовой/);
  assert.match(html, /data-change="increase"/); assert.match(html, /→|aria-label="Обычная рыба: [^"]+ → 85%"/);
  assert.deepEqual(economy.calls, []);
});

test("mixed-purpose travelling gear names both directions and previews both exact class changes", () => {
  const economy = controller();
  economy.snapshot.fishing.ownedRods.push("traveller_rod", "marsh_rod", "dusk_rod");
  economy.snapshot.fishing.ownedHooks.push("braided_hook", "dusk_hook");
  economy.snapshot.inventory.spice_bait = 5; economy.snapshot.inventory.dusk_bait = 5;
  const props = propsFor(economy);
  for (const [kind, itemId, targets, label] of [
    ["rod", "traveller_rod", ["uncommon", "rare"], "Для необычной и редкой рыбы"],
    ["rod", "marsh_rod", ["common", "epic"], "Для обычной и эпической рыбы"],
    ["rod", "dusk_rod", ["epic", "legendary"], "Для эпической и легендарной рыбы"],
    ["hook", "braided_hook", ["uncommon", "rare"], "Бонус для необычной и редкой рыбы"],
    ["hook", "dusk_hook", ["epic", "legendary"], "Бонус для эпической и легендарной рыбы"],
    ["bait", "spice_bait", ["uncommon", "rare"], "Бонус для необычной и редкой рыбы"],
    ["bait", "dusk_bait", ["epic", "legendary"], "Бонус для эпической и легендарной рыбы"],
  ]) {
    const view = open(props, kind), candidate = fishingTackleOptions(economy.snapshot, kind).find(entry => entry.id === itemId);
    assert.equal(candidate.direction, label); assert.deepEqual(candidate.targets, targets);
    const html = renderToStaticMarkup(option(view, itemId));
    assert.ok(html.includes(label));
    const expected = fishingClassOdds(economy.snapshot, economy.snapshot.catalog.fishing, candidate.override);
    for (const target of targets) {
      assert.ok(html.includes(`data-tackle-odds="${target}"`));
      const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(expected.find(row => row.rarity === target).probability * 100);
      assert.ok(html.includes(`${formatted}%`));
    }
  }
  assert.deepEqual(economy.calls, [], "previewing mixed purposes cannot equip or spend anything");
});

test("one explicit item tap equips exactly once, closes the picker and awaits confirmed stock", () => {
  for (const [kind, id] of [["rod", "reed_rod"], ["hook", "barbed_hook"], ["bait", "none"]]) {
    const economy = controller(), before = structuredClone(economy.snapshot), props = propsFor(economy), view = open(props, kind);
    const control = option(view, id); assert.equal(control.props.disabled, false);
    control.props.onClick(); control.props.onClick();
    assert.deepEqual(economy.calls, [[kind, id]]); assert.deepEqual(economy.snapshot, before);
    assert.ok(roots(render(props)).every(root => !root.props.open));
  }
});

test("tapping an already equipped option only dismisses the picker", () => {
  const economy = controller(), props = propsFor(economy), view = open(props, "rod");
  const current = option(view, "river_rod"); assert.equal(current.props["aria-pressed"], true); current.props.onClick();
  assert.deepEqual(economy.calls, []); assert.ok(roots(render(props)).every(root => !root.props.open));
});

test("incompatible stocked bait is visible with a reason and cannot dispatch", () => {
  const economy = controller(), props = propsFor(economy), view = open(props, "bait");
  const unavailable = option(view, "star_bait"); assert.equal(unavailable.props.disabled, true);
  assert.match(renderToStaticMarkup(unavailable), /Не подходит к этой удочке/);
  unavailable.props.onClick(); assert.deepEqual(economy.calls, []);
  assert.equal(fishingTackleChoice(economy.snapshot, "bait", "star_bait"), undefined);
});

test("a stocked bait selection never debits it; the unchanged trip cost needs exactly one portion", () => {
  const economy = controller(), props = propsFor(economy), view = open(props, "bait");
  option(view, "crumb_bait").props.onClick();
  assert.deepEqual(economy.calls, [["bait", "crumb_bait"]]); assert.equal(economy.snapshot.inventory.crumb_bait, 2);
  assert.deepEqual(fishingTripCost({ coins: 0, items: {} }, { fishing: { ...economy.snapshot.fishing, equippedBaitId: "crumb_bait" } }), { coins: 0, items: { crumb_bait: 1 } });
});

test("preflight refusal keeps the picker open and permits a deliberate retry", () => {
  const economy = controller(); let accepted = false;
  const props = propsFor(economy, { onChoose: (kind, id) => { economy.calls.push([kind, id]); return accepted; } });
  const view = open(props, "hook"); option(view, "barbed_hook").props.onClick();
  assert.match(renderToStaticMarkup(option(render(props), "barbed_hook")), /Бородатый крючок/);
  assert.ok(render(props).nodes.some(node => node.props.role === "status"));
  accepted = true; option(render(props), "barbed_hook").props.onClick();
  assert.deepEqual(economy.calls, [["hook", "barbed_hook"], ["hook", "barbed_hook"]]); assert.ok(roots(render(props)).every(root => !root.props.open));
});

test("open choices reject changed inventory, ownership, quote revision and receipt locks", () => {
  for (const mutate of [
    economy => { economy.snapshot.inventory.crumb_bait = 0; },
    economy => { economy.snapshot = { ...economy.snapshot, ownerPublicId: "OTHER" }; },
    economy => { economy.snapshot = { ...economy.snapshot, revision: 5 }; },
    economy => { economy.busy = true; }, economy => { economy.uncertain = true; }, economy => { economy.retryAt = now + 1; },
  ]) {
    const economy = controller(), props = propsFor(economy), view = open(props, "bait"), control = option(view, "crumb_bait");
    mutate(economy); control.props.onClick(); assert.deepEqual(economy.calls, []);
  }
  const economy = controller(), props = propsFor(economy), view = open(props, "rod"), control = option(view, "reed_rod");
  economy.snapshot.fishing.ownedRods = ["river_rod"]; control.props.onClick(); assert.deepEqual(economy.calls, []);
});

test("revision or owner change hides an old picker, including its retained handlers", () => {
  const economy = controller(), props = propsFor(economy), view = open(props, "hook"), control = option(view, "barbed_hook");
  economy.snapshot = { ...economy.snapshot, revision: 5 }; props.state = economy.snapshot;
  assert.ok(roots(render(props)).every(root => !root.props.open)); control.props.onClick(); assert.deepEqual(economy.calls, []);
});

test("missing owned equipment remains repairable and unknown inputs cannot become commands", () => {
  const economy = controller(); economy.snapshot.fishing.equippedHookId = "silver_hook";
  const props = propsFor(economy); hooks.reset(); const html = renderToStaticMarkup(render(props).tree);
  assert.match(html, /Выберите крючок/);
  for (const [kind, id] of [["rod", "willow_rod"], ["hook", "unknown"], ["bait", "glow_bait"]]) assert.equal(fishingTackleChoice(economy.snapshot, kind, id), undefined);
  const view = open(props, "hook"); option(view, "bare_hook").props.onClick(); assert.deepEqual(economy.calls, [["hook", "bare_hook"]]);
});

test("disabled or stale preparation cannot open the selection panel", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 1 }]) {
    const economy = controller({}, flags), props = propsFor(economy, { disabled: true }); hooks.reset(); const view = render(props);
    for (const kind of ["rod", "hook", "bait"]) assert.equal(trigger(view, kind).props.disabled, true);
    roots(view)[0].props.onOpenChange(true); assert.ok(roots(render(props)).every(root => !root.props.open)); assert.deepEqual(economy.calls, []);
  }
});

test("the shared fishing latch rejects equip then immediate departure and recovers from refusal", () => {
  const economy = controller(), state = economy.snapshot; hooks.reset(); hooks.render(); const command = useFishingCommand({ economy, state }); hooks.flush();
  assert.equal(command.send("equip_fishing_rod", "reed_rod"), true);
  assert.equal(command.send("start_fishing", "shore"), false); assert.deepEqual(economy.calls, [["equip_fishing_rod", "reed_rod", 1, 0]]);
  hooks.reset(); let accepted = false; economy.calls.length = 0; economy.act = (...args) => { economy.calls.push(args); return accepted; };
  hooks.render(); const retry = useFishingCommand({ economy, state }); hooks.flush();
  assert.equal(retry.send("equip_fishing_hook", "barbed_hook"), false); accepted = true;
  assert.equal(retry.send("equip_fishing_hook", "barbed_hook"), true); assert.equal(retry.send("start_fishing", "shore"), false);
  assert.deepEqual(economy.calls, [["equip_fishing_hook", "barbed_hook", 1, 0], ["equip_fishing_hook", "barbed_hook", 1, 0]]);
});
