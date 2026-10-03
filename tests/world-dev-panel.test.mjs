import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldDevTabs, WorldDevPanelContent, gardenDevActionUnavailable } = await vite.ssrLoadModule("/features/world/dev/world-dev-panel.tsx");
const { WORLD_DEV_DEFAULTS, WORLD_DEV_POSES, worldDevStore } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { interactiveMapObjects } = await vite.ssrLoadModule("/features/world/site-interactions.ts");
const { WorldDevCheats } = await vite.ssrLoadModule("/features/world/dev/world-dev-cheats.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");

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
    world: "Погода и живность", buildings: "Постройки", cheats: "Читы хозяйства", ai: "Мышление и память",
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

test("object shortcuts use authored places and account menus without granting a preview level", () => {
  const events = [];
  const state = { ...WORLD_DEV_DEFAULTS, previewBuildings: true, levels: { home: 5, workshop: 2 } };
  const { elements, calls, markup } = panel("buildings", { state,
    onOpenObject: place => events.push(["open", place]),
    shortcut: callback => { events.push(["close-dev"]); callback(); },
  });
  const objects = interactiveMapObjects(TILED_WORLD);
  const buttons = elements.filter(element => element.props["data-dev-object"]);
  assert.deepEqual(buttons.map(button => button.props["data-dev-object"]), objects.map(object => object.place));
  assert.deepEqual(buttons.map(labelText), objects.map(object => object.label));
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(events, objects.flatMap(object => [["close-dev"], ["open", object.place]]));
  assert.deepEqual(calls.patches, []);
  assert.deepEqual(calls.actions, []);
  assert.match(markup, /настоящий прогресс аккаунта/);
  assert.equal(panel("buildings").elements.some(element => element.props["data-dev-object"]), false);
  const hidden = panel("buildings", { state: { ...state, showBuildings: false }, onOpenObject() {} });
  assert.deepEqual(hidden.elements.filter(element => element.props["data-dev-object"]).map(button => button.props["data-dev-object"]),
    interactiveMapObjects(TILED_WORLD, { showBuildings: false }).map(object => object.place));
});

test("route diagnostics follow the selected house geometry instead of the base Tiled level", () => {
  const routes = level => panel("routes", { state: { ...WORLD_DEV_DEFAULTS, levels: { ...WORLD_DEV_DEFAULTS.levels, home: level } } }).markup;
  assert.match(routes(1), /<strong>home-approach<\/strong>: Готов к прогулке/);
  assert.match(routes(5), /<strong>home-approach<\/strong>: Последняя вершина должна совпадать с home-entry/);
  assert.match(panel("appearance").markup, /визуальный масштаб.*Actor.size/);
});

test("application diagnostics link to economy cheats instead of granting obsolete resources", () => {
  const { markup } = panel("app");
  assert.match(markup, /отдельной вкладке «Читы»/);
  assert.doesNotMatch(markup, /\+50|dev_grant_resources|Тестовые ресурсы/);
});

const cheatNow = Date.parse("2026-10-03T13:00:00Z");
function cheats(economyPatch = {}, snapshotPatch = {}, propsPatch = {}) {
  const commands = [], claims = [], retries = [];
  const snapshot = { ownerPublicId: "ME", revision: 3, serverTime: new Date(cheatNow).toISOString(),
    wallet: { coins: 10, pearls: 4 }, inventory: { wood: 3 }, buildings: { home: 1, warehouse: 1 }, jobs: [],
    catalog: economyCatalog, ...snapshotPatch };
  snapshot.storage = snapshotPatch.storage ?? economyStorage(snapshot);
  const props = {
    world: { snapshot: { devTools: true } },
    economy: { snapshot, now: cheatNow, retryAt: 0, busy: false, uncertain: false, notice: "", error: null, devAvailable: true,
      actDev: (...command) => commands.push(command), act: (...command) => claims.push(command), retry: () => retries.push(true), ...economyPatch },
    ...propsPatch,
  };
  let element;
  function Probe() { element = WorldDevCheats(props); return element; }
  renderToStaticMarkup(createElement(Probe));
  return { ...inspect(element), commands, claims, retries, props };
}
const cheatButton = (view, action) => view.elements.find(element => element.props["data-dev-action"] === action);

test("cheats use the economy account, real catalog levels and server commands without changing visual previews", () => {
  const before = worldDevStore.getSnapshot();
  const view = cheats();
  assert.deepEqual(view.commands, [], "render must not grant anything");
  assert.match(view.markup, /ресурсы и уровни сохраняются после перезагрузки/);
  assert.match(view.markup, /Монеты|Жемчуг/);
  for (const [button, command] of [
    ["grant-coins-10000", ["grant_currency", "coins", 10000]],
    ["grant-pearls-100", ["grant_currency", "pearls", 100]],
    ["grant-item", ["grant_item", "wood", 100]],
    ["set-building-level", ["set_building_level", "home", 2]],
    ["grant-upgrade-cost", ["grant_upgrade_cost", "home", 1]],
  ]) {
    const control = cheatButton(view, button);
    assert.equal(control.props.disabled, false);
    control.props.onClick();
    assert.deepEqual(view.commands.at(-1), command);
  }
  const level = view.elements.find(element => element.type === "select" && element.props.value === 2);
  assert.deepEqual(Children.toArray(level.props.children).map(option => option.props.value), economyCatalog.buildings.find(building => building.id === "home").levels.map(entry => entry.level));
  assert.equal(worldDevStore.getSnapshot(), before);
});

test("unpermitted servers, unloaded accounts, pending receipts and cooldowns prevent cheat dispatch", () => {
  for (const [patch, props] of [[{}, { world: { snapshot: { devTools: false } } }], [{ snapshot: null }, {}],
    [{ uncertain: true }, {}], [{ busy: true }, {}], [{ retryAt: cheatNow + 5000 }, {}], [{ devAvailable: false }, {}]]) {
    const view = cheats(patch, {}, props);
    for (const button of view.elements.filter(element => element.props["data-dev-action"])) {
      assert.equal(button.props.disabled, true);
      button.props.onClick();
    }
    assert.deepEqual(view.commands, []);
  }
  const waiting = cheats({ uncertain: true, retryAt: cheatNow + 5000 });
  assert.match(waiting.markup, /Следующий запрос через 5 с/);
  const retry = waiting.elements.find(element => element.type === "button" && labelText(element) === "Проверить результат");
  assert.equal(retry.props.disabled, true);
  retry.props.onClick(); assert.deepEqual(waiting.retries, []);
  const uncertain = cheats({ uncertain: true });
  uncertain.elements.find(element => element.type === "button" && labelText(element) === "Проверить результат").props.onClick();
  assert.deepEqual(uncertain.retries, [true]);
});

test("DEV job timers preserve regular claiming and prevent changing a building with an active job", () => {
  const construction = { id: "house-job", targetId: "home", kind: "construction", targetLevel: 2, finishesAt: new Date(cheatNow + 60000).toISOString() };
  const waiting = cheats({}, { jobs: [construction] });
  assert.equal(cheatButton(waiting, "set-building-level").props.disabled, true);
  cheatButton(waiting, "set-building-level").props.onClick();
  assert.deepEqual(waiting.commands, []);
  cheatButton(waiting, "finish-jobs").props.onClick();
  assert.deepEqual(waiting.commands, [["finish_jobs", "all", 1]]);
  assert.deepEqual(waiting.claims, []);
  const ready = cheats({}, { jobs: [{ ...construction, finishesAt: new Date(cheatNow).toISOString() }] });
  assert.equal(cheatButton(ready, "finish-jobs").props.disabled, true);
  ready.elements.find(element => element.type === "button" && labelText(element) === "Завершить стройку").props.onClick();
  assert.deepEqual(ready.claims, [["claim_job", "house-job"]]);
  assert.match(ready.markup, /Готово к получению/);
});

test("cheat feedback reports actual overflow and the visual building override independently", () => {
  const toggles = [];
  const view = cheats({ notice: "Выдано 100 древесины", error: "Проверьте соединение" }, { storage: { used: 350, capacity: 200, reserved: 5, available: 0, overflow: 155 } },
    { previewBuildings: true, onShowAccountBuildings: () => toggles.push(true) });
  assert.match(view.markup, /Сверх вместимости: 155/);
  assert.match(view.markup, /Выдано 100 древесины/);
  assert.match(view.markup, /Проверьте соединение/);
  assert.match(view.markup, /Включён визуальный предпросмотр зданий/);
  view.elements.find(element => element.type === "button" && labelText(element) === "Показывать уровни хозяйства").props.onClick();
  assert.deepEqual(toggles, [true]);
  assert.deepEqual(view.commands, []);
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
