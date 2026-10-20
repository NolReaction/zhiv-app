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
  assert.equal(locationSummary("paused", fix), "Последняя геопозиция · обновление остановлено");
  assert.equal(locationSummary("paused", null), "Обновление на паузе");
  assert.equal(locationSummary("requesting", fix), "Определяем местоположение…");
  assert.equal(locationSummary("denied", null), "Найдите себя на Земле");
  assert.equal(locationSummary("unavailable", fix), "Последняя геопозиция · свежая пока недоступна");
  assert.equal(locationSummary("timeout", fix), "Последняя геопозиция · свежая пока недоступна");
});

test("Earth friends lists actual contacts without claiming their location is shared", () => {
  const people = { people: [{ circleId: "friend-one", user: { publicId: "TEST-1", displayName: "<script>friend</script>" }, nickname: null }] };
  const html = renderToStaticMarkup(EarthFriends({ ...defaults, people }));
  assert.match(html, /&lt;script&gt;friend&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Выбери близкого/);
  assert.match(html, /Геопозиция недоступна/);
  assert.doesNotMatch(html, /latitude|longitude|TEST-1/);
});

test("only an available authorized friend gets a map action, without exposing coordinates in HTML", () => {
  const people = { people: [{ circleId: "friend-one", user: { publicId: "TEST-1", displayName: "Лена" }, nickname: null },
    { circleId: "friend-two", user: { publicId: "TEST-2", displayName: "Дима" }, nickname: null }] };
  const locations = [{ circleId: "friend-one", user: people.people[0].user, latitude: 55.75, longitude: 37.62,
    accuracyMeters: 1500, precision: "APPROXIMATE", updatedAt: "2026-10-18T20:00:00Z", expiresAt: "2026-10-18T20:02:00Z", expiresAtMonotonic: 120_000 }];
  const calls = [];
  const tree = EarthFriends({ ...defaults, people, locations, onFocusPerson: id => calls.push(id) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Примерный район/);
  assert.doesNotMatch(html, /1,5 км|Обновлено|Погрешность/);
  assert.equal((html.match(/Показать на карте:/g) ?? []).length, 1);
  assert.doesNotMatch(html, /55\.75|37\.62|publicationEpoch|GHOST|TEST-1/);
  const buttons = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === "button" && node.props["aria-label"]?.startsWith("Показать на карте:")) buttons.push(node);
    Children.forEach(node.props.children, walk);
  }
  walk(tree);
  buttons[0].props.onClick();
  assert.deepEqual(calls, ["friend-one"]);
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

test("the nearby roster has one compact focus action per shared participant and no meeting, profile or visit actions", () => {
  const people = { people: [{ circleId: "shared", user: { publicId: "SHARED", displayName: "Лена" }, nickname: null },
    { circleId: "private", user: { publicId: "PRIVATE", displayName: "Дима" }, nickname: null }] };
  const locations = [{ circleId: "shared", user: people.people[0].user, latitude: 55.751234, longitude: 37.621234,
    accuracyMeters: 20, precision: "PRECISE", updatedAt: "2026-10-20T12:00:00Z", expiresAt: "2026-10-20T13:00:00Z", expiresAtMonotonic: 3_600_000 }];
  const calls = [], buttons = [];
  const tree = EarthFriends({ ...defaults, people, locations, onFocusPerson: id => calls.push(id) });
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === "button") buttons.push(node);
    Children.forEach(node.props.children, walk);
  }
  walk(tree);
  const html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /Подойти к другу|Игровой профиль|В гости|55\.751234|37\.621234|latitude|longitude|SHARED|PRIVATE/);
  assert.equal(buttons.filter(button => button.props["aria-label"]?.startsWith("Показать на карте:")).length, 1);
  assert.deepEqual(calls, [], "Rendering never starts acquisition, navigation or a meeting");
  buttons.find(button => button.props["aria-label"] === "Показать на карте: Лена").props.onClick();
  assert.deepEqual(calls, ["shared"]);
  const unavailable = buttons.find(button => button.props["aria-label"] === "Дима: геопозиция недоступна");
  assert.equal(unavailable.props.disabled, true);
  unavailable.props.onClick();
  assert.deepEqual(calls, ["shared"]);
});

test("a reused relationship ID cannot attach another person's geographic point to the roster", () => {
  const people = { people: [{ circleId: "same", user: { publicId: "CURRENT", displayName: "Лена" } }] };
  const locations = [{ circleId: "same", user: { publicId: "FORMER", displayName: "Друг" }, latitude: 55.75, longitude: 37.62 }];
  const html = renderToStaticMarkup(EarthFriends({ ...defaults, people, locations, onFocusPerson() {} }));
  assert.match(html, /Лена/); assert.match(html, /геопозиция недоступна/);
  assert.doesNotMatch(html, /Показать на карте|55\.75|37\.62|FORMER|CURRENT/);
});
