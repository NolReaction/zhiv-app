import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldProfileContent, WorldProfileMenu } = await vite.ssrLoadModule("/features/world/world-profile-menu.tsx");
const { WorldMoodModule } = await vite.ssrLoadModule("/features/world/world-mood-module.tsx");
const { BOOK_COLLECTION_COUNT } = await vite.ssrLoadModule("/features/world/collection-book.ts");
const { newWorldState, worldCatalog } = await vite.ssrLoadModule("/features/world/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const freshEconomy = () => ({ ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 0 }), catalog: economyCatalog, completedExplorations: 7 });

const observation = {
  activity: "Исследует куст", detail: "Увлёкся интересной находкой", mood: "Любопытничает",
  needs: { energy: .8, curiosity: .7, comfort: .9, attention: 0 }, sleeping: false, paused: false,
  memory: { status: "saved", savedAt: 1000, sync: { mode: "synced", revision: 2, serverSavedAt: 1000, canTakeOver: false } },
  diagnostics: { reason: "private-ai-reason", candidates: [], events: [] },
};

function inspect(tree) {
  const elements = [];
  function walk(child) {
    if (!isValidElement(child)) return;
    elements.push(child);
    Children.forEach(child.props.children, walk);
  }
  walk(tree);
  return { markup: renderToStaticMarkup(tree), elements };
}
function profile(overrides = {}) {
  const calls = [];
  const props = {
    world: { snapshot: { state: { ...newWorldState(), houseLevel: 1, collection: [worldCatalog.finds[0].id] } } },
    economy: { snapshot: freshEconomy() }, displayName: "Дима", level: 12, bestStreakDays: 21, observation,
    onCall: () => calls.push("call"), onTakeOver: () => calls.push("takeover"), onTabChange: tab => calls.push(tab), ...overrides,
  };
  return { ...inspect(WorldProfileContent(props)), calls, props };
}
const buttonText = button => Children.toArray(button.props.children).filter(child => typeof child === "string").join("");
const namedButton = (view, name) => view.elements.find(element => element.type === "button" && buttonText(element) === name);

function mood(overrides = {}) {
  const calls = [];
  return { ...inspect(WorldMoodModule({ observation, economy: { snapshot: freshEconomy() },
    onCall: () => calls.push("call"), onOpenHelp: () => calls.push("help"), onOpenFood: () => calls.push("food"), ...overrides })), calls };
}

test("profile keeps authoritative progress compact and leaves the full mood in its own tab", () => {
  const { markup, elements } = profile();
  assert.match(markup, /Дима/);
  assert.match(markup, /Уровень 12/);
  assert.match(markup, /<dt>Дом<\/dt><dd>3 ур\.<\/dd>/);
  assert.match(markup, /<dt>Исследования<\/dt><dd>7<\/dd>/);
  assert.ok(markup.includes(`<dt>Книга находок</dt><dd>1 / ${BOOK_COLLECTION_COUNT}</dd>`));
  assert.match(markup, /21 день/);
  assert.match(markup, /Любопытничает/);
  assert.doesNotMatch(markup, /Самочувствие Мохлика|Полон сил|Хочется открытий|Кладовая|Гардероб|Обустроить дом|Прежние походы/);
  const tabs = elements.filter(element => element.props.role === "tab");
  assert.deepEqual(tabs.map(buttonText), ["Профиль", "Настроение", "Друзья"]);
  assert.deepEqual(tabs.map(tab => tab.props["aria-selected"]), [true, false, false]);
  assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1]);
  assert.equal(elements.filter(element => element.props.role === "tabpanel").length, 1);
});

test("gifts and call stay in the default profile, and the mood preview opens the dedicated tab", () => {
  const view = profile({ rewards: createElement("button", { type: "button", "aria-haspopup": "dialog" }, "Подарки") });
  assert.equal((view.markup.match(/>Подарки</g) ?? []).length, 1);
  assert.ok(namedButton(view, "Позвать Мохлика"));
  view.elements.find(element => element.props["aria-label"] === "Открыть настроение Мохлика").props.onClick();
  assert.deepEqual(view.calls, ["mood"]);
  assert.doesNotMatch(profile({ initialTab: "mood", rewards: "Подарки" }).markup, />Подарки</);
});

test("tabs activate with arrows, Home and End, move focus and do not consume unrelated keys", () => {
  const view = profile();
  const tabs = view.elements.filter(element => element.props.role === "tab");
  const focused = [];
  let prevented = 0;
  const parentElement = { querySelectorAll: selector => {
    assert.equal(selector, '[role="tab"]');
    return tabs.map((_, index) => ({ focus: () => focused.push(index) }));
  } };
  const key = (index, key) => tabs[index].props.onKeyDown({ key, preventDefault: () => prevented++, currentTarget: { parentElement } });
  key(0, "ArrowLeft"); key(2, "ArrowRight"); key(0, "End"); key(2, "Home"); key(1, "Tab");
  assert.deepEqual(view.calls, ["friends", "profile", "friends", "profile"]);
  assert.deepEqual(focused, [2, 0, 2, 0]);
  assert.equal(prevented, 4);
  tabs[1].props.onClick();
  assert.equal(view.calls.at(-1), "mood");
  const friends = profile({ activeTab: "friends", idPrefix: "profile-test" });
  const panel = friends.elements.find(element => element.props.role === "tabpanel");
  assert.equal(panel.props.id, "profile-test-panel-friends");
  assert.equal(panel.props["aria-labelledby"], "profile-test-tab-friends");
  assert.doesNotMatch(friends.markup, /Достижения Мохлика|Самочувствие Мохлика/);
});

test("a different owner or explicit entry tab remounts subscriptions and local call feedback", () => {
  const { props } = profile();
  const first = WorldProfileMenu({ ...props, presenceKey: "owner-a" });
  const other = WorldProfileMenu({ ...props, presenceKey: "owner-b" });
  const moodEntry = WorldProfileMenu({ ...props, presenceKey: "owner-a", initialTab: "mood" });
  assert.notEqual(first.key, other.key);
  assert.notEqual(first.key, moodEntry.key);
  assert.equal(other.props.presenceKey, "owner-b");
  assert.equal(moodEntry.props.initialTab, "mood");
});

test("profile counts permanent book pages without old river souvenirs or purchased fish", () => {
  const state = freshEconomy();
  state.progression.collections.finds = ["acorn", "quartz_cluster"];
  state.fishing.catches = { fish: 3 };
  state.inventory = { fish_mooncarp: 5 };
  const view = profile({ economy: { snapshot: state }, world: { snapshot: { state: {
    ...newWorldState(), collection: ["acorn", "river_pearl"],
  } } } });
  assert.ok(view.markup.includes(`<dt>Книга находок</dt><dd>3 / ${BOOK_COLLECTION_COUNT}</dd>`));
});

test("unknown state disables calling and does not claim zero progress or an invented mood", () => {
  const view = profile({ observation: null, economy: { snapshot: null } });
  assert.match(view.markup, /Полянка загружается/);
  assert.match(view.markup, /<dt>Дом<\/dt><dd>1 ур\.<\/dd>/);
  assert.match(view.markup, /<dt>Исследования<\/dt><dd>—<\/dd>/);
  assert.match(view.markup, /<dt>Книга находок<\/dt><dd>—<\/dd>/);
  assert.equal(namedButton(view, "Позвать Мохлика").props.disabled, true);
  assert.doesNotMatch(view.markup, /Полон сил|Память сохранена/);
  assert.match(profile({ world: { snapshot: { state: { ...newWorldState(), completedJourneys: 2 } } } }).markup, /<dt>Прежние походы<\/dt><dd>2<\/dd>/);
});

test("memory warnings and takeover remain available from all three tabs", () => {
  const elsewhere = { ...observation, paused: true, memory: { ...observation.memory, sync: { ...observation.memory.sync, mode: "other-device", canTakeOver: true } } };
  for (const activeTab of ["profile", "mood", "friends"]) {
    const view = profile({ activeTab, observation: elsewhere });
    assert.match(view.markup, /другом устройстве или в другой вкладке/);
    assert.match(view.markup, /полянка на паузе/);
    namedButton(view, "Продолжить здесь").props.onClick();
    assert.deepEqual(view.calls, ["takeover"]);
    if (activeTab === "profile") assert.equal(namedButton(view, "Позвать Мохлика").props.disabled, true);
  }
  const normal = profile();
  assert.doesNotMatch(normal.markup, /Продолжить здесь/);
  namedButton(normal, "Позвать Мохлика").props.onClick();
  assert.deepEqual(normal.calls, ["call"]);
});

test("memory messages retain offline recovery, first-save and local-only distinctions", () => {
  const withSync = patch => profile({ observation: { ...observation, memory: { ...observation.memory, sync: { ...observation.memory.sync, ...patch } } } }).markup;
  assert.match(withSync({ mode: "offline" }), /загрузится последнее подтверждённое сохранение/);
  assert.doesNotMatch(withSync({ mode: "offline" }), /Память сохранена в аккаунте/);
  assert.match(withSync({ serverSavedAt: null }), /первое сохранение/);
  assert.match(withSync({ mode: "loading" }), /Загружаем память/);
  assert.match(withSync({ mode: "saving" }), /Сохраняем память/);
  assert.match(withSync({ mode: "error" }), /перезагрузить приложение/);
  assert.match(withSync({ mode: "disabled" }), /память Мохлика не сохраняется/);
  const local = status => profile({ observation: { ...observation, memory: { status, savedAt: null } } }).markup;
  assert.match(local("saved"), /только на этом устройстве/);
  assert.match(local("session"), /только на время этой сессии/);
  assert.match(local("unavailable"), /Не удаётся сохранить память/);
  assert.doesNotMatch(local("saved"), /Память сохранена в аккаунте/);
});

test("mood module shows current activity and stable feelings but never private diagnostics or numerical needs", () => {
  const { markup } = mood();
  for (const value of ["Исследует куст", "Любопытничает", "Полон сил", "Хочется открытий", "Чувствует себя уютно", "Занят своими делами"]) assert.ok(markup.includes(value));
  assert.doesNotMatch(markup, /Увлёкся|private-ai-reason|progressbar|aria-live|80%|90%/);
  assert.equal(profile().markup, profile({ observation: { ...observation, activity: "Провожает бабочку", detail: "Другая анимация" } }).markup);
  assert.match(mood({ observation: { ...observation, activity: "Провожает бабочку" } }).markup, /Провожает бабочку/);
});

test("mood module keeps missing and paused character controls safe, and offers an explicit wake action", () => {
  for (const unavailable of [null, { ...observation, paused: true }]) {
    const view = mood({ observation: unavailable });
    assert.equal(namedButton(view, "Позвать Мохлика").props.disabled, true);
    if (!unavailable) assert.doesNotMatch(view.markup, /Самочувствие Мохлика|Любопытничает/);
  }
  const sleeping = mood({ observation: { ...observation, sleeping: true } });
  namedButton(sleeping, "Разбудить Мохлика").props.onClick();
  namedButton(sleeping, "Как заботиться о Мохлике").props.onClick();
  namedButton(sleeping, "Еда").props.onClick();
  assert.deepEqual(sleeping.calls, ["call", "help", "food"]);
});

test("the meal card uses saved pending or active work bonuses independently of mood energy", () => {
  const state = freshEconomy();
  const recipeMeal = economyCatalog.food.meals.find(meal => meal.heroSpeedBps === 2500);
  state.food = { heroMeal: recipeMeal.itemId, builderMeal: null };
  const before = structuredClone(state);
  const pending = mood({ economy: { snapshot: state }, observation: { ...observation, needs: { ...observation.needs, energy: .1 } } });
  assert.match(pending.markup, /Пора передохнуть/);
  assert.match(pending.markup, /Еда: \+25% к скорости/);
  assert.match(pending.markup, /Бонус ждёт следующую вылазку/);
  assert.deepEqual(state, before, "rendering never consumes the pending meal");
  state.food.heroMeal = null;
  state.jobs = [{ kind: "exploration", meal: { itemId: recipeMeal.itemId, consumer: "hero", speedBps: 2500 } }];
  assert.match(mood({ economy: { snapshot: state } }).markup, /Бонус учтён в текущей вылазке/);
  state.jobs = [{ kind: "construction", meal: { itemId: recipeMeal.itemId, consumer: "builder", speedBps: 1000 } }];
  const builderOnly = mood({ economy: { snapshot: state } });
  assert.doesNotMatch(builderOnly.markup, /Еда: \+/);
  assert.match(builderOnly.markup, /Силы восстанавливаются во время отдыха/);
  assert.doesNotMatch(mood({ economy: { snapshot: null } }).markup, /Бонус от еды/);
});

test("friends tab receives parent data and navigation without claiming friend profiles are available", () => {
  const friends = { data: null, loading: true, error: null, onRefresh() {} };
  const onOpenPeople = () => {};
  const view = profile({ activeTab: "friends", friends, onOpenPeople });
  const component = view.elements.find(element => element.type?.name === "WorldProfileFriends");
  assert.equal(component.props.friends, friends);
  assert.equal(component.props.onOpenPeople, onOpenPeople);
  assert.match(view.markup, /Загружаем/);
  assert.doesNotMatch(view.markup, /Достижения Мохлика|Бонус от еды/);
});
