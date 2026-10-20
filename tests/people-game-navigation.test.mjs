import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { PersonGameActions } = await vite.ssrLoadModule("/features/people/person-game-actions.tsx");
const { personProfileTarget, currentPersonProfile } = await vite.ssrLoadModule("/features/people/people-profile-navigation.ts");
const { PeopleView } = await vite.ssrLoadModule("/features/people/people-view.tsx");
const { EarthFriends } = await vite.ssrLoadModule("/features/earth/earth-view.tsx");
const friend = { circleId: "connected", user: { publicId: "FRIEND", displayName: "Алёна" }, nickname: "Мама",
  connectedAt: "2026-10-01T00:00:00.000Z", theirSharingMode: "LATEST_ONLY", mySharingMode: "OFF",
  checkInState: "NEVER", lastCheckInAt: null, status: null };
const data = { people: [friend], incomingRequests: [], outgoingRequests: [], audienceCount: 1,
  serverTime: "2026-10-20T12:00:00.000Z" };

function elements(tree) {
  const result = [];
  function visit(node) {
    if (!isValidElement(node)) return;
    result.push(node);
    Children.forEach(node.props.children, visit);
  }
  visit(tree);
  return result;
}

test("game actions open the exact profile or world only on a press and preserve the world return trigger", () => {
  const calls = [];
  const tree = PersonGameActions({ person: friend, online: true,
    onOpenProfile: person => calls.push(["profile", person]), onVisitFriend: (person, trigger) => calls.push(["visit", person, trigger]) });
  assert.deepEqual(calls, []);
  const buttons = elements(tree).filter(element => element.type === "button");
  const profile = buttons.find(button => button.props["aria-label"] === "Игровой профиль: Мама");
  const visit = buttons.find(button => button.props["aria-label"] === "В гости к Мама");
  profile.props.onClick();
  const trigger = { id: "return-to-this-button" };
  visit.props.onClick({ currentTarget: trigger });
  assert.deepEqual(calls, [["profile", friend], ["visit", friend, trigger]]);
  assert.equal(profile.props["aria-haspopup"], "dialog");
  assert.doesNotMatch(renderToStaticMarkup(tree), /FRIEND|connected|LATEST_ONLY/);
});

test("offline and hidden worlds cannot be opened even if the disabled handler is invoked", () => {
  const calls = [];
  for (const [online, person, reason] of [[false, friend, "нужен интернет"], [true, { ...friend, theirSharingMode: "OFF" }, "мир скрыт"]]) {
    const tree = PersonGameActions({ person, online, onVisitFriend: () => calls.push("visit") });
    const button = elements(tree).find(element => element.type === "button");
    assert.equal(button.props.disabled, true);
    assert.equal(button.props["aria-label"], `Мама: ${reason}`);
    button.props.onClick({ currentTarget: {} });
  }
  assert.deepEqual(calls, []);
});

test("profile navigation revalidates both account and exact current relationship without bypassing visibility", () => {
  const target = personProfileTarget("OWNER", data.people, friend);
  assert.deepEqual(target, { ownerPublicId: "OWNER", circleId: "connected", targetPublicId: "FRIEND" });
  assert.equal(currentPersonProfile("OWNER", target, data.people), friend);
  assert.equal(currentPersonProfile("OTHER", target, data.people), null);
  assert.equal(currentPersonProfile("OWNER", target, []), null);
  assert.equal(currentPersonProfile("OWNER", target, [{ ...friend, user: { ...friend.user, publicId: "REPLACED" } }]), null);
  assert.equal(personProfileTarget(null, data.people, friend), null);
  assert.equal(personProfileTarget("FRIEND", data.people, friend), null);
  assert.equal(personProfileTarget("OWNER", [], friend), null);
  assert.equal(personProfileTarget("OWNER", data.people, { ...friend, circleId: "OLD" }), null);
  // The existing dialog may still show its visibility explanation and private nickname field.
  const hidden = { ...friend, theirSharingMode: "OFF" };
  assert.equal(currentPersonProfile("OWNER", target, [hidden]), hidden);
});

test("People cards expose separate explicit game-profile and guest-world buttons", () => {
  const html = renderToStaticMarkup(createElement(PeopleView, { ownerPublicId: "OWNER", data, groups: null,
    error: null, groupsError: null, loading: false, groupsLoading: false, nowMs: Date.now(),
    onRefresh: async () => {}, onGroupsRefresh: async () => {}, onSessionLost() {}, onVisitFriend() {} }));
  assert.match(html, /aria-label="Игровой профиль: Мама"/);
  assert.match(html, /aria-label="В гости к Мама"/);
  assert.match(html, /aria-label="Открыть профиль Мама"/);
});

test("the People switch describes my outgoing check-ins and profile independently of the friend's visibility", () => {
  for (const enabled of [false, true]) {
    const person = { ...friend, mySharingMode: enabled ? "LATEST_ONLY" : "OFF", theirSharingMode: enabled ? "OFF" : "LATEST_ONLY" };
    const html = renderToStaticMarkup(createElement(PeopleView, { ownerPublicId: "OWNER", data: { ...data, people: [person] }, groups: null,
      error: null, groupsError: null, loading: false, groupsLoading: false, nowMs: Date.now(),
      onRefresh: async () => {}, onGroupsRefresh: async () => {}, onSessionLost() {}, onVisitFriend() {} }));
    const toggle = html.match(/<button(?=[^>]*role="switch")(?=[^>]*aria-label="Делиться моими отметками, статусом и игровым профилем с Мама")[^>]*>/)?.[0];
    assert.ok(toggle);
    assert.ok(toggle.includes('aria-checked="' + enabled + '"'));
    assert.match(toggle, /aria-describedby="sharing-state-connected"/);
    assert.match(html, /<strong>Отметки и профиль<\/strong>/);
    assert.ok(html.includes('<small>' + (enabled ? "Делюсь" : "Не делюсь") + '</small>'));
    assert.match(html, /Геопозиция настраивается на карте/);
    assert.match(html, /Отметки, статус и игровой профиль/);
    assert.doesNotMatch(html, />Видны<|>Скрыты</);
  }
});

test("Earth reuses game actions only for current contacts, independently of their GPS availability", () => {
  const calls = [];
  const props = { people: data, loading: false, error: null, online: true, onRefresh() {}, onOpenPeople() {},
    onOpenProfile: person => calls.push(["profile", person]), onVisitFriend: (person, trigger) => calls.push(["visit", person, trigger]) };
  const tree = EarthFriends(props);
  const actions = elements(tree).find(element => element.type === PersonGameActions);
  assert.ok(actions);
  assert.equal(actions.props.person, friend);
  const profile = elements(PersonGameActions(actions.props)).find(element => element.props["aria-label"] === "Игровой профиль: Мама");
  profile.props.onClick();
  assert.deepEqual(calls, [["profile", friend]]);
  const locationOnly = EarthFriends({ ...props, people: null, locations: [{ ...friend, latitude: 55, longitude: 37,
    precision: "PRECISE", accuracyMeters: 20, updatedAt: "2026-10-20T12:00:00.000Z" }] });
  assert.equal(elements(locationOnly).filter(element => element.type === PersonGameActions).length, 0);
});
