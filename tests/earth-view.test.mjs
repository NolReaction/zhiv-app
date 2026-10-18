import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthFriends, locationSummary } = await vite.ssrLoadModule("/features/earth/earth-view.tsx");
const defaults = { people: null, loading: false, error: null, online: true, onRefresh() {}, onOpenPeople() {} };

test("Earth location summary shows measured precision and does not present paused fixes as current", () => {
  const fix = { latitude: 55, longitude: 37, accuracy: 42.2, timestamp: Date.now() };
  assert.equal(locationSummary("active", fix), "Вы на карте · точность ±42 м");
  assert.match(locationSummary("active", { ...fix, accuracy: 12_500 }), /12,5 км/);
  assert.equal(locationSummary("paused", fix), "Обновление на паузе");
  assert.equal(locationSummary("requesting", fix), "Определяем местоположение…");
  assert.equal(locationSummary("denied", null), "Найдите себя на Земле");
});

test("Earth friends lists actual contacts without claiming their location is shared", () => {
  const people = { people: [{ circleId: "friend-one", user: { publicId: "TEST-1", displayName: "<script>friend</script>" }, nickname: null }] };
  const html = renderToStaticMarkup(EarthFriends({ ...defaults, people }));
  assert.match(html, /&lt;script&gt;friend&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Обмен геопозицией ещё готовится/);
  assert.match(html, /Геопозиция пока недоступна/);
  assert.doesNotMatch(html, /latitude|longitude|TEST-1/);
});

test("empty, offline, stale and loading friends remain explicit and actionable", () => {
  assert.match(renderToStaticMarkup(EarthFriends(defaults)), /Обновите список/);
  assert.match(renderToStaticMarkup(EarthFriends({ ...defaults, people: { people: [] } })), /Добавьте близких/);
  assert.match(renderToStaticMarkup(EarthFriends({ ...defaults, online: false })), /Список может быть неактуален/);
  assert.match(renderToStaticMarkup(EarthFriends({ ...defaults, error: "network" })), /Не удалось обновить/);
  assert.match(renderToStaticMarkup(EarthFriends({ ...defaults, loading: true })), /Обновляем список/);
  const calls = [];
  const tree = EarthFriends({ ...defaults, onRefresh: () => calls.push("refresh"), onOpenPeople: () => calls.push("people") });
  const buttons = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === "button") buttons.push(node);
    Children.forEach(node.props.children, walk);
  }
  walk(tree);
  buttons.forEach(button => button.props.onClick());
  assert.deepEqual(calls, ["people", "refresh"]);
});
