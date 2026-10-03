import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldProfileContent } = await vite.ssrLoadModule("/features/world/world-profile-menu.tsx");
const { newWorldState, worldCatalog } = await vite.ssrLoadModule("/features/world/model.ts");

const observation = {
  activity: "Исследует куст", detail: "Увлёкся интересной находкой", mood: "Любопытничает",
  needs: { energy: .8, curiosity: .7, comfort: .9, attention: 0 }, sleeping: false, paused: false,
  memory: { status: "saved", savedAt: 1000, sync: { mode: "synced", revision: 2, serverSavedAt: 1000, canTakeOver: false } },
  diagnostics: { reason: "private-ai-reason", candidates: [], events: [] },
};

function profile(overrides = {}) {
  const calls = [];
  const tree = WorldProfileContent({
    world: { snapshot: { state: { ...newWorldState(), houseLevel: 1, collection: [worldCatalog.finds[0].id] } } },
    economy: { snapshot: { buildings: { home: 3 }, completedExplorations: 7 } },
    displayName: "Дима", level: 12, bestStreakDays: 21, observation,
    onCall: () => calls.push("call"), onTakeOver: () => calls.push("takeover"), ...overrides,
  });
  const elements = [];
  function walk(child) {
    if (!isValidElement(child)) return;
    elements.push(child);
    Children.forEach(child.props.children, walk);
  }
  walk(tree);
  return { markup: renderToStaticMarkup(tree), elements, calls };
}
const buttonText = button => Children.toArray(button.props.children).filter(child => typeof child === "string").join("");

test("map profile uses the authoritative home level and completed progress without duplicate inventory or house actions", () => {
  const { markup, elements } = profile();
  assert.match(markup, /Дима/);
  assert.match(markup, /Уровень 12/);
  assert.match(markup, /<dt>Дом<\/dt><dd>3 ур\.<\/dd>/);
  assert.match(markup, /<dt>Исследования<\/dt><dd>7<\/dd>/);
  assert.ok(markup.includes(`1 / ${worldCatalog.finds.length}`));
  assert.match(markup, /21 день/);
  assert.deepEqual(elements.filter(element => element.type === "button").map(buttonText), ["Позвать Мохлика"]);
  assert.doesNotMatch(markup, /Кладовая|Гардероб|Обустроить дом|Прежние походы/);
});

test("profile reports stable feelings rather than animation phases, percentages or private AI details", () => {
  const { markup } = profile();
  for (const value of ["Любопытничает", "Полон сил", "Хочется открытий", "Чувствует себя уютно", "Занят своими делами"]) assert.ok(markup.includes(value));
  assert.doesNotMatch(markup, /Исследует куст|Увлёкся|private-ai-reason|progressbar|aria-live/);
  assert.equal(markup, profile({ observation: { ...observation, activity: "Провожает бабочку", detail: "Другая анимация" } }).markup);
});

test("missing observations cannot call the character; missing economy is not presented as zero progress", () => {
  const view = profile({ observation: null, economy: { snapshot: null } });
  assert.match(view.markup, /когда полянка загрузится/);
  assert.match(view.markup, /<dt>Дом<\/dt><dd>1 ур\.<\/dd>/);
  assert.match(view.markup, /<dt>Исследования<\/dt><dd>—<\/dd>/);
  assert.equal(view.elements.find(element => element.type === "button").props.disabled, true);
  assert.doesNotMatch(view.markup, /Полон сил|Память сохранена/);
  assert.match(profile({ world: { snapshot: { state: { ...newWorldState(), completedJourneys: 2 } } } }).markup, /<dt>Прежние походы<\/dt><dd>2<\/dd>/);
});

test("the profile keeps explicit session takeover and prevents calling a paused character", () => {
  const elsewhere = { ...observation, paused: true, memory: { ...observation.memory, sync: { ...observation.memory.sync, mode: "other-device", canTakeOver: true } } };
  const view = profile({ observation: elsewhere });
  assert.match(view.markup, /другом устройстве или в другой вкладке/);
  assert.match(view.markup, /полянка на паузе/);
  const buttons = view.elements.filter(element => element.type === "button");
  const takeover = buttons.find(button => buttonText(button) === "Продолжить здесь");
  takeover.props.onClick();
  assert.deepEqual(view.calls, ["takeover"]);
  assert.equal(buttons.find(button => buttonText(button) === "Позвать Мохлика").props.disabled, true);
  const normal = profile();
  assert.doesNotMatch(normal.markup, /Продолжить здесь/);
  normal.elements.find(element => element.type === "button").props.onClick();
  assert.deepEqual(normal.calls, ["call"]);
});

test("memory messages retain offline recovery, initial-save and local-only distinctions", () => {
  const withSync = patch => profile({ observation: { ...observation, memory: { ...observation.memory, sync: { ...observation.memory.sync, ...patch } } } }).markup;
  assert.match(withSync({ mode: "offline" }), /загрузится последнее подтверждённое сохранение/);
  assert.doesNotMatch(withSync({ mode: "offline" }), /Память сохранена в аккаунте/);
  assert.match(withSync({ serverSavedAt: null }), /первое сохранение/);
  assert.match(withSync({ mode: "error" }), /перезагрузить приложение/);
  assert.match(withSync({ mode: "disabled" }), /память Мохлика не сохраняется/);
  const local = status => profile({ observation: { ...observation, memory: { status, savedAt: null } } }).markup;
  assert.match(local("saved"), /только на этом устройстве/);
  assert.match(local("session"), /только на время этой сессии/);
  assert.match(local("unavailable"), /Не удаётся сохранить память/);
  assert.doesNotMatch(local("saved"), /Память сохранена в аккаунте/);
});
