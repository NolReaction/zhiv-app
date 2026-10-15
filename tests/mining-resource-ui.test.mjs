import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:mining-resource-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-mining-resource-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "mining-resource-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, pending = [];
      export function reset() { slots = []; cursor = 0; pending = []; }
      export function render() { cursor = 0; pending = []; }
      export function flush() { const current = pending; pending = []; current.forEach(effect => effect()); }
      export function capture() { return slots; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return "mining-resource-test"; }
      export function useEffect(effect, dependencies) { const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, position) => !Object.is(value, previous[position]))) { slots[index] = dependencies; pending.push(effect); } }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/expeditions/world-expeditions-menu.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldExpeditionSector, WorldExpeditionsMenu } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { miningResourceGroups, miningDurationMatches, miningDurationLabel } = await vite.ssrLoadModule("/features/economy/ui/expeditions/mining-resource-groups.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T22:00:00Z");
function state(overrides = {}) {
  return { ownerPublicId: "ME", revision: 2, wallet: { coins: 200, pearls: 0 }, inventory: {}, buildings: { home: 5, warehouse: 5, quarry: 5, workshop: 4 },
    jobs: [], storage: { capacity: 250, available: 250, used: 0, reserved: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
}
function controller(snapshot, calls = []) { return { snapshot, now, busy: false, uncertain: false, retryAt: 0, act: (...args) => { calls.push(args); return true; }, retry() {} }; }
function elements(tree) {
  const result = [];
  function walk(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, walk); }
  walk(tree); return result;
}
function sector(snapshot, props = {}, calls = []) {
  hooks.render();
  const selections = [], tree = WorldExpeditionSector({ sectorId: "caves", selectedRoute: null, onSelectRoute: value => selections.push(value), economy: controller(snapshot, calls), state: snapshot, exploring: false, onOpenPantry() {}, ...props });
  const nodes = elements(tree), html = renderToStaticMarkup(tree);
  return { nodes, tree, html, selections, filter: id => nodes.find(node => node.props["data-mining-duration"] === id), ids: nodes.filter(node => node.type === "button" && node.props["data-route"]).map(node => node.props["data-route"]) };
}

test("resource groups keep each route once, sort by duration and do not mutate catalog order", () => {
  const routes = economyCatalog.explorations.filter(route => route.activity === "mining"), before = structuredClone(routes);
  const groups = miningResourceGroups(routes, "all", route => route.seconds);
  assert.deepEqual(groups.map(group => group.id), ["stone", "ore", "clay", "sand", "mixed"]);
  assert.deepEqual(groups.find(group => group.id === "stone").routes.map(route => route.id), ["quarry_stone", "quarry_stone_hour", "quarry_stone_overnight"]);
  assert.ok(groups.find(group => group.id === "mixed").routes.every(route => Object.keys(route.rewards).length > 1));
  assert.deepEqual(groups.flatMap(group => group.routes.map(route => route.id)).sort(), routes.map(route => route.id).sort());
  assert.deepEqual(routes, before);
});

test("duration boundaries are exact and each duration belongs to one non-all filter", () => {
  for (const [seconds, expected] of [[1, "short"], [900, "short"], [901, "medium"], [3600, "medium"], [3601, "long"], [28800, "long"]]) {
    assert.equal(miningDurationMatches(seconds, "all"), true);
    assert.deepEqual(["short", "medium", "long"].filter(filter => miningDurationMatches(seconds, filter)), [expected]);
  }
  assert.equal(miningDurationLabel(270), "4 мин 30 с");
  assert.equal(miningDurationLabel(3601), "1 ч 1 с");
  assert.equal(miningDurationLabel(0), "Сразу");
});

test("actual filter handlers reveal compact resource cards without starting or spending", () => {
  hooks.reset(); const snapshot = state(), before = structuredClone(snapshot), calls = [];
  let view = sector(snapshot, {}, calls);
  assert.equal(view.filter("all").props["aria-pressed"], true);
  assert.match(view.html, /data-mining-resource="stone"/);
  assert.match(view.html, /data-mining-resource="mixed"/);
  assert.match(view.html, /4 мин 30 с/);
  assert.doesNotMatch(view.html, /Доступные маршруты|Нужно подготовиться|lucide-mountain/);
  view.filter("short").props.onClick(); view = sector(snapshot, {}, calls);
  assert.deepEqual(view.ids.sort(), ["quarry_stone", "quarry_ore", "quarry_clay", "quarry_sand"].sort());
  view.filter("medium").props.onClick(); view = sector(snapshot, {}, calls);
  assert.deepEqual(view.ids.sort(), ["cave", "quarry_stone_hour", "quarry_clay_hour", "quarry_sand_hour", "quarry_ore_hour"].sort());
  view.filter("long").props.onClick(); view = sector(snapshot, {}, calls);
  assert.deepEqual(view.ids.sort(), ["quarry_stone_overnight", "quarry_clay_overnight", "quarry_sand_overnight", "quarry_ore_overnight", "deep_cave", "abandoned_quarry", "quarry_supply"].sort());
  view.filter("all").props.onClick(); view = sector(snapshot, {}, calls);
  assert.equal(new Set(view.ids).size, view.ids.length);
  assert.deepEqual(calls, []); assert.deepEqual(snapshot, before);
});

test("cards keep locked extraction requirements and missing provisions visible under filters", () => {
  hooks.reset(); const snapshot = state({ buildings: { home: 3, quarry: 1, warehouse: 1 }, storage: { capacity: 50, available: 50 }, inventory: {} }), calls = [];
  let view = sector(snapshot, {}, calls);
  const locked = view.nodes.find(node => node.props["data-route"] === "quarry_ore");
  assert.equal(locked.props["data-locked"], true); assert.match(renderToStaticMarkup(locked), /Каменоломня · ур. 2/);
  locked.props.onClick(); assert.deepEqual(view.selections, ["quarry_ore"]); assert.deepEqual(calls, []);
  view.filter("long").props.onClick(); view = sector(snapshot, {}, calls);
  assert.match(view.html, /data-route="deep_cave"/); assert.match(view.html, /Нужны припасы/);
  assert.deepEqual(calls, []);
});

test("mine yields name every resource and retain real multi-item amounts without single-item badges", () => {
  hooks.reset(); const snapshot = state(), calls = [], view = sector(snapshot, {}, calls);
  for (const routeId of view.ids) {
    const route = snapshot.catalog.explorations.find(entry => entry.id === routeId);
    const card = view.nodes.find(node => node.type === "button" && node.props["data-route"] === routeId);
    const yields = elements(card).filter(node => node.props["data-mining-yield"]);
    assert.equal(yields.length, Object.keys(route.rewards).length);
    for (const resource of yields) {
      const itemId = resource.props["data-mining-yield"], quantity = route.rewards[itemId];
      const html = renderToStaticMarkup(resource);
      assert.ok(html.includes(snapshot.catalog.items.find(item => item.id === itemId).name));
      const badge = elements(resource).find(node => node.type === "strong");
      if (quantity === 1) assert.equal(badge, undefined);
      else assert.equal(badge.props.children.join(""), `×${quantity}`);
    }
    card.props.onClick();
  }
  assert.deepEqual(view.selections, view.ids); assert.deepEqual(calls, []);
});

test("focused resources share one heading and compact time/quantity variants without repeating artwork", () => {
  hooks.reset(); const snapshot = state(), view = sector(snapshot), groups = view.nodes.filter(node => node.props["data-mining-resource"]);
  const focused = groups.filter(node => node.props["data-mining-resource"] !== "mixed");
  assert.equal(focused.length, 4);
  for (const group of focused) {
    const itemId = group.props["data-mining-resource"], nodes = elements(group);
    assert.equal(group.type, "section");
    const heading = nodes.find(node => node.type === "h4");
    assert.ok(renderToStaticMarkup(heading).includes(snapshot.catalog.items.find(item => item.id === itemId).name));
    const choices = nodes.filter(node => node.type === "button" && node.props["data-route"]);
    assert.ok(choices.length >= 2 && choices.length <= 4);
    for (const choice of choices) {
      const children = Children.toArray(choice.props.children), duration = children[0], findings = children[1];
      assert.ok(duration.props.id.endsWith("-duration"));
      assert.equal(elements(findings).filter(node => node.props["data-mining-yield"]).length, 1);
      assert.equal(elements(findings).filter(node => node.type?.name === "ProductIcon").length, 0, "the group owns the resource artwork");
      assert.equal(choice.props["data-mixed"], undefined);
      assert.doesNotMatch(renderToStaticMarkup(choice), /Быстрая добыча|Короткая смена|Длинная смена|К утру|lucide-arrow-right/);
      assert.ok(choice.props["aria-describedby"].includes(duration.props.id));
      assert.ok(choice.props["aria-describedby"].includes(findings.props.id));
    }
  }
});

test("mixed missions start collapsed with an accessible native summary and retain every saved reward", () => {
  hooks.reset(); const view = sector(state()), mixed = view.nodes.find(node => node.props["data-mining-resource"] === "mixed");
  assert.equal(mixed.type, "details"); assert.equal(mixed.props.open, undefined);
  const children = Children.toArray(mixed.props.children);
  assert.equal(children[0].type, "summary"); assert.match(renderToStaticMarkup(children[0]), /Смешанная добыча/);
  for (const card of elements(mixed).filter(node => node.type === "button" && node.props["data-route"])) {
    const children = Children.toArray(card.props.children);
    assert.equal(card.props["data-mixed"], true);
    assert.equal(children[0].type, "strong", "mixed missions retain their own names");
    assert.ok(children[1].props.id.endsWith("-duration"));
    assert.equal(children[3].props["data-mixed"], true);
    const rewards = state().catalog.explorations.find(route => route.id === card.props["data-route"]).rewards;
    assert.equal(elements(children[3]).filter(node => node.props["data-mining-yield"]).length, Object.keys(rewards).length);
  }
});

test("compact mine metadata retains accessible real blockers without empty rows", () => {
  hooks.reset(); const view = sector(state());
  for (const routeId of ["cave", "deep_cave"]) {
    const card = view.nodes.find(node => node.type === "button" && node.props["data-route"] === routeId);
    const duration = elements(card).find(node => node.props.id?.endsWith("-duration"));
    assert.match(renderToStaticMarkup(duration), routeId === "cave" ? /1 ч/ : /4 ч/);
    const note = elements(card).find(node => node.props.id?.endsWith("-reason"));
    if (routeId === "cave") assert.equal(note, undefined);
    else {
      assert.match(renderToStaticMarkup(note), /Нужны припасы/);
      assert.equal(note.props.title, "Нужны припасы");
      assert.ok(card.props["aria-describedby"].includes(note.props.id));
    }
  }
});

test("filtered-empty state explains recovery and the all chip restores routes", () => {
  hooks.reset(); const snapshot = state({ buildings: { home: 2, quarry: 1, warehouse: 1 } });
  let view = sector(snapshot); view.filter("long").props.onClick(); view = sector(snapshot);
  assert.deepEqual(view.ids, []); assert.match(view.html, /Нет добычи с таким временем/);
  view.filter("all").props.onClick(); assert.ok(sector(snapshot).ids.includes("quarry_stone"));
});

test("new help route reveals review outside a filter and back resets hidden filter without sending", () => {
  hooks.reset(); const snapshot = state(), calls = [];
  let view = sector(snapshot, {}, calls); view.filter("short").props.onClick();
  view = sector(snapshot, { selectedRoute: "quarry_stone_overnight" }, calls);
  assert.match(view.html, /data-route-preparation="true"/); assert.match(view.html, /Камень к утру/);
  const back = view.nodes.find(node => node.type === "button" && node.props.children?.some?.(child => child === "Вся добыча"));
  assert.ok(back); back.props.onClick();
  assert.deepEqual(view.selections, [null]); view = sector(snapshot, {}, calls);
  assert.equal(view.filter("all").props["aria-pressed"], true); assert.ok(view.ids.includes("quarry_stone_overnight"));
  assert.deepEqual(calls, []);
});

test("menu initial route and changed help target open only their own review, invalid IDs stay safe", () => {
  hooks.reset(); const snapshot = state(), calls = [], economy = controller(snapshot, calls);
  function menu(initialRouteId) {
    hooks.render(); const tree = WorldExpeditionsMenu({ economy, embeddedCaves: true, initialRouteId, onOpenPantry() {} });
    return { tree, html: renderToStaticMarkup(tree), nodes: elements(tree) };
  }
  let view = menu("quarry_stone_overnight"); assert.match(view.html, /data-route="quarry_stone_overnight"[^>]*data-route-preparation="true"/);
  const child = view.nodes.find(node => node.type === WorldExpeditionSector); child.props.onSelectRoute(null);
  view = menu("quarry_stone_overnight"); assert.doesNotMatch(view.html, /data-route-preparation/);
  view = menu("quarry_ore"); assert.match(view.html, /data-route="quarry_ore"[^>]*data-route-preparation="true"/);
  view = menu("forest"); assert.doesNotMatch(view.html, /data-route-preparation/);
  assert.deepEqual(calls, []);
});

test("an active help target stays closed after claiming while a new help target opens its own review", () => {
  for (const ready of [false, true]) {
    hooks.reset();
    const saved = { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "exploration", targetId: "quarry_stone_overnight", actorId: "miner", recipeId: null, targetLevel: null,
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + (ready ? -1 : 30000)).toISOString(), rewards: { stone: 30 }, cost: { coins: 0, items: {} }, catalogVersion: 10 };
    const legacy = { ...saved, id: "92c06bb8-161c-439e-8b60-7b3bf3c944c2", targetId: "cave", actorId: undefined, rewards: { stone: 8, ore: 4 } };
    const snapshot = state({ jobs: [saved, legacy] }), calls = [], economy = controller(snapshot, calls);
    function menu(initialRouteId) {
      hooks.render(); const tree = WorldExpeditionsMenu({ economy, embeddedCaves: true, initialRouteId, onOpenPantry() {} });
      return { tree, html: renderToStaticMarkup(tree), nodes: elements(tree) };
    }
    let view = menu(saved.targetId);
    assert.doesNotMatch(view.html, /data-route-preparation/);
    assert.match(view.html, /Добыча по ресурсам/); assert.match(view.html, /Время добычи/);
    let active = view.nodes.filter(node => node.type?.name === "ActiveExpedition");
    assert.deepEqual(active.map(node => node.props.job.id), [saved.id, legacy.id]); assert.deepEqual(calls, []);
    if (!ready) {
      economy.snapshot = { ...snapshot, jobs: [{ ...saved, finishesAt: new Date(now - 1).toISOString() }, legacy] };
      view = menu(saved.targetId); active = view.nodes.filter(node => node.type?.name === "ActiveExpedition");
    }
    const savedCard = active.find(node => node.props.job.id === saved.id);
    const claim = elements(savedCard.type(savedCard.props)).find(node => node.type === "button" && node.props["aria-label"]?.startsWith("Забрать находки:"));
    assert.equal(claim.props.disabled, false); claim.props.onClick();
    assert.deepEqual(calls, [["claim_job", saved.id]]);
    economy.snapshot = { ...snapshot, jobs: [legacy] };
    view = menu(saved.targetId);
    assert.doesNotMatch(view.html, /data-route-preparation/);
    assert.match(view.html, /Добыча по ресурсам/);
    assert.deepEqual(view.nodes.filter(node => node.type?.name === "ActiveExpedition").map(node => node.props.job.id), [legacy.id]);
    view = menu("quarry_ore");
    assert.match(view.html, /data-route="quarry_ore"[^>]*data-route-preparation="true"/);
    assert.deepEqual(calls, [["claim_job", saved.id]]);
  }
});

test("help preview focuses its heading and back restores focus to the same route card", () => {
  hooks.reset(); const snapshot = state(), calls = [], economy = controller(snapshot, calls), focused = [];
  const heading = { focus: () => focused.push("heading") };
  const origin = { dataset: { route: "quarry_stone_overnight" }, closest: () => null, focus: () => focused.push("card") };
  const content = { querySelector: selector => selector === "[data-route-heading]" ? heading : null, querySelectorAll: () => [origin] };
  function menu() {
    hooks.render(); const tree = WorldExpeditionsMenu({ economy, embeddedCaves: true, initialRouteId: "quarry_stone_overnight", onOpenPantry() {} });
    renderToStaticMarkup(tree); tree.props.ref.current = content; hooks.flush(); return tree;
  }
  const tree = menu(); assert.deepEqual(focused, ["heading"]);
  elements(tree).find(node => node.type === WorldExpeditionSector).props.onSelectRoute(null);
  menu(); assert.deepEqual(focused, ["heading", "card"]); assert.deepEqual(calls, []);
});

test("returning from a mixed preview opens its group before restoring keyboard focus", () => {
  hooks.reset(); const snapshot = state(), calls = [], economy = controller(snapshot, calls), focused = [], details = { open: false };
  const heading = { focus: () => focused.push("heading") };
  const origin = { dataset: { route: "cave" }, closest(selector) { assert.equal(selector, "details[data-mining-resource]"); return details; }, focus() { assert.equal(details.open, true); focused.push("card"); } };
  const content = { querySelector: selector => selector === "[data-route-heading]" ? heading : null, querySelectorAll: () => [origin] };
  function menu() {
    hooks.render(); const tree = WorldExpeditionsMenu({ economy, embeddedCaves: true, initialRouteId: "cave", onOpenPantry() {} });
    renderToStaticMarkup(tree); tree.props.ref.current = content; hooks.flush(); return tree;
  }
  const tree = menu(); assert.deepEqual(focused, ["heading"]); assert.equal(details.open, false);
  elements(tree).find(node => node.type === WorldExpeditionSector).props.onSelectRoute(null);
  menu(); assert.deepEqual(focused, ["heading", "card"]); assert.deepEqual(calls, []);
});

test("running and ready independent and legacy mine jobs remain above every duration filter", () => {
  for (const actorId of ["miner", undefined]) for (const ready of [false, true]) {
    hooks.reset(); const saved = { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "exploration", targetId: "cave", actorId, recipeId: null, targetLevel: null,
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + (ready ? -1 : 30000)).toISOString(), rewards: { stone: 8, ore: 4 }, cost: { coins: 0, items: {} }, catalogVersion: 10 };
    const snapshot = state({ jobs: [saved] }), calls = [], economy = controller(snapshot, calls);
    hooks.render(); const tree = WorldExpeditionsMenu({ economy, embeddedCaves: true, onOpenPantry() {} });
    assert.match(renderToStaticMarkup(tree), /Текущая (добыча|вылазка)/);
    const child = elements(tree).find(node => node.type === WorldExpeditionSector);
    // Exercise the real child filter while the active parent remains separate.
    hooks.reset(); let view = sector(snapshot, child.props, calls); view.filter("short").props.onClick();
    view = sector(snapshot, child.props, calls); assert.ok(!view.ids.includes("cave"));
    const active = elements(tree).filter(node => node.type?.name === "ActiveExpedition");
    assert.equal(active.length, 1); assert.equal(active[0].props.job.id, saved.id);
    assert.deepEqual(calls, []);
  }
});

test("miner times ignore hero food while saved hero route quotes drive the filter", () => {
  hooks.reset(); const snapshot = state({ food: { heroMeal: "hearty_fish", builderMeal: null } });
  let view = sector(snapshot); view.filter("medium").props.onClick(); view = sector(snapshot);
  assert.deepEqual(view.ids.sort(), ["cave", "quarry_stone_hour", "quarry_clay_hour", "quarry_sand_hour", "quarry_ore_hour"].sort()); assert.match(view.html, /1 ч/);
  // Catalog ownership, not the caves sector alone, governs a legacy route.
  snapshot.catalog.explorations.find(route => route.id === "cave").activity = "hero";
  snapshot.catalog.explorations.find(route => route.id === "cave").seconds = 4000;
  view = sector(snapshot); assert.ok(view.ids.includes("cave")); assert.doesNotMatch(view.html, /1 ч 6 мин 40 с/);
});
