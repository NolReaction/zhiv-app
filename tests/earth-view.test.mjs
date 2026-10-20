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
  assert.match(html, /Геопозиция видна, когда друг ей делится/);
  assert.match(html, /Нет доступной геопозиции/);
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
  assert.match(html, /1,5 км/);
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

test("meeting opens only the selected shared point and stays separate from map focus and game actions", () => {
  const people = { people: [{ circleId: "shared", user: { publicId: "SHARED", displayName: "Лена" }, nickname: null },
    { circleId: "private", user: { publicId: "PRIVATE", displayName: "Дима" }, nickname: null }] };
  const locations = [{ circleId: "shared", user: people.people[0].user, latitude: 55.751234, longitude: 37.621234,
    accuracyMeters: 20, precision: "PRECISE", updatedAt: "2026-10-20T12:00:00Z", expiresAt: "2026-10-20T13:00:00Z", expiresAtMonotonic: 3_600_000 }];
  const calls = [], buttons = [];
  const tree = EarthFriends({ ...defaults, people, locations,
    onFocusPerson: id => calls.push(["focus", id]), onMeetPerson: id => calls.push(["meet", id]) });
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === "button") buttons.push(node);
    Children.forEach(node.props.children, walk);
  }
  walk(tree);
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/Подойти к другу/g) ?? []).length, 1);
  assert.doesNotMatch(html, /55\.751234|37\.621234|latitude|longitude|SHARED|PRIVATE/);
  const meet = buttons.find(button => !button.props["aria-label"] && renderToStaticMarkup(button).includes("Подойти к другу"));
  assert.ok(meet);
  assert.deepEqual(calls, [], "Rendering never starts acquisition, navigation or a meeting");
  meet.props.onClick();
  assert.deepEqual(calls, [["meet", "shared"]]);
  buttons.find(button => button.props["aria-label"] === "Показать на карте: Лена").props.onClick();
  assert.deepEqual(calls, [["meet", "shared"], ["focus", "shared"]]);
});

test("check-in and location remain independently authorized in the Earth friend card", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const user = { publicId: "FRIEND", displayName: "Лена" };
  const base = { circleId: "friend", user, nickname: null, lastCheckInAt: "2026-10-20T11:55:00Z", checkInState: "AVAILABLE" };
  const marked = renderToStaticMarkup(EarthFriends({ ...defaults, now, people: { people: [base] }, onMeetPerson() {} }));
  assert.match(marked, /«Я живой» · /);
  assert.match(marked, /5 мин назад/);
  assert.match(marked, /Нет доступной геопозиции/);
  assert.doesNotMatch(marked, /Подойти к другу/);
  const locations = [{ circleId: "friend", user, latitude: 55.75, longitude: 37.62, accuracyMeters: 20,
    precision: "PRECISE", updatedAt: "2026-10-20T11:59:00Z", expiresAt: "2026-10-20T13:00:00Z", expiresAtMonotonic: 3_600_000 }];
  const located = renderToStaticMarkup(EarthFriends({ ...defaults, now, people: { people: [{ ...base, checkInState: "HIDDEN" }] }, locations, onMeetPerson() {} }));
  assert.match(located, /Отметки недоступны/);
  assert.match(located, /Подойти к другу/);
  assert.doesNotMatch(located, /5 мин назад|55\.75|37\.62|GHOST/);
});
