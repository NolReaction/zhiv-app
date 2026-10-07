import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/world-upgrade-dialog.tsx");
const { ConstructionGoalSummary } = await vite.ssrLoadModule("/features/economy/construction-goal-summary.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
after(() => vite.close());

function state() {
  return { catalog: economyCatalog, buildings: { home: 1, warehouse: 1, workshop: 1, woodlot: 1 }, jobs: [], inventory: {}, wallet: { coins: 0, pearls: 0 }, storage: { capacity: 100, used: 0 } };
}
function elements(tree) {
  const found = [];
  const visit = element => {
    if (!isValidElement(element)) return;
    found.push(element); Children.forEach(element.props.children, visit);
  };
  visit(tree); return found;
}
function upgrade(snapshot, constructionGoal, act = () => {}) {
  return elements(WorldUpgradeContent({ stationId: "home", economy: { snapshot, act, now: Date.now(), retryAt: 0 }, constructionGoal, onClose() {} }));
}
const pinButton = nodes => nodes.find(element => element.type === "button" && element.props["aria-pressed"] !== undefined);

test("pinning an unaffordable improvement is available and never spends materials", () => {
  const pins = [], payments = [];
  const controller = { goal: null, details: null, pin: id => pins.push(id), clear() {} };
  const button = pinButton(upgrade(state(), controller, (...args) => payments.push(args)));
  assert.equal(button.props["aria-pressed"], false);
  assert.equal(Boolean(button.props.disabled), false);
  button.props.onClick();
  assert.deepEqual(pins, ["home"]);
  assert.deepEqual(payments, []);
});

test("the same goal can be unpinned, while another goal is replaced explicitly", () => {
  for (const buildingId of ["home", "warehouse"]) {
    const calls = [];
    const controller = { goal: { buildingId, targetLevel: 2 }, details: null, pin: id => calls.push(["pin", id]), clear: () => calls.push(["clear"]) };
    const button = pinButton(upgrade(state(), controller));
    assert.equal(button.props["aria-pressed"], buildingId === "home");
    button.props.onClick();
    assert.deepEqual(calls, buildingId === "home" ? [["clear"]] : [["pin", "home"]]);
  }
});

test("already paid and fully upgraded buildings do not offer a savings goal", () => {
  const controller = { goal: null, details: null, pin() { throw Error("Must not pin"); }, clear() {} };
  const paid = state();
  paid.jobs = [{ id: "home-job", kind: "construction", targetId: "home", targetLevel: 2, startedAt: new Date().toISOString(), finishesAt: new Date(Date.now() + 60000).toISOString() }];
  assert.equal(pinButton(upgrade(paid, controller)), undefined);
  const maximum = state();
  maximum.buildings.home = Math.max(...economyCatalog.buildings.find(building => building.id === "home").levels.map(level => level.level));
  assert.equal(pinButton(upgrade(maximum, controller)), undefined);
});

test("goal summary shows the current shortfall and routes material taps without starting work", () => {
  const calls = [];
  const details = { goal: { buildingId: "home", targetLevel: 2 }, name: "Дом Мохлика", missing: { coins: 600, items: { wood: 7, stone: 0 } } };
  const controller = { goal: details.goal, details, clear: () => calls.push("clear"), pin() { throw Error("No goal change"); } };
  const tree = ConstructionGoalSummary({ state: state(), constructionGoal: controller, onOpenGoal: () => calls.push("goal"), navigation: { canOpen: () => true, open: id => calls.push(id) }, compact: true });
  const nodes = elements(tree);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Монеты: не хватает 600/);
  assert.match(html, /не хватает 7/);
  assert.doesNotMatch(html, /Камень|Материалы собраны/);
  nodes.find(element => element.props["aria-label"]?.startsWith("Где получить:")).props.onClick();
  nodes.find(element => element.props["aria-label"]?.startsWith("Открыть цель:")).props.onClick();
  nodes.find(element => element.props["aria-label"]?.startsWith("Снять цель:")).props.onClick();
  assert.deepEqual(calls, ["woodlot", "goal", "clear"]);
});

test("fully collected materials do not promise construction readiness while the builder is busy", () => {
  const snapshot = state();
  snapshot.jobs = [{ kind: "construction", targetId: "warehouse" }];
  const details = { goal: { buildingId: "home", targetLevel: 2 }, name: "Дом Мохлика", missing: { coins: 0, items: {} } };
  const html = renderToStaticMarkup(ConstructionGoalSummary({ state: snapshot, constructionGoal: { goal: details.goal, details, clear() {} }, onOpenGoal() {} }));
  assert.match(html, /Материалы собраны/);
  assert.doesNotMatch(html, /Можно строить|Начать обустройство|Улучшить до|Ещё нужно/);
  assert.equal(ConstructionGoalSummary({ state: snapshot, constructionGoal: { details: null }, onOpenGoal() {} }), null);
});
