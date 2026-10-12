import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { NotificationDeviceCard } = await vite.ssrLoadModule("/features/notifications/notification-device-card.tsx");

function card(patch = {}) {
  const calls = { toggle: 0, retry: 0 };
  const state = { connected: false, configured: true, support: { supported: true, reason: null }, permission: "default", phase: "idle", prepared: true, isOnline: true, error: "", notice: "", disabled: false, ...patch };
  const tree = NotificationDeviceCard({ id: "push-test", state, onToggle: () => calls.toggle++, onRetry: () => calls.retry++ });
  const nodes = [];
  function walk(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  return { nodes, calls, tree, markup: renderToStaticMarkup(tree), buttons: nodes.filter(node => node.type === "button") };
}

test("ready device requires the explicit button gesture and rendering never connects", () => {
  const view = card();
  assert.deepEqual(view.calls, { toggle: 0, retry: 0 });
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].props.children, "Подключить на устройстве");
  assert.equal(view.buttons[0].props.disabled, false);
  assert.equal(view.buttons[0].props["aria-busy"], false);
  assert.match(view.markup, /На этом устройстве выключены/);
  assert.doesNotMatch(view.markup, /Подключены на этом устройстве/);
  view.buttons[0].props.onClick();
  assert.deepEqual(view.calls, { toggle: 1, retry: 0 });
});

test("granted browser permission remains visibly incomplete until the server confirms connection", () => {
  const view = card({ permission: "granted" });
  assert.match(view.markup, /Разрешение получено, подключение не завершено/);
  assert.equal(view.buttons[0].props.children, "Завершить подключение");
  assert.doesNotMatch(view.markup, /Подключены на этом устройстве/);
  view.buttons[0].props.onClick();
  assert.deepEqual(view.calls, { toggle: 1, retry: 0 });
  const confirmed = card({ permission: "granted", connected: true });
  assert.match(confirmed.markup, /Подключены на этом устройстве/);
  assert.equal(confirmed.buttons[0].props.children, "Выключить здесь");
});

test("each pending stage has adjacent live progress and blocks repeated actions", () => {
  const phases = {
    preparing: "Проверяем готовность устройства…",
    subscribing: "Подключаем уведомления в браузере…",
    saving: "Сохраняем подключение к вашему профилю…",
    disconnecting: "Выключаем уведомления на этом устройстве…",
  };
  for (const [phase, label] of Object.entries(phases)) {
    const view = card({ phase, prepared: false, connected: phase === "disconnecting", notice: "Прежнее сообщение" });
    const status = view.nodes.find(node => node.props.role === "status");
    assert.equal(status.props.children, label);
    assert.equal(status.props["aria-live"], "polite");
    assert.equal(status.props["aria-atomic"], "true");
    assert.equal(view.buttons[0].props.disabled, true);
    assert.equal(view.buttons[0].props["aria-busy"], true);
    assert.match(view.buttons[0].props["aria-describedby"], /push-test-device-status/);
    assert.doesNotMatch(view.markup, /Прежнее сообщение|PushSubscription|VAPID|service worker/);
    view.buttons[0].props.onClick();
    assert.deepEqual(view.calls, { toggle: 0, retry: 0 });
  }
});

test("preparation failure offers retry without attempting a subscription and keeps the error at the button", () => {
  const view = card({ permission: "granted", prepared: false, error: "Не удалось подготовить устройство. Повторите проверку." });
  assert.equal(view.buttons[0].props.children, "Повторить проверку");
  assert.equal(view.buttons[0].props.disabled, false);
  const alert = view.nodes.find(node => node.props.role === "alert");
  assert.equal(alert.props.id, "push-test-device-error");
  assert.match(view.buttons[0].props["aria-describedby"], /push-test-device-error/);
  const immediateChildren = node => { const children = []; Children.forEach(node.props.children, child => children.push(child)); return children; };
  const actionGroup = view.nodes.find(node => immediateChildren(node).includes(view.buttons[0]));
  assert.ok(actionGroup);
  assert.ok(immediateChildren(actionGroup).includes(alert));
  view.buttons[0].props.onClick();
  assert.deepEqual(view.calls, { toggle: 0, retry: 1 });
});

test("unsupported and unconfigured devices explain the blocker without a usable connect action", () => {
  const reason = "На iPhone добавьте приложение на экран «Домой» и откройте его оттуда.";
  for (const patch of [
    { support: { supported: false, reason } },
    { configured: false },
    { configured: false, support: { supported: false, reason } },
    { support: { supported: false, reason: null }, permission: "unavailable" },
  ]) {
    const view = card(patch);
    assert.equal(view.buttons.length, 0);
    assert.deepEqual(view.calls, { toggle: 0, retry: 0 });
    assert.doesNotMatch(view.markup, /Нажмите кнопку/);
    if (patch.support?.reason) assert.ok(view.markup.includes(reason));
    if (patch.configured === false) assert.match(view.markup, /Отправка ещё не подключена на сервере/);
  }
});

test("confirmed connection can always be disconnected online despite missing preparation or support", () => {
  const view = card({ connected: true, configured: false, prepared: false, permission: "denied", support: { supported: false, reason: "Разрешение браузера выключено." } });
  assert.equal(view.buttons[0].props.children, "Выключить здесь");
  assert.equal(view.buttons[0].props.disabled, false);
  view.buttons[0].props.onClick();
  assert.deepEqual(view.calls, { toggle: 1, retry: 0 });
});

test("stored connections with revoked permission or disabled server do not imply active delivery", () => {
  const denied = card({ connected: true, permission: "denied", support: { supported: false, reason: null } });
  assert.match(denied.markup, /Устройство подключено, уведомления запрещены/);
  assert.match(denied.markup, /Разрешите уведомления в настройках/);
  assert.doesNotMatch(denied.markup, /Подключены на этом устройстве/);
  assert.equal(denied.buttons[0].props.disabled, false);
  const unconfigured = card({ connected: true, configured: false, permission: "granted" });
  assert.match(unconfigured.markup, /Устройство подключено, отправка недоступна/);
  assert.doesNotMatch(unconfigured.markup, /Подключены на этом устройстве/);
  assert.equal(unconfigured.buttons[0].props.disabled, false);
});

test("offline and external disabled states prevent both retry and toggle with an explicit offline hint", () => {
  for (const patch of [{}, { prepared: false }, { connected: true, prepared: false }]) {
    const offline = card({ ...patch, isOnline: false });
    assert.equal(offline.buttons[0].props.disabled, true);
    assert.match(offline.markup, /интернет/);
    assert.match(offline.buttons[0].props["aria-describedby"], /push-test-device-offline/);
    offline.buttons[0].props.onClick();
    assert.deepEqual(offline.calls, { toggle: 0, retry: 0 });
    const disabled = card({ ...patch, disabled: true });
    assert.equal(disabled.buttons[0].props.disabled, true);
    disabled.buttons[0].props.onClick();
    assert.deepEqual(disabled.calls, { toggle: 0, retry: 0 });
  }
});

test("accessible descriptions reference existing messages and errors supersede stale notices", () => {
  const view = card({ permission: "granted", error: "Подключение не сохранено. Попробуйте ещё раз.", notice: "Успешно подключено" });
  assert.equal(view.nodes.filter(node => node.props.role === "alert").length, 1);
  assert.doesNotMatch(view.markup, /Успешно подключено/);
  const ids = new Set(view.nodes.map(node => node.props.id).filter(Boolean));
  for (const node of view.nodes) {
    for (const attribute of ["aria-describedby", "aria-labelledby"]) {
      for (const id of node.props[attribute]?.split(" ") ?? []) assert.ok(ids.has(id), `${attribute}: ${id}`);
    }
  }
  const noticed = card({ connected: true, notice: "Устройство успешно подключено" });
  assert.equal(noticed.nodes.find(node => node.props.role === "status").props.children, "Устройство успешно подключено");
});
