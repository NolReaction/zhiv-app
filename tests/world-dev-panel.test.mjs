import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { WorldDevTabs, WorldDevPanelContent, gardenDevActionUnavailable } = await vite.ssrLoadModule("/features/world/dev/world-dev-panel.tsx");
const { WORLD_DEV_DEFAULTS, WORLD_DEV_POSES, worldDevStore } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");

function inspect(element) {
  const elements = [];
  function walk(child) {
    if (!isValidElement(child)) return;
    elements.push(child);
    Children.forEach(child.props.children, walk);
  }
  walk(element);
  return { markup: renderToStaticMarkup(element), elements };
}
const labelText = element => Children.toArray(element.props.children).filter(child => typeof child === "string").join("");
function panel(page, overrides = {}) {
  const calls = { patches: [], actions: [], poses: [], outfits: [], notices: [] };
  const props = {
    world: { busy: false, uncertain: false, snapshot: null, act() { assert.fail("render cannot issue account commands"); } },
    state: WORLD_DEV_DEFAULTS, page, id: "dev-test", selectedPose: "greet", heroUnavailable: null, birdsUnavailable: null,
    unavailable: () => null, change: patch => calls.patches.push(patch), play: action => calls.actions.push(action),
    onSelectPose: pose => calls.poses.push(pose), outfit: (...outfit) => calls.outfits.push(outfit),
    shortcut: callback => callback(), onFeedback: message => calls.notices.push(message), prefersReducedMotion: false,
    ...overrides,
  };
  return { ...inspect(WorldDevPanelContent(props)), calls, props };
}

const tabs = [["scenes", "Сценки"], ["animation", "Анимации"], ["appearance", "Внешность"]];
function tabView(selected = "scenes") {
  const selections = [], focus = [];
  const view = inspect(WorldDevTabs({ id: "dev-mochlik", label: "Проверки Мохлика", tabs, selected, onSelect: tab => selections.push(tab) }));
  const buttons = view.elements.filter(element => element.type === "button");
  function key(index, key, extra = {}) {
    let prevented = false, stopped = false;
    buttons[index].props.onKeyDown({ key, nativeEvent: {},
      currentTarget: { parentElement: { querySelectorAll: () => tabs.map(([tab]) => ({ focus: options => focus.push([tab, options]) })) } },
      preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; }, ...extra,
    });
    return { prevented, stopped };
  }
  return { ...view, buttons, selections, focus, key };
}

test("DEV tabs have stable labelled relationships and a single keyboard entry point", () => {
  const { markup, buttons, selections } = tabView("animation");
  assert.match(markup, /role="tablist" aria-label="Проверки Мохлика"/);
  assert.deepEqual(buttons.map(button => button.props.tabIndex), [-1, 0, -1]);
  assert.deepEqual(buttons.map(button => button.props["aria-selected"]), [false, true, false]);
  for (const [index, button] of buttons.entries()) {
    assert.equal(button.props.id, `dev-mochlik-tab-${tabs[index][0]}`);
    assert.equal(button.props["aria-controls"], `dev-mochlik-panel-${tabs[index][0]}`);
    assert.equal(labelText(button), tabs[index][1]);
  }
  buttons[2].props.onClick();
  assert.deepEqual(selections, ["appearance"]);
});

test("arrow keys wrap, Home and End select and focus; Tab and composing/modifier keys pass through", () => {
  const view = tabView();
  for (const [from, key, expected] of [[0, "ArrowLeft", "appearance"], [2, "ArrowRight", "scenes"], [1, "End", "appearance"], [2, "Home", "scenes"]]) {
    assert.deepEqual(view.key(from, key), { prevented: true, stopped: true });
    assert.equal(view.selections.at(-1), expected);
    assert.deepEqual(view.focus.at(-1), [expected, { preventScroll: true }]);
  }
  const selected = view.selections.length;
  for (const [key, extra] of [["Tab", {}], ["ArrowRight", { ctrlKey: true }], ["ArrowRight", { nativeEvent: { isComposing: true } }]]) {
    assert.deepEqual(view.key(0, key, extra), { prevented: false, stopped: false });
  }
  assert.equal(view.selections.length, selected);
});

test("each DEV page renders only its controls, with no simulation or account mutation during inspection", () => {
  const snapshot = worldDevStore.getSnapshot();
  const expected = {
    scenarios: "Готовые сценарии", scenes: "Лесные сценки", activities: "Занятия на полянке", animation: "Анимации Мохлика", appearance: "Внешность Мохлика",
    world: "Погода и живность", buildings: "Постройки", ai: "Мышление и память",
    overlays: "Разметка сцены", routes: "Навигация и входы", app: "Приложение и тесты",
  };
  for (const [page, title] of Object.entries(expected)) {
    const { markup, elements, calls } = panel(page);
    assert.match(markup, new RegExp(title));
    const headings = elements.filter(element => element.type === "h3");
    assert.equal(headings.length, 1, `${page} must not append other pages below it`);
    assert.equal(labelText(headings[0]), title);
    assert.deepEqual(calls, { patches: [], actions: [], poses: [], outfits: [], notices: [] });
    if (page !== "app") assert.doesNotMatch(markup, /Выдача меняет баланс|Карта и маршруты ↗/);
    if (page !== "scenes") assert.doesNotMatch(markup, /Отправиться спать домой/);
    if (page !== "ai") assert.doesNotMatch(markup, /Данные появятся, когда сцена/);
  }
  assert.equal(worldDevStore.getSnapshot(), snapshot, "opening and switching pages must not reset or override a running scene");
});

test("garden checks have their own compact page, descriptive disabled actions and an available cancel", () => {
  const reason = "Ягоды ещё растут";
  const { elements, markup, calls } = panel("activities", { unavailable: action => action.action === "harvest-berries" ? reason : null });
  const buttons = elements.filter(element => element.type === "button");
  assert.deepEqual(buttons.map(labelText), ["Полить куст", "Собрать ягоды", "Созреть ягодам · DEV", "Отменить занятие"]);
  assert.equal(buttons[1].props.disabled, true);
  assert.equal(labelText(elements.find(element => element.props.id === buttons[1].props["aria-describedby"])), reason);
  buttons[1].props.onClick(); assert.deepEqual(calls.actions, [], "disabled control cannot dispatch through a programmatic callback");
  buttons[2].props.onClick();
  assert.deepEqual(calls.actions, [{ kind: "life", action: "grow-berries" }]);
  assert.equal(buttons[3].props.disabled, false);
  assert.match(markup, /отключают запись памяти аккаунта/);
  assert.doesNotMatch(markup, /Поиграть с бабочкой|Размер ·|Выдача меняет баланс/);
});

test("garden buttons explain unavailable state without inventing ripe berries or bypassing navigation", () => {
  const garden = { bushes: [{ id: "bush", growth: .5, moisture: .2, waterIn: 0 }], basket: { berries: 0, capacity: 12 }, activity: null,
    cooldown: 0, waterReason: null, harvestReason: "Ягоды ещё растут" };
  const reason = (action, patch = {}) => gardenDevActionUnavailable(action, garden, { ...WORLD_DEV_DEFAULTS, ...patch });
  assert.equal(reason("water-bush"), null);
  assert.equal(reason("harvest-berries"), garden.harvestReason);
  assert.equal(reason("grow-berries"), null);
  assert.match(reason("water-bush", { weather: "downpour" }), /сильного дождя/);
  assert.match(reason("water-bush", { navigationMode: "routes" }), /Свободная полянка/);
  assert.equal(reason("grow-berries", { weather: "downpour", navigationMode: "routes" }), null, "ripening preview requires no walk");
  assert.match(gardenDevActionUnavailable("grow-berries", undefined, WORLD_DEV_DEFAULTS), /Дождитесь загрузки/);
  assert.match(gardenDevActionUnavailable("grow-berries", { ...garden, bushes: [] }, WORLD_DEV_DEFAULTS), /Нет ягодного куста/);
  assert.equal(gardenDevActionUnavailable("idle", undefined, WORLD_DEV_DEFAULTS), null);
});

test("all one-shot poses remain available and selecting a preview does not launch it", () => {
  const { elements, calls } = panel("animation", { selectedPose: "fishing-walk" });
  const selector = elements.find(element => element.props.label === "Анимация один раз");
  assert.deepEqual(selector.props.values.map(([pose]) => pose), [...WORLD_DEV_POSES]);
  assert.equal(selector.props.value, "fishing-walk");
  selector.props.onChange("stretch");
  assert.deepEqual(calls.poses, ["stretch"]);
  assert.deepEqual(calls.actions, []);
  const play = elements.find(element => element.type === "button" && labelText(element).startsWith("Проиграть:"));
  play.props.onClick();
  assert.deepEqual(calls.actions, [{ kind: "pose", pose: "fishing-walk" }]);
  const loop = elements.find(element => element.props.label === "Повторять позу");
  loop.props.onChange("sleep");
  assert.deepEqual(calls.patches, [{ pose: "sleep", animation: null }]);
});

test("blocked scenes and animations retain explanatory labels, while cancellation stays available", () => {
  const reason = "Сцена на паузе. Снимите паузу для проигрывания событий.";
  const { elements } = panel("scenes", { unavailable: action => action.action === "idle" ? null : reason });
  const buttons = elements.filter(element => element.type === "button");
  assert.equal(buttons.length, 11);
  assert.equal(elements.filter(element => element.type === "p" && labelText(element) === reason).length, 1,
    "a paused scene needs one shared explanation, not eight paragraphs to scroll past");
  for (const button of buttons) {
    if (labelText(button) === "Отменить сценку") { assert.equal(button.props.disabled, false); continue; }
    assert.equal(button.props.disabled, true);
    const hint = elements.find(element => element.props.id === button.props["aria-describedby"]);
    assert.equal(labelText(hint), reason);
  }
  const animation = panel("animation", { heroUnavailable: reason });
  const play = animation.elements.find(element => element.type === "button" && labelText(element).startsWith("Проиграть:"));
  assert.equal(play.props.disabled, true);
  assert.ok(animation.elements.some(element => element.props.id === play.props["aria-describedby"]));
});

test("returning to building controls uses the selected level and changing one building preserves the rest", () => {
  const home = TILED_WORLD.sites.find(site => site.id === "home");
  const levels = { ...WORLD_DEV_DEFAULTS.levels, home: home.states.at(-1).level };
  const state = { ...WORLD_DEV_DEFAULTS, levels, previewBuildings: true, weather: "rain", paused: true };
  panel("world", { state });
  const { elements, calls } = panel("buildings", { state });
  const field = elements.find(element => element.props.label === home.label);
  const select = field.props.children;
  assert.equal(select.props.value, home.states.at(-1).level);
  select.props.onChange({ target: { value: String(home.states[0].level) } });
  assert.deepEqual(calls.patches, [{ previewBuildings: true, levels: { ...levels, home: home.states[0].level } }]);
  assert.equal(state.levels.home, home.states.at(-1).level);
  assert.equal(state.weather, "rain");
  assert.equal(state.paused, true);
});

test("route diagnostics follow the selected house geometry instead of the base Tiled level", () => {
  const routes = level => panel("routes", { state: { ...WORLD_DEV_DEFAULTS, levels: { ...WORLD_DEV_DEFAULTS.levels, home: level } } }).markup;
  assert.match(routes(1), /<strong>home-approach<\/strong>: Готов к прогулке/);
  assert.match(routes(5), /<strong>home-approach<\/strong>: Последняя вершина должна совпадать с home-entry/);
  assert.match(panel("appearance").markup, /визуальный масштаб.*Actor.size/);
});

test("account test resources still require a permitted server and an unambiguous request", () => {
  const grants = [];
  const world = { busy: false, uncertain: true, snapshot: { devTools: true,
    state: { resources: { sparks: 10, wood: 20, stone: 30 }, equipment: { palette: "moss", head: null, neck: null } } }, act: command => grants.push(command), retry() {} };
  const { elements } = panel("app", { world });
  const grant = elements.find(element => element.type === "button" && labelText(element).includes("+50"));
  assert.equal(grant.props.disabled, true);
  grant.props.onClick();
  assert.deepEqual(grants, []);
  const denied = panel("app", { world: { ...world, uncertain: false, snapshot: { ...world.snapshot, devTools: false } } });
  const deniedGrant = denied.elements.find(element => element.type === "button" && labelText(element).includes("+50"));
  deniedGrant.props.onClick();
  assert.equal(deniedGrant.props.disabled, true);
  assert.deepEqual(grants, []);
});

test("scenario cards explain conditions and dispatch one explicit choice without navigating away", () => {
  const { elements, calls, markup } = panel("scenarios");
  const buttons = elements.filter(item => item.type === "button");
  buttons.find(button => renderToStaticMarkup(button).includes("Вечер у костра")).props.onClick();
  buttons.find(button => renderToStaticMarkup(button).includes("Птицы на земле")).props.onClick();
  assert.deepEqual(calls.actions, [{ kind: "scenario", scenario: "campfire" }, { kind: "scenario", scenario: "ground-birds" }]);
  assert.match(markup, /Уменьшенное движение сохраняется/);
  assert.match(markup, /Положение Мохлика/);
});
