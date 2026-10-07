import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:world-help-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "world-help-ui-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return useRef('help-ui-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) {
        const previous = useRef(null);
        if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); }
      }
    `; },
    transform(source, id) { if (id.endsWith("/features/world/world-help.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldHelp } = await vite.ssrLoadModule("/features/world/world-help.tsx");
const { worldHelpTopics, worldHelpGroups } = await vite.ssrLoadModule("/features/world/world-help-content.ts");
const { newWorldState } = await vite.ssrLoadModule("/features/world/model.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");

function elements(tree) {
  const result = [];
  const walk = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, walk); } };
  walk(tree); return result;
}
function help(props = {}) {
  let nodes;
  function Probe() { const tree = WorldHelp(props); nodes = elements(tree); return tree; }
  hooks.render(); const html = renderToStaticMarkup(createElement(Probe)); hooks.flush();
  return { html, nodes };
}
const buttons = nodes => nodes.filter(node => node.type === "button");
const text = node => renderToStaticMarkup(node).replace(/<[^>]*>/g, "");
const button = (nodes, label) => buttons(nodes).find(node => node.props["aria-label"] === label || text(node) === label);
const now = Date.parse("2026-10-07T12:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "help-player", revision: 2, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 1000, pearls: 0 }, inventory: { stone: 1 }, buildings: { home: 3, warehouse: 1, workshop: 2, dryer: 2, garden: 1 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, ...overrides };
  const forbidden = () => assert.fail("Help must never send, retry or claim automatically");
  return { snapshot: { ...state, storage: overrides.storage ?? economyStorage(state) }, busy: false, uncertain: false, error: null, now, retryAt: 0,
    act: forbidden, actMarket: forbidden, retry: forbidden, refresh: forbidden, refreshMarket: forbidden, ...flags };
}

test("help starts with six groups, a labelled search and a short index instead of expanded answers", () => {
  hooks.reset(); const { html, nodes } = help();
  const input = nodes.find(node => node.type === "input" && node.props.type === "search");
  assert.ok(input);
  assert.ok(nodes.some(node => node.type === "label" && node.props.htmlFor === input.props.id));
  assert.match(html, /role="search" aria-label="Поиск по справке"/);
  const groups = buttons(nodes).filter(node => node.props["data-help-group"]);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups.map(node => node.props["data-help-group"]), worldHelpGroups.map(group => group.id));
  assert.match(html, /aria-label="Частые вопросы"/);
  assert.equal(nodes.filter(node => node.type === "strong").length, 10, "six categories plus four first questions");
  assert.doesNotMatch(html, /data-help-topic=|<details|<ol|data-help-advice=/);
  for (const topic of worldHelpTopics()) for (const step of topic.steps ?? []) assert.ok(!html.includes(step), "full instructions open only after choosing an answer");
});

test("choosing a group shows only its questions and keeps answers one click away", () => {
  for (const group of worldHelpGroups) {
    hooks.reset(); let view = help();
    view.nodes.find(node => node.props["data-help-group"] === group.id).props.onClick();
    view = help();
    const topics = worldHelpTopics().filter(topic => topic.group === group.id);
    assert.deepEqual(view.nodes.filter(node => node.type === "strong").map(node => node.props.children), topics.map(topic => topic.title));
    assert.doesNotMatch(view.html, /data-help-topic=|data-help-group=|<ol/);
    assert.ok(button(view.nodes, "Все разделы"));
    button(view.nodes, "Все разделы").props.onClick();
    assert.equal(help().nodes.filter(node => node.props["data-help-group"]).length, 6);
  }
});

test("search renders results, handles an unknown question and returns to groups after clearing", () => {
  hooks.reset(); let view = help();
  view.nodes.find(node => node.type === "input").props.onChange({ target: { value: "не хватает монет" } });
  view = help();
  assert.match(view.html, /aria-label="Результаты поиска"/);
  assert.match(view.html, /role="status">Найдено ответов: [1-9]/);
  assert.doesNotMatch(view.html, /data-help-group=|data-help-topic=|<ol/);
  const firstResult = buttons(view.nodes).find(node => elements(node).some(child => child.type === "strong"));
  assert.ok(firstResult); firstResult.props.onClick();
  view = help();
  assert.match(view.html, /data-help-topic=/);
  assert.ok(button(view.nodes, "К результатам поиска"));
  button(view.nodes, "К результатам поиска").props.onClick();
  view = help();
  assert.equal(view.nodes.find(node => node.type === "input").props.value, "не хватает монет");
  view.nodes.find(node => node.type === "input").props.onChange({ target: { value: "несуществующий-вопрос-12345" } });
  view = help(); assert.match(view.html, /Найдено ответов: 0/); assert.match(view.html, /Не нашли ответ/);
  button(view.nodes, "Очистить поиск").props.onClick();
  view = help();
  assert.equal(view.nodes.find(node => node.type === "input").props.value, "");
  assert.equal(view.nodes.filter(node => node.props["data-help-group"]).length, 6);
});

test("a direct topic opens exactly one answer and its related questions without triggering navigation", () => {
  hooks.reset(); const topics = worldHelpTopics(), selected = topics.find(topic => topic.id === "production");
  const props = { initialTopicId: selected.id, onNavigate() { assert.fail("Opening an answer is read-only"); } };
  let view = help(props);
  assert.deepEqual(view.nodes.filter(node => node.props["data-help-topic"]).map(node => node.props["data-help-topic"]), [selected.id]);
  assert.match(view.html, /aria-label="По этой теме"/);
  for (const step of selected.steps) assert.ok(view.html.includes(step));
  const related = view.nodes.find(node => node.type === "nav" && node.props["aria-label"] === "По этой теме");
  assert.deepEqual(buttons(elements(related)).map(text), selected.relatedIds.map(id => topics.find(topic => topic.id === id).title));
  buttons(elements(related))[0].props.onClick();
  view = help(props);
  assert.deepEqual(view.nodes.filter(node => node.props["data-help-topic"]).map(node => node.props["data-help-topic"]), [selected.relatedIds[0]]);
  assert.doesNotMatch(view.html, /data-help-group=/);
});

test("context advice explains the actual selected recipe and quantity, and only delegates an explicit navigation click", () => {
  hooks.reset(); const economy = controller({ inventory: { iron_ingot: 1 } }), opened = [], before = structuredClone(economy.snapshot);
  const props = { economy, context: { intent: "production", stationId: "workshop", recipeId: "make_planks", quantity: 3 }, onNavigate: target => opened.push(target) };
  const view = help(props);
  assert.match(view.html, /data-help-advice="missing:wood"/);
  assert.match(view.html, /Есть 0, нужно 6/);
  assert.doesNotMatch(view.html, /missing:fiber|missing:iron_ingot/);
  assert.deepEqual(opened, []);
  const action = view.nodes.find(node => node.props.action?.target.kind === "expeditions");
  assert.ok(action);
  const control = action.type(action.props); assert.equal(control.props.disabled, false);
  control.props.onClick();
  assert.deepEqual(opened, [{ kind: "expeditions", sector: "forest" }]);
  assert.deepEqual(economy.snapshot, before);
});

test("retry is explicit and its control blocks busy, cooldown, offline and missing-controller calls", () => {
  hooks.reset(); const opened = [], economy = controller({}, { uncertain: true });
  const view = help({ economy, onNavigate: target => opened.push(target) });
  assert.match(view.html, /data-help-advice="connection:economy:uncertain"/);
  assert.deepEqual(opened, []);
  const action = view.nodes.find(node => node.props.action?.target.kind === "retry-economy");
  assert.ok(action);
  const enabled = action.type(action.props); assert.equal(enabled.props.disabled, false);
  enabled.props.onClick(); assert.deepEqual(opened, [{ kind: "retry-economy" }]);
  for (const patch of [{ economy: { ...economy, busy: true } }, { economy: { ...economy, retryAt: now + 12_000 } }, { isOnline: false }, { economy: undefined }]) {
    const control = action.type({ ...action.props, ...patch });
    assert.equal(control.props.disabled, true);
    assert.match(renderToStaticMarkup(control), /disabled=""/);
    control.props.onClick(); assert.equal(opened.length, 1, "disabled callbacks cannot enqueue a retry");
    if (patch.economy?.retryAt) assert.match(renderToStaticMarkup(control), /Повторить через 12 с/);
  }
  for (const patch of [{ economy: { ...economy, busy: true } }, { economy: { ...economy, retryAt: now + 12_000 } }, { isOnline: false }]) {
    hooks.reset(); const blocked = help({ economy, onNavigate: target => opened.push(target), ...patch });
    const actionNode = blocked.nodes.find(node => node.props.action?.target.kind === "retry-economy");
    assert.ok(!actionNode || actionNode.type(actionNode.props).props.disabled, "current-state advice never exposes an enabled blocked retry");
  }
});
test("world HUD keeps help visible and moves secondary actions under More", async () => {
  const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
  const world = { snapshot: { state: newWorldState(), gifts: [] }, now: Date.parse("2026-09-23T12:00:00Z"), act() {} };
  const markup = renderToStaticMarkup(createElement(WorldView, { world, economy: { snapshot: null, now: world.now }, ownerPublicId: "help-test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 }));
  assert.match(markup, /aria-label="Справка по игре"/);
  assert.match(markup, /data-world-quick="more" aria-haspopup="dialog" aria-expanded="false"/);
  assert.match(markup, /aria-label="Открыть кладовую"/);
  assert.doesNotMatch(markup, /aria-label="Открыть коллекции"/);
  assert.match(markup, /aria-label="Профиль Мохлика\. Мохлик, уровень 1"/);
  const dock = /<nav[^>]*aria-label="Действия в игре"[^>]*>([\s\S]*?)<\/nav>/.exec(markup)?.[1];
  assert.ok(dock);
  assert.deepEqual([...dock.matchAll(/data-world-quick="([^"]+)"/g)].map(match => match[1]), ["pantry", "expeditions", "more"]);
  assert.doesNotMatch(markup, /Как Мохлик\?|Хозяйство/);
  assert.match(markup, /lucide-info/);
});


test("pantry shortcut is visible before opening a building and includes reserved storage", async () => {
  const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
  const world = { snapshot: { state: newWorldState(), gifts: [] }, now: Date.parse("2026-10-03T12:00:00Z"), act() {} };
  const economy = { snapshot: { ownerPublicId: "AAAA-0000-0001", revision: 1, serverTime: new Date(world.now).toISOString(), catalog: economyCatalog,
    wallet: { coins: 150, pearls: 2 }, buildings: { home: 1, warehouse: 1 }, inventory: { wood: 180 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0,
    storage: { used: 180, reserved: 20, capacity: 200, available: 0, overflow: 0 } }, now: world.now };
  economy.snapshot = economyViewSchema.parse(economy.snapshot);
  const markup = renderToStaticMarkup(createElement(WorldView, { world, economy, ownerPublicId: economy.snapshot.ownerPublicId, timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 1 }));
  assert.match(markup, /aria-label="Кладовая: занято 200 из 200 мест" data-full="true"/);
  assert.match(markup, /<span>Кладовая<\/span>/);
  assert.doesNotMatch(markup, /200 \/ 200/, "capacity stays in the accessible label and pantry rather than enlarging the dock");
  assert.doesNotMatch(markup, /data-upgrade-station/);
});
