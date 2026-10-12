import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldProfileFriendsContent, profileFriends } = await vite.ssrLoadModule("/features/world/ui/profile/world-profile-friends.tsx");

const person = (id, displayName, extra = {}) => ({
  circleId: id, user: { publicId: `PRIVATE-${id}`, displayName },
  connectedAt: "2026-10-01T10:00:00.000Z", mySharingMode: "OFF", theirSharingMode: "OFF",
  checkInState: "HIDDEN", lastCheckInAt: "2026-10-07T14:59:59.000Z",
  status: { text: "private-status" }, ...extra,
});
const people = [person("a", "Алёна Иванова", { nickname: "Мама" }), person("b", "Игорь", { isFavorite: true }), person("c", "Друг")];
const data = {
  people, incomingRequests: [{ requestId: "in-1", user: { displayName: "incoming-name" } }],
  outgoingRequests: [{ requestId: "out-1", user: { displayName: "outgoing-name" } }],
  audienceCount: 200, serverTime: "2026-10-07T15:00:00.000Z",
};

function view(overrides = {}) {
  const calls = [];
  const tree = WorldProfileFriendsContent({
    friends: { data, loading: false, error: null, updatedAt: 1791385200000, onRefresh: () => calls.push("refresh") },
    onOpenPeople: () => calls.push("people"), query: "", onQueryChange: value => calls.push(["query", value]), searchId: "friends-search",
    ...overrides,
  });
  const elements = [];
  const walk = child => {
    if (!isValidElement(child)) return;
    elements.push(child);
    Children.forEach(child.props.children, walk);
  };
  walk(tree);
  return { calls, elements, markup: renderToStaticMarkup(tree) };
}

test("friends show real connected people and personal names without exposing hidden profile metadata", () => {
  const result = view();
  assert.match(result.markup, /Алёна Иванова/);
  assert.match(result.markup, /Мама/);
  assert.match(result.markup, /В избранном/);
  assert.equal(result.elements.filter(element => element.type === "li").length, 3);
  assert.match(result.markup, />Друзья<span[^>]*>3<\/span>/);
  assert.match(result.markup, /Входящих заявок: 1/);
  assert.match(result.markup, /Отправлено заявок: 1/);
  assert.doesNotMatch(result.markup, /PRIVATE-|private-status|14:59:59|incoming-name|outgoing-name|В сети|Был в сети|Уровень/);
  const rows = result.elements.filter(element => element.type === "li");
  assert.ok(rows.every(element => !element.props.onClick && !element.props.tabIndex && element.props.role !== "button"));
  assert.equal(result.elements.filter(element => element.type === "a" || element.type === "img").length, 0);
});

test("friend search matches a public name or nickname with ё and preserves data while putting favorites first", () => {
  const saved = JSON.stringify(people);
  assert.deepEqual(profileFriends(people, ""), [people[1], people[0], people[2]]);
  for (const query of ["алена", "МАМА", "мама иванова"]) assert.deepEqual(profileFriends(people, query), [people[0]]);
  assert.equal(JSON.stringify(people), saved);
  const found = view({ query: "мама" });
  assert.equal(found.elements.filter(element => element.type === "li").length, 1);
  assert.match(found.markup, />Друзья<span[^>]*>3<\/span>/);
  const missing = view({ query: "нет такого человека" });
  assert.match(missing.markup, /Никого не нашли/);
  assert.doesNotMatch(missing.markup, /Друзей пока нет/);
  missing.elements.find(element => element.props["aria-label"] === "Сбросить поиск друзей").props.onClick();
  assert.deepEqual(missing.calls, [["query", ""]]);
  found.elements.find(element => element.type === "input").props.onChange({ target: { value: "Игорь" } });
  assert.deepEqual(found.calls, [["query", "Игорь"]]);
});

test("refresh and People navigation require an explicit press; rendering never fetches or sends a request", () => {
  const result = view();
  assert.deepEqual(result.calls, []);
  const buttons = result.elements.filter(element => element.type === "button");
  assert.equal(buttons.length, 2);
  buttons.find(element => element.props["aria-label"] === "Обновить список друзей").props.onClick();
  buttons.find(element => !element.props["aria-label"]).props.onClick();
  assert.deepEqual(result.calls, ["refresh", "people"]);
});

test("loading, failed and offline snapshots retain cached names and explain whether refreshing is possible", () => {
  const base = { data, loading: false, error: null, onRefresh() {} };
  const offline = view({ friends: { ...base, isOnline: false } });
  assert.match(offline.markup, /Нет сети/);
  assert.match(offline.markup, /последний загруженный список/);
  assert.match(offline.markup, /Алёна Иванова/);
  assert.equal(offline.elements.find(element => element.props["aria-label"] === "Обновить список друзей").props.disabled, true);
  const loading = view({ friends: { ...base, loading: true } });
  assert.match(loading.markup, /Обновляем список/);
  assert.match(loading.markup, /Алёна Иванова/);
  assert.equal(loading.elements.find(element => element.props["aria-label"] === "Обновить список друзей").props.disabled, true);
  const failed = view({ friends: { ...base, error: "Internal private request diagnostic" } });
  assert.match(failed.markup, /Не удалось обновить/);
  assert.match(failed.markup, /Алёна Иванова/);
  assert.doesNotMatch(failed.markup, /Internal private request diagnostic/);
  assert.equal(failed.elements.find(element => element.props["aria-label"] === "Обновить список друзей").props.disabled, false);
});

test("missing snapshots are not shown as an empty friend list and pending requests are not counted as friends", () => {
  const base = { data: null, loading: true, error: null, onRefresh() {} };
  const loading = view({ friends: base });
  assert.match(loading.markup, /Загружаем друзей/);
  assert.doesNotMatch(loading.markup, /Друзей пока нет/);
  const failed = view({ friends: { ...base, loading: false, error: "unavailable" } });
  assert.match(failed.markup, /Не удалось загрузить друзей/);
  assert.doesNotMatch(failed.markup, /Друзей пока нет/);
  const offline = view({ friends: { ...base, loading: false, isOnline: false } });
  assert.match(offline.markup, /Подключитесь, чтобы загрузить друзей/);
  const empty = view({ friends: { ...base, data: { ...data, people: [] }, loading: false } });
  assert.match(empty.markup, /Друзей пока нет/);
  assert.match(empty.markup, />Друзья<span[^>]*>0<\/span>/);
  assert.match(empty.markup, /Входящих заявок: 1/);
  const unavailable = view({ friends: undefined, onOpenPeople: undefined });
  assert.match(unavailable.markup, /Список друзей пока недоступен/);
  assert.equal(unavailable.elements.filter(element => element.type === "button").length, 0);
});
