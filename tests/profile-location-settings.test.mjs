import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ProfileLocationSettingsContent } = await vite.ssrLoadModule("/features/account/profile-location-settings.tsx");
const { SharingSwitch } = await vite.ssrLoadModule("/components/sharing-switch.tsx");
const idle = { position: null, status: "idle", error: null };
const text = node => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";

function view(overrides = {}) {
  const calls = [];
  const props = { enabled: true, onEnabledChange: enabled => calls.push(["enabled", enabled]), location: idle,
    onLocate: () => calls.push(["locate"]), onStop: () => calls.push(["stop"]), ...overrides };
  const tree = ProfileLocationSettingsContent(props), elements = [];
  function walk(node) { if (!isValidElement(node)) return; elements.push(node); Children.forEach(node.props.children, walk); }
  walk(tree);
  return { calls, props, elements, markup: renderToStaticMarkup(tree),
    button: label => elements.find(node => node.type === "button" && text(node) === label),
    toggle: elements.find(node => node.type === SharingSwitch) };
}

test("settings rendering or enabling availability never requests coordinates or shares", () => {
  const result = view();
  assert.deepEqual(result.calls, []);
  assert.equal(result.toggle.props.checked, true);
  assert.equal(result.toggle.props.id, "profile-location-enabled");
  result.toggle.props.onCheckedChange(false);
  result.toggle.props.onCheckedChange(true);
  assert.deepEqual(result.calls, [["enabled", false], ["enabled", true]]);
  assert.match(result.markup, /не передаёт координаты друзьям/);
  result.button("Проверить геопозицию").props.onClick();
  assert.deepEqual(result.calls.at(-1), ["locate"]);
});

test("full OFF has no lookup and distinguishes local stop from pending server deletion", () => {
  const calls = [];
  const result = view({ enabled: false, privacy: { settings: { mode: "OFF" }, pendingGhost: true,
    pendingPrivacyMode: "OFF", error: "Нет сети", off: () => calls.push("off") } });
  assert.equal(result.button("Проверить геопозицию"), undefined);
  assert.equal(result.button("Остановить"), undefined);
  assert.match(result.markup, /Частная точка на устройстве очищена/);
  assert.match(result.markup, /До подтверждения сервера/);
  assert.match(result.markup, /Нет сети/);
  result.button("Повторить закрытие доступа").props.onClick();
  assert.deepEqual(calls, ["off"]);
  assert.deepEqual(result.calls, []);
  const confirmed = view({ enabled: false, privacy: { settings: { mode: "OFF" }, pendingGhost: false, error: null } });
  assert.match(confirmed.markup, /Доступ друзей к вашему месту закрыт/);
  assert.doesNotMatch(confirmed.markup, /До подтверждения сервера/);
});

test("coarse fixes retain honest accuracy; errors are escaped and stop stays explicit", () => {
  const result = view({ location: { position: { latitude: 50, longitude: 30, accuracy: 12500, timestamp: 1000 }, status: "active", error: null } });
  assert.match(result.markup, /Примерное место · точность ±12,5 км/);
  result.button("Остановить").props.onClick();
  assert.deepEqual(result.calls, [["stop"]]);
  const failure = view({ location: { ...idle, status: "unavailable", error: "<script>Ошибка браузера</script>" } });
  assert.match(failure.markup, /&lt;script&gt;Ошибка браузера/);
  assert.doesNotMatch(failure.markup, /<script>/);
  assert.ok(failure.button("Проверить геопозицию"));
  assert.doesNotMatch(failure.markup, /Проверка начнётся только/);
  const retry = view({ location: { ...idle, status: "denied", error: "Нажмите «Найти меня»." } });
  assert.match(retry.markup, /Нажмите «Проверить геопозицию»/);
});

test("requesting state cannot launch a second check but can be stopped", () => {
  const result = view({ location: { ...idle, status: "requesting" } });
  assert.equal(result.button("Определяем…").props.disabled, true);
  assert.ok(result.button("Остановить"));
  assert.match(result.markup, /Ждём координаты от браузера/);
});
