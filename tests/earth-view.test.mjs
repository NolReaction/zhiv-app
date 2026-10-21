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

const collectButtons = tree => {
  const buttons = [];
  function walk(node) { if (!isValidElement(node)) return; if (node.type === "button") buttons.push(node); Children.forEach(node.props.children, walk); }
  walk(tree); return buttons;
};
const currentPoint = (circleId, user) => ({ circleId, user, latitude: 55.751234, longitude: 37.621234,
  accuracyMeters: 20, precision: "PRECISE", updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(), expiresAtMonotonic: performance.now() + 60_000 });

test("the horizontal map picker escapes participant names and does not duplicate contacts without a point", () => {
  const person = { circleId: "friend-one", user: { publicId: "TEST-1", displayName: "<script>friend</script>" }, nickname: null };
  const people = { people: [person] };
  const empty = renderToStaticMarkup(EarthFriends({ ...defaults, people }));
  assert.doesNotMatch(empty, /friend|TEST-1/);
  const html = renderToStaticMarkup(EarthFriends({ ...defaults, people, locations: [currentPoint(person.circleId, person.user)] }));
  assert.match(html, /&lt;script&gt;friend&lt;\/script&gt;/);
  assert.match(html, /aria-label="Участники на карте"/);
  assert.doesNotMatch(html, /<script>|latitude|longitude|TEST-1/);
});

test("only an authorized map participant gets an explicit meeting action without exporting coordinates", () => {
  const people = { people: [{ circleId: "friend-one", user: { publicId: "TEST-1", displayName: "Лена" } },
    { circleId: "friend-two", user: { publicId: "TEST-2", displayName: "Дима" } }] };
  const locations = [currentPoint("friend-one", people.people[0].user)], calls = [];
  const tree = EarthFriends({ ...defaults, people, locations, onMeetPerson: id => calls.push(id) });
  const html = renderToStaticMarkup(tree), buttons = collectButtons(tree);
  assert.equal(buttons.length, 1);
  assert.match(html, /Открыть встречу: Лена/);
  assert.doesNotMatch(html, /Дима|55\.751234|37\.621234|publicationEpoch|GHOST|TEST-1/);
  assert.deepEqual(calls, [], "rendering never acquires GPS or changes sharing");
  buttons[0].props.onClick(); assert.deepEqual(calls, ["friend-one"]);
});

test("empty, offline and loading map pickers never recreate a contacts list or run commands", () => {
  const calls = [], people = { people: [{ circleId: "private", user: { publicId: "PRIVATE", displayName: "Закрытый друг" } }] };
  for (const state of [{}, { online: false }, { loading: true }, { error: "network" }]) {
    const tree = EarthFriends({ ...defaults, ...state, people, onRefresh: () => calls.push("refresh"), onOpenPeople: () => calls.push("people") });
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Сейчас на карте никого нет/);
    assert.doesNotMatch(html, /Закрытый друг|PRIVATE|Обновить список|Открыть «Люди»/);
    assert.equal(collectButtons(tree).length, 0);
  }
  assert.deepEqual(calls, []);
});

test("a selected map group has one compact action per member and rejects a click after expiry", t => {
  const people = { people: [{ circleId: "shared", user: { publicId: "SHARED", displayName: "Лена" } },
    { circleId: "other", user: { publicId: "OTHER", displayName: "Дима" } }] };
  const locations = people.people.map(person => currentPoint(person.circleId, person.user)), calls = [];
  const tree = EarthFriends({ ...defaults, people, locations, selectedCircleIds: ["shared"], onMeetPerson: id => calls.push(id) });
  const html = renderToStaticMarkup(tree), buttons = collectButtons(tree);
  assert.equal(buttons.length, 1); assert.match(html, /Лена/);
  assert.doesNotMatch(html, /Дима|Игровой профиль|В гости|55\.751234|37\.621234|SHARED|OTHER/);
  buttons[0].props.onClick(); assert.deepEqual(calls, ["shared"]);
  t.mock.method(Date, "now", () => Date.parse(locations[0].expiresAt) + 1);
  buttons[0].props.onClick(); assert.deepEqual(calls, ["shared"], "a sleeping tab cannot open a stale point");
});

test("a reused relationship ID cannot attach another person's geographic point to the picker", () => {
  const people = { people: [{ circleId: "same", user: { publicId: "CURRENT", displayName: "Лена" } }] };
  const locations = [currentPoint("same", { publicId: "FORMER", displayName: "Друг" })];
  const html = renderToStaticMarkup(EarthFriends({ ...defaults, people, locations, onMeetPerson() {} }));
  assert.match(html, /Сейчас на карте никого нет/);
  assert.doesNotMatch(html, /Лена|Друг|Открыть встречу|55\.751234|37\.621234|FORMER|CURRENT/);
});
