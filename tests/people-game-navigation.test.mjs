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
const { PersonProfileTabs } = await vite.ssrLoadModule("/features/people/person-profile-tabs.tsx");
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

test("People cards open the profile from the person and keep secondary actions inside it", () => {
  const html = renderToStaticMarkup(createElement(PeopleView, { ownerPublicId: "OWNER", data, groups: null,
    error: null, groupsError: null, loading: false, groupsLoading: false, nowMs: Date.now(),
    onRefresh: async () => {}, onGroupsRefresh: async () => {}, onSessionLost() {}, onVisitFriend() {} }));
  assert.doesNotMatch(html, /aria-label="Игровой профиль: Мама"|aria-label="В гости к Мама"|Скопировать ID|Удалить связь/);
  assert.match(html, /aria-label="Открыть профиль Мама"/);
});

test("the People status button describes only my outgoing check-ins and message independently of profile and GPS", () => {
  for (const enabled of [false, true]) {
    const person = { ...friend, mySharingMode: enabled ? "LATEST_ONLY" : "OFF", theirSharingMode: enabled ? "OFF" : "LATEST_ONLY" };
    const html = renderToStaticMarkup(createElement(PeopleView, { ownerPublicId: "OWNER", data: { ...data, people: [person] }, groups: null,
      error: null, groupsError: null, loading: false, groupsLoading: false, nowMs: Date.now(),
      onRefresh: async () => {}, onGroupsRefresh: async () => {}, onSessionLost() {}, onVisitFriend() {} }));
    const toggle = html.match(/<button(?=[^>]*aria-pressed=)(?=[^>]*aria-label="Делиться моими отметками и статусом с Мама")[^>]*>/)?.[0];
    assert.ok(toggle);
    assert.ok(toggle.includes('aria-pressed="' + enabled + '"'));
    assert.match(toggle, /aria-describedby="sharing-state-connected"/);
    assert.match(html, /<strong>Статус<\/strong>/);
    assert.ok(html.includes('>' + (enabled ? "Делюсь" : "Не делюсь") + '</span>'));
    assert.match(html, /Статус и геопозиция настраиваются отдельно/);
    assert.match(html, /Мои отметки «Я живой» и сообщение статуса/);
    assert.match(html, /Обновлять геопозицию для Мама/);
    assert.match(html, /Открыть профиль Мама/);
    assert.doesNotMatch(html, /Отметки и профиль|Делиться моими отметками, статусом и игровым профилем/);
    assert.doesNotMatch(html, />Видны<|>Скрыты</);
  }
});

test("People and map rows project one confirmed geolocation handle independently of status sharing", async () => {
  const { EarthSharingPanel } = await vite.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
  const calls = [], sharing = { settings: { mode: "SHARING", revision: 1, precision: "PRECISE", recipientCircleIds: [friend.circleId],
    frozenCircleIds: [], sharingUntil: null, serverTime: data.serverTime }, pendingGhost: false, pendingPrivacyMode: null,
    publishing: false, lastPublishedAt: null, saving: false, loading: false, error: null,
    refresh() { calls.push("refresh"); }, setFrozen() { calls.push("frozen"); }, revokeRecipient() { calls.push("revoke"); } };
  const peopleProps = { ownerPublicId: "OWNER", data, groups: null, error: null, groupsError: null, loading: false, groupsLoading: false,
    nowMs: Date.now(), onRefresh: async () => {}, onGroupsRefresh: async () => {}, onSessionLost() {}, earthSharing: sharing,
    onShareEarth: async () => { calls.push("share"); }, onOpenEarthPrivacy: () => calls.push("map") };
  const mapProps = { sharing, people: data, peopleLoading: false, online: true, onShare: peopleProps.onShareEarth,
    onGhost() {}, onOff() {}, onSetFrozen: sharing.setFrozen, onRevokeRecipient: sharing.revokeRecipient };
  for (const [mode, frozen, status, checked] of [["SHARING", [], "Передача на паузе", true],
    ["SHARING", [friend.circleId], "Последнее место", false], ["GHOST", [], "Последнее место · призрак", false]]) {
    sharing.settings = { ...sharing.settings, mode, frozenCircleIds: frozen };
    const people = renderToStaticMarkup(createElement(PeopleView, peopleProps));
    const map = renderToStaticMarkup(createElement(EarthSharingPanel, mapProps));
    const peopleButton = people.match(/<button(?=[^>]*aria-pressed=)(?=[^>]*aria-label="Обновлять геопозицию для Мама")[^>]*>/)?.[0];
    const mapToggle = map.match(/<button(?=[^>]*role="switch")(?=[^>]*aria-label="Обновлять геопозицию для Мама")[^>]*>/)?.[0];
    assert.ok(peopleButton.includes('aria-pressed="' + checked + '"'));
    assert.ok(mapToggle.includes('aria-checked="' + checked + '"'));
    for (const html of [people, map]) assert.ok(html.includes(status));
    assert.doesNotMatch(people, /role="switch"/, "the People card has two named buttons and no slider toggles");
    assert.match(people, /people-geo-access-connected/);
    assert.match(map, /earth-friend-access-connected/);
    if (mode === "GHOST") assert.match(people, /Призрак включён для всех\. Обновления геопозиции выключены/);
  }
  assert.deepEqual(calls, [], "reading either screen never changes consent or starts publication");
});

test("Earth keeps a compact roster without profile or visit actions", () => {
  const props = { people: data, loading: false, error: null, online: true, onRefresh() {}, onOpenPeople() {} };
  const tree = EarthFriends(props);
  assert.equal(elements(tree).filter(element => element.type === PersonGameActions).length, 0);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Мама/);
  assert.doesNotMatch(html, /Игровой профиль|В гости|Подойти к другу/);
});

test("profile tabs support one keyboard stop, arrow wrapping and Home/End without leaving the dialog", () => {
  const selected = [], focus = [], tree = PersonProfileTabs({ active: "overview", onChange: value => selected.push(value) });
  const tabs = elements(tree).filter(element => element.props.role === "tab");
  assert.equal(tabs.length, 3);
  assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1]);
  assert.ok(tabs.every(tab => tab.props["aria-controls"] === "person-profile-panel"));
  const currentTarget = { parentElement: { querySelector(selector) { return { focus() { focus.push(selector); } }; } } };
  for (const key of ["ArrowLeft", "ArrowRight", "End", "Home"]) {
    let prevented = false;
    tabs[0].props.onKeyDown({ key, currentTarget, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(selected, ["settings", "collections", "settings", "overview"]);
  assert.deepEqual(focus, selected.map(id => "#person-profile-tab-" + id));
  tabs[1].props.onClick();
  assert.equal(selected.at(-1), "collections");
});
