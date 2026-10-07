import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldBuilderDialog, BuilderConversation } = await vite.ssrLoadModule("/features/world/world-builder-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const now = Date.parse("2026-10-06T12:00:00Z");
const job = { id: "paid-home-upgrade", kind: "construction", targetId: "home", targetLevel: 2, startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 90_000).toISOString() };
function economy(jobs = [], overrides = {}) {
  return { snapshot: { ownerPublicId: "BUILDER-PLAYER", revision: 1, wallet: { coins: 0, pearls: 1000 }, inventory: {}, buildings: { home: 1, warehouse: 1 }, jobs, catalog: economyCatalog }, now, busy: false, uncertain: false, error: null, retryAt: 0,
    act() { assert.fail("opening a builder conversation cannot issue economy commands"); }, retry() {}, ...overrides };
}
function elements(tree) {
  const found = [];
  function visit(element) {
    if (!isValidElement(element)) return;
    found.push(element); Children.forEach(element.props.children, visit);
  }
  visit(tree); return found;
}
function conversation(controller, onOpenConstruction = () => assert.fail("rendering cannot navigate")) {
  const tree = BuilderConversation({ economy: controller, onOpenConstruction });
  return { tree, html: renderToStaticMarkup(tree) };
}

test("a free builder is distinct from an unavailable account snapshot and ignores production", () => {
  for (const jobs of [[], [{ ...job, kind: "production" }], [{ ...job, kind: "exploration" }]]) {
    const { html } = conversation(economy(jobs));
    assert.match(html, /data-builder-status="free"/);
    assert.match(html, /Свободен/);
    assert.match(html, /Выберите здание для улучшения/);
    assert.doesNotMatch(html, /Завершить улучшение|Нанять|Жемчуг/);
    assert.match(html, /data-meal-boost="builder"/);
    assert.equal([...html.matchAll(/<button\b/g)].length, 1, "a free builder offers only optional food, not a paid build or hire action");
  }
  const { html } = conversation(economy([], { snapshot: null }));
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /Свободен|К постройке/);
});

test("confirmed work shows its building, timer and pearl completion; navigation only opens that upgrade", () => {
  const controller = economy([job]), opened = [], before = structuredClone(controller.snapshot);
  const { tree, html } = conversation(controller, id => opened.push(id));
  assert.match(html, /data-builder-status="working"/);
  assert.match(html, /Занят улучшением/);
  assert.match(html, new RegExp(economyCatalog.buildings.find(building => building.id === "home").name));
  assert.match(html, /Уровень 2/);
  assert.match(html, /Осталось 2 мин/);
  assert.match(html, /Завершить сейчас за 8 жемчужин/);
  assert.match(html, /data-construction-speedup="paid-home-upgrade"/);
  const buttons = elements(tree).filter(element => element.type === "button");
  assert.equal(buttons.length, 1); buttons[0].props.onClick();
  assert.deepEqual(opened, ["home"]);
  assert.deepEqual(controller.snapshot, before);
});

test("finished but unclaimed work keeps the builder reserved and links to completion", () => {
  const controller = economy([job], { now: now + 90_000 }), opened = [];
  const { tree, html } = conversation(controller, id => opened.push(id));
  assert.match(html, /data-builder-status="ready"/);
  assert.match(html, /Работа закончена — завершите улучшение/);
  assert.doesNotMatch(html, /Свободен|Осталось/);
  assert.doesNotMatch(html, /data-construction-speedup|жемчужин/);
  const button = elements(tree).find(element => element.type === "button");
  button.props.onClick(); assert.deepEqual(opened, ["home"]);
  const next = conversation(economy());
  assert.match(next.html, /data-builder-status="free"/);
});

test("a pending pearl command stays visible in the builder and retries respect transport cooldown", () => {
  let retries = 0;
  const controller = economy([job], { uncertain: true, error: "Нет связи", retryAt: now + 1000, retry() { retries++; } });
  let view = conversation(controller);
  assert.match(view.html, /Проверяем последнее действие/);
  const retry = elements(view.tree).find(element => element.type === "button" && element.props.children === "Проверить результат");
  assert.equal(retry.props.disabled, true);
  retry.props.onClick(); assert.equal(retries, 0);
  assert.match(view.html, /disabled=""[^>]*aria-label="Завершить сейчас за 8 жемчужин"/);
  controller.now += 1000;
  view = conversation(controller);
  elements(view.tree).find(element => element.type === "button" && element.props.children === "Проверить результат").props.onClick();
  assert.equal(retries, 1);
});

test("short remaining times count seconds and account changes do not retain a previous building", () => {
  assert.match(conversation(economy([job], { now: now + 60_000 })).html, /Осталось 30 с/);
  const other = { ...job, targetId: "warehouse", targetLevel: 3 };
  const { html } = conversation(economy([other]));
  assert.match(html, new RegExp(economyCatalog.buildings.find(building => building.id === "warehouse").name));
  assert.match(html, /Уровень 3/);
  assert.doesNotMatch(conversation(economy([], { snapshot: null })).html, /Уровень 3/);
});

test("an unavailable snapshot offers the existing retry and respects its cooldown", () => {
  let retries = 0;
  for (const locked of [false, true]) {
    const controller = economy([], { snapshot: null, error: "Нет связи", retryAt: locked ? now + 1000 : 0, retry() { retries++; } });
    const { tree, html } = conversation(controller);
    assert.match(html, /role="alert"/); assert.match(html, /Нет связи/);
    const button = elements(tree).find(element => element.type === "button");
    assert.equal(button.props.disabled, locked);
    if (!locked) button.props.onClick();
    assert.doesNotMatch(html, /Свободен/);
  }
  assert.equal(retries, 1);
});

test("the builder dialog has animated code art and preserves back, close and focus ownership", () => {
  let closed = 0, backed = 0, focused = 0;
  const tree = WorldBuilderDialog({ open: true, economy: economy(), onOpenConstruction() {}, onClose() { closed++; }, onBack() { backed++; }, onCloseAutoFocus() { focused++; } });
  const nodes = elements(tree);
  assert.equal(tree.props.open, true); tree.props.onOpenChange(false); assert.equal(closed, 1);
  const portrait = nodes.find(element => element.type.name === "BuilderPortrait");
  assert.equal(portrait.props.animated, true);
  const header = nodes.find(element => element.type === "header");
  assert.match(renderToStaticMarkup(createElement(tree.type, { open: true }, header)), /Шишколап/);
  const close = nodes.find(element => element.props["aria-label"] === "Попрощаться с Шишколапом");
  close.props.onClick(); assert.equal(closed, 2);
  const back = nodes.find(element => element.type === "button" && element.props.onClick !== close.props.onClick);
  back.props.onClick(); assert.equal(backed, 1);
  nodes.find(element => element.props["data-slot"] === "dialog-content").props.onCloseAutoFocus({});
  assert.equal(focused, 1);
  const direct = WorldBuilderDialog({ open: true, economy: economy(), onOpenConstruction() {}, onClose() {}, onCloseAutoFocus() {} });
  assert.equal(elements(direct).filter(element => element.type === "button").length, 1, "direct map entry has only its close control");
});
