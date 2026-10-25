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
const { profileFriendVisit, currentProfileFriendVisit } = await vite.ssrLoadModule("/features/world/ui/profile/world-friend-visit.ts");

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

test("a shared friend card opens that friend only on an explicit press and keeps friend management", () => {
  const visited = [];
  const visible = { ...people[0], theirSharingMode: "LATEST_ONLY" };
  const result = view({ friends: { data: { ...data, people: [visible] }, loading: false, error: null, isOnline: true, onRefresh() {} },
    onVisitFriend: person => visited.push(person) });
  assert.deepEqual(visited, []);
  const card = result.elements.find(element => element.props["aria-label"] === "В гости к Мама");
  assert.equal(card.type, "button");
  assert.equal(card.props.disabled, false);
  card.props.onClick();
  assert.deepEqual(visited, [visible]);
  assert.match(result.markup, /Друзья и заявки/);
  assert.doesNotMatch(result.markup, /PRIVATE-|private-status|14:59:59/);
});

test("private and offline friend cards explain the disabled visit and never navigate", () => {
  const visited = [];
  const hidden = view({ onVisitFriend: person => visited.push(person) });
  const cards = hidden.elements.filter(element => element.props["aria-label"]?.endsWith(": мир скрыт"));
  assert.equal(cards.length, 3);
  for (const card of cards) { assert.equal(card.props.disabled, true); card.props.onClick(); }
  const offline = view({ friends: { data: { ...data, people: people.map(person => ({ ...person, theirSharingMode: "LATEST_ONLY" })) },
    loading: false, error: null, isOnline: false, onRefresh() {} }, onVisitFriend: person => visited.push(person) });
  const offlineCards = offline.elements.filter(element => element.props["aria-label"]?.endsWith(": нужен интернет"));
  assert.equal(offlineCards.length, 3);
  for (const card of offlineCards) { assert.equal(card.props.disabled, true); card.props.onClick(); }
  assert.deepEqual(visited, []);
});

test("visit navigation resolves owner, relationship, target and live visibility without mutating the people snapshot", () => {
  const shared = { ...people[0], theirSharingMode: "LATEST_ONLY" };
  const saved = JSON.stringify(shared);
  const selection = profileFriendVisit("VIEWER", [shared], shared, true);
  assert.deepEqual(selection, { ownerPublicId: "VIEWER", target: { circleId: "a", targetPublicId: "PRIVATE-a", displayName: "Мама" } });
  assert.deepEqual(currentProfileFriendVisit("VIEWER", selection, [shared], true, true), selection.target);
  assert.equal(profileFriendVisit("VIEWER", [shared], { ...shared, circleId: "other" }, true), null);
  assert.equal(profileFriendVisit("VIEWER", [shared], { ...shared, user: { ...shared.user, publicId: "other" } }, true), null);
  assert.equal(profileFriendVisit(shared.user.publicId, [shared], shared, true), null);
  assert.equal(profileFriendVisit("VIEWER", [shared], shared, false), null);
  assert.equal(profileFriendVisit(null, [shared], shared, true), null);
  for (const [owner, connected, online, open] of [
    ["NEW-OWNER", [shared], true, true], ["VIEWER", [], true, true], ["VIEWER", [{ ...shared, theirSharingMode: "OFF" }], true, true],
    ["VIEWER", [shared], false, true], ["VIEWER", [shared], true, false],
  ]) assert.equal(currentProfileFriendVisit(owner, selection, connected, online, open), undefined);
  assert.equal(JSON.stringify(shared), saved);
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

test("the world neighbor is permanently present for a player with no human friends, before or after People loads", () => {
  for (const friends of [undefined, { data: { ...data, people: [] }, loading: false, error: null, onRefresh() {} },
    { data: null, loading: false, error: "offline", isOnline: false, onRefresh() {} }]) {
    const visited = [], result = view({ friends, onVisitNeighbor: () => visited.push("berest") });
    assert.match(result.markup, /data-world-neighbor-friend="berest"/);
    assert.match(result.markup, /Персонаж мира/);
    assert.match(result.markup, />Друзья<span[^>]*>1<\/span>/);
    assert.doesNotMatch(result.markup, /Друзей пока нет|В сети|Был в сети/);
    assert.deepEqual(visited, []);
    const card = result.elements.find(element => element.props["aria-label"] === "В гости к Берест");
    assert.ok(card);
    assert.equal(card.props.disabled, friends?.isOnline === false);
    if (!card.props.disabled) { card.props.onClick(); assert.deepEqual(visited, ["berest"]); }
  }
});

test("the neighbor participates in game-only counts and name search without becoming a Person", () => {
  const before = JSON.stringify(data), onVisitNeighbor = () => {};
  const all = view({ onVisitNeighbor });
  assert.match(all.markup, />Друзья<span[^>]*>4<\/span>/);
  assert.equal(all.elements.filter(element => element.type === "li").length, 4);
  const onlyNeighbor = view({ onVisitNeighbor, query: "бЕРест" });
  assert.equal(onlyNeighbor.elements.filter(element => element.type === "li").length, 1);
  assert.match(onlyNeighbor.markup, /data-world-neighbor-friend/);
  assert.doesNotMatch(view({ onVisitNeighbor, query: "мама" }).markup, /data-world-neighbor-friend/);
  assert.match(view({ onVisitNeighbor, query: "неизвестный" }).markup, /Никого не нашли/);
  assert.equal(JSON.stringify(data), before, "the main People data is never supplemented with a pretend account");
});

test("the friend card follows the server's character name and exclusive appearance", () => {
  const result = view({ onVisitNeighbor() {}, neighbor: { name: "Дубок", equipment: { palette: "berest_birch_moss", head: "berest_trail_hat", neck: "berest_lantern_scarf", rod: null } } });
  assert.match(result.markup, /Дубок/);
  assert.doesNotMatch(result.markup, /Берест/);
  assert.ok(result.elements.some(element => element.props.appearance?.head === "berest_trail_hat"));
});
