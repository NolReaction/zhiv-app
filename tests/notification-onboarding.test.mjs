import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { NotificationOnboardingCard } = await vite.ssrLoadModule("/features/notifications/notification-onboarding-prompt.tsx");

function card(patch = {}) {
  const calls = [];
  const state = { connected: false, configured: true, support: { supported: true, reason: null }, permission: "default",
    phase: "idle", prepared: true, isOnline: true, error: "", notice: "", disabled: false, ...patch };
  const tree = NotificationOnboardingCard({ id: "intro-push", state, onEnable: () => calls.push("enable"),
    onRetry: () => calls.push("retry"), onContinue: () => calls.push("continue") });
  const nodes = [];
  function walk(node) { if (!isValidElement(node)) return; nodes.push(node); Children.forEach(node.props.children, walk); }
  walk(tree);
  return { tree, calls, nodes, buttons: nodes.filter(node => node.type === "button"), html: renderToStaticMarkup(tree) };
}

test("first offer shows a direct permission action and an independent Later choice without connecting on render", () => {
  const view = card();
  assert.equal(view.tree.props["data-guide-step"], "notifications");
  assert.deepEqual(view.buttons.map(button => button.props.children), ["Включить уведомления", "Пока без уведомлений"]);
  assert.deepEqual(view.calls, []);
  view.buttons[0].props.onClick(); assert.deepEqual(view.calls, ["enable"]);
  view.buttons[1].props.onClick(); assert.deepEqual(view.calls, ["enable", "continue"]);
  assert.doesNotMatch(view.html, /Пропустить обучение|Пропустить<|VAPID|PushManager/);
});

test("preparation and offline never consume a gesture or block opting out", () => {
  for (const patch of [{ phase: "preparing", prepared: false }, { isOnline: false }]) {
    const view = card(patch);
    assert.equal(view.buttons[0].props.disabled, true);
    view.buttons[0].props.onClick(); assert.deepEqual(view.calls, []);
    assert.equal(view.buttons.at(-1).props.disabled, false);
    view.buttons.at(-1).props.onClick(); assert.deepEqual(view.calls, ["continue"]);
  }
});

test("already granted permission offers binding while connected devices never expose an unsubscribe action", () => {
  const granted = card({ permission: "granted" });
  assert.equal(granted.buttons[0].props.children, "Завершить подключение");
  granted.buttons[0].props.onClick(); assert.deepEqual(granted.calls, ["enable"]);
  const connected = card({ permission: "granted", connected: true });
  assert.equal(connected.buttons.length, 1);
  assert.equal(connected.buttons[0].props.children, "Продолжить знакомство");
  connected.buttons[0].props.onClick(); assert.deepEqual(connected.calls, ["continue"]);
  assert.doesNotMatch(connected.html, /Выключить|Пока без|Включить уведомления/);
});

test("unsupported, denied and unconfigured devices explain the reason and continue without a native request", () => {
  for (const patch of [{ support: { supported: false, reason: "Откройте приложение со значка на экране Домой." } },
    { permission: "denied", support: { supported: false, reason: "Уведомления запрещены в настройках устройства." } },
    { configured: false }]) {
    const view = card(patch);
    assert.equal(view.buttons.length, 1);
    assert.equal(view.buttons[0].props.children, "Продолжить знакомство");
    view.buttons[0].props.onClick(); assert.deepEqual(view.calls, ["continue"]);
    assert.ok(view.html.includes(patch.support?.reason ?? "Подключить уведомления можно будет позже"));
  }
});

test("failed preparation retries only readiness and preserves adjacent error feedback", () => {
  const view = card({ prepared: false, error: "Не удалось подготовить устройство" });
  assert.equal(view.buttons[0].props.children, "Повторить проверку");
  view.buttons[0].props.onClick(); assert.deepEqual(view.calls, ["retry"]);
  const error = view.nodes.find(node => node.props.role === "alert");
  assert.equal(error.props.id, "intro-push-error");
  assert.match(view.buttons[0].props["aria-describedby"], /intro-push-error/);
});

test("a retained server subscription never claims delivery works after browser permission is revoked", () => {
  for (const permission of ["denied", "unavailable"]) {
    const view = card({ connected: true, permission });
    assert.equal(view.buttons.length, 1);
    assert.doesNotMatch(view.html, /Уведомления уже подключены/);
    assert.match(view.html, permission === "denied" ? /запрещены/ : /недоступны/);
  }
});

test("native permission and server-save phases prevent duplicate actions and expose live progress", () => {
  for (const phase of ["subscribing", "saving"]) {
    const view = card({ phase });
    assert.ok(view.buttons.every(button => button.props.disabled));
    view.buttons[0].props.onClick(); assert.deepEqual(view.calls, []);
    assert.ok(view.nodes.some(node => node.props.role === "status" && node.props["aria-live"] === "polite"));
  }
});
