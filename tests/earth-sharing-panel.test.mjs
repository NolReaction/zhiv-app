import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthSharingPanel, EarthSharingPanelContent, EarthSharingToggle, sharingSummary } =
  await vite.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
const { EarthFriendSharingControls } = await vite.ssrLoadModule("/features/earth/earth-friend-sharing.tsx");
const settings = { ownerPublicId: "0000-0000-0001", mode: "OFF", revision: 0, precision: "APPROXIMATE",
  recipientCircleIds: [], frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: "2026-10-18T20:00:00Z" };
const friends = [{ circleId: "one", user: { publicId: "0000-0000-0002", displayName: "<script>Лена</script>" }, nickname: "Лена" },
  { circleId: "two", user: { publicId: "0000-0000-0003", displayName: "Дима" } },
  { circleId: "new", user: { publicId: "0000-0000-0004", displayName: "Новый друг" } }];
const activeSettings = { ...settings, mode: "SHARING", revision: 1, recipientCircleIds: ["one", "two"],
  frozenCircleIds: ["two"], sharingUntil: "2026-10-18T21:00:00Z" };

function view(overrides = {}, selection = {}, individual = false) {
  const calls = [];
  const sharing = { settings: { ...settings, ...selection }, pendingGhost: false, pendingPrivacyMode: null,
    publishing: false, lastPublishedAt: null, saving: false, loading: false, error: null,
    refresh: () => calls.push(["refresh"]), ...overrides.sharing };
  const props = { sharing, people: { people: friends }, peopleLoading: false, online: true,
    onShare: async choices => { calls.push(["share", choices]); }, onGhost: () => calls.push(["ghost"]),
    onOff: () => calls.push(["off"]), onOpenPeople: () => calls.push(["people"]), onSetFrozen: async (id, frozen) => { calls.push(["frozen", id, frozen]); return true; },
    onRevokeRecipient: async id => { calls.push(["revoke", id]); return true; },
    draft: { revision: sharing.settings?.revision ?? null, precision: sharing.settings?.precision ?? "APPROXIMATE", durationMinutes: 60 },
    query: "", onQueryChange: value => calls.push(["query", value]),
    onPrecisionChange: value => calls.push(["precision", value]), onDurationChange: value => calls.push(["duration", value]),
    ...overrides, sharing };
  const tree = individual ? createElement("div", null, ...friends.map(person => createElement(EarthFriendSharingControls,
    { key: person.circleId, person, sharing, online: props.online, working: props.working, firstChoices: props.draft,
      onShare: props.onShare, onSetFrozen: props.onSetFrozen, onRevokeRecipient: props.onRevokeRecipient }))) : EarthSharingPanelContent(props);
  const elements = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === EarthSharingToggle) { walk(EarthSharingToggle(node.props)); return; }
    if (node.type === EarthFriendSharingControls) { walk(EarthFriendSharingControls(node.props)); return; }
    elements.push(node); Children.forEach(node.props.children, walk);
  }
  walk(tree);
  return { calls, props, elements, markup: renderToStaticMarkup(tree),
    button: label => elements.find(node => node.type === "button" && node.props["aria-label"] === label),
    textButton: text => elements.find(node => node.type === "button" && Children.toArray(node.props.children).includes(text)) };
}
const friendView = (overrides, selection) => view(overrides, selection, true);
const friendSwitch = (result, name) => result.button("Обновлять геопозицию для " + name);

test("the global panel starts private with no recipient list and never grants access on render", () => {
  const result = view();
  assert.equal(result.elements.filter(node => node.props.role === "switch").length, 0);
  assert.equal(result.elements.filter(node => node.type === "li").length, 0);
  assert.match(result.markup, /Геопозиция закрыта/);
  assert.match(result.markup, /Обновления для друзей/);
  assert.match(result.markup, /Получатели выбираются в «Людях»/);
  assert.match(result.markup, /<input(?=[^>]*value="APPROXIMATE")(?=[^>]*checked)[^>]*>/);
  assert.match(result.markup, /value="60" selected/);
  assert.equal(result.elements.find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.ok(result.elements.filter(node => node.type === "details").every(node => !node.props.open));
  assert.doesNotMatch(result.markup, /<script>|Новый друг|Найти близкого|Обновлять геопозицию для/);
  assert.deepEqual(result.calls, []);
});

test("the stateful entry point omits private names and preserves saved precise and unlimited choices", () => {
  const result = view({ people: { people: [{ ...friends[0], nickname: null }] } }, { ...activeSettings, precision: "PRECISE", sharingUntil: null });
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, result.props));
  assert.doesNotMatch(html, /Лена|script/);
  assert.match(html, /<input(?=[^>]*value="PRECISE")(?=[^>]*checked)[^>]*>/);
  assert.match(html, /value="forever" selected/);
  assert.deepEqual(result.calls, []);
});

test("a saved paused session resumes only explicitly, preserving the exact audience and frozen preferences", async () => {
  const result = view({}, activeSettings);
  assert.match(result.markup, /Обновление на паузе/);
  assert.match(result.markup, /Доступ у 2 · обновления разрешены для 1/);
  assert.deepEqual(result.calls, []);
  const button = result.button("Включить обновления геопозиции");
  assert.equal(button.props["aria-pressed"], false);
  await button.props.onClick();
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("one named button pauses and resumes existing updates without adding an unselected friend", async () => {
  const live = view({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  const pause = live.button("Приостановить обновления геопозиции");
  assert.equal(pause.props["aria-pressed"], true);
  pause.props.onClick(); assert.deepEqual(live.calls, [["ghost"]]);
  const ghost = view({}, { ...activeSettings, mode: "GHOST" });
  assert.match(ghost.markup, /На паузе · последнее место/);
  const resume = ghost.button("Включить обновления геопозиции");
  assert.equal(resume.props["aria-pressed"], false);
  await resume.props.onClick();
  assert.deepEqual(ghost.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("empty or fully frozen audiences lead to People without inventing consent or requesting GPS", () => {
  for (const choices of [{ mode: "OFF" }, { ...activeSettings, frozenCircleIds: ["one", "two"] }]) {
    const result = view({}, choices);
    result.button("Выбрать получателей в Людях").props.onClick();
    assert.deepEqual(result.calls, [["people"]]);
  }
  const unavailable = view({ onOpenPeople: undefined });
  const action = unavailable.button("Выбрать получателей в Людях");
  assert.equal(action.props.disabled, true); action.props.onClick();
  assert.deepEqual(unavailable.calls, []);
});

test("leaving Ghost retains individual pauses and an empty Ghost account can explicitly revoke the mode", async () => {
  const result = view({}, { ...activeSettings, mode: "GHOST", frozenCircleIds: ["one", "two"] });
  await result.button("Выключить режим призрака").props.onClick();
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["one", "two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]], "a global resume cannot unfreeze an individual");
  const empty = view({}, { mode: "GHOST" });
  empty.button("Выключить режим призрака").props.onClick();
  assert.deepEqual(empty.calls, [["off"]]);
});

test("an existing friend's switch freezes and unfreezes only that recipient without sharing or GPS consent", async () => {
  const result = friendView({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  await friendSwitch(result, "Лена").props.onClick();
  await friendSwitch(result, "Дима").props.onClick();
  assert.deepEqual(result.calls, [["frozen", "one", true], ["frozen", "two", false]]);
  const frozen = friendView({}, { ...activeSettings, frozenCircleIds: ["one", "two"] });
  assert.equal(friendSwitch(frozen, "Лена").props["aria-checked"], false);
  assert.match(frozen.markup, /Последнее место/);
  assert.equal(sharingSummary(frozen.props.sharing), "Все на паузе");
});

test("friend rows distinguish live updates, a permitted last point and no access", () => {
  const status = (result, id) => result.elements.find(node => node.props.id === "earth-friend-access-" + id).props.children;
  const live = friendView({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  assert.equal(sharingSummary(live.props.sharing), "Делюсь гео · 1");
  assert.equal(status(live, "one"), "Обновляется");
  assert.equal(status(live, "two"), "Последнее место");
  assert.equal(status(live, "new"), "Нет доступа");
  const paused = friendView({}, activeSettings);
  assert.equal(status(paused, "one"), "Передача на паузе");
  const ghost = friendView({}, { ...activeSettings, mode: "GHOST" });
  assert.equal(sharingSummary(ghost.props.sharing), "Призрак включён");
  assert.equal(status(ghost, "one"), "Последнее место · призрак");
  assert.equal(status(ghost, "new"), "Нет доступа");
  assert.deepEqual([...live.calls, ...paused.calls, ...ghost.calls], []);
});

test("a never-authorized friend gets consent only from their own explicit switch", async () => {
  const initial = friendView();
  await friendSwitch(initial, "Новый друг").props.onClick();
  assert.deepEqual(initial.calls, [["share", { recipientCircleIds: ["new"], frozenCircleIds: [],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
  const existing = friendView({}, activeSettings);
  await friendSwitch(existing, "Новый друг").props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["one", "two", "new"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("the first consent uses chosen precision and duration without applying an unsaved draft to existing recipients", async () => {
  const draft = { revision: 0, precision: "PRECISE", durationMinutes: null };
  const first = friendView({ draft });
  await friendSwitch(first, "Новый друг").props.onClick();
  assert.deepEqual(first.calls, [["share", { recipientCircleIds: ["new"], frozenCircleIds: [],
    precision: "PRECISE", durationMinutes: null }]]);
  const existing = friendView({ draft }, activeSettings);
  await friendSwitch(existing, "Новый друг").props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["one", "two", "new"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("individual revocation stays in People while the map retains explicit revoke-all", async () => {
  const result = friendView({}, activeSettings);
  const controls = result.elements.filter(node => node.type === "button" && Children.toArray(node.props.children).includes("Убрать доступ"));
  assert.equal(controls.length, 2);
  await controls[0].props.onClick();
  assert.deepEqual(result.calls, [["revoke", "one"]]);
  const global = view({}, activeSettings);
  assert.equal(global.textButton("Убрать доступ"), undefined);
  global.textButton("Убрать меня с карты у всех").props.onClick();
  assert.deepEqual(global.calls, [["off"]]);
});

test("Ghost allows revoking a friend's access without resuming sharing or enabling their live switch", async () => {
  const result = friendView({}, { ...activeSettings, mode: "GHOST" });
  const revoke = result.textButton("Убрать доступ");
  assert.equal(revoke.props.disabled, false);
  await revoke.props.onClick();
  assert.equal(friendSwitch(result, "Лена").props.disabled, true);
  assert.deepEqual(result.calls, [["revoke", "one"]]);
});

test("global Ghost keeps individual choices and secondary settings inactive until explicit resume", () => {
  const result = view({}, { ...activeSettings, mode: "GHOST" });
  const individual = friendView({}, { ...activeSettings, mode: "GHOST" });
  for (const person of ["Лена", "Дима", "Новый друг"]) {
    const toggle = friendSwitch(individual, person);
    assert.equal(toggle.props.disabled, true); assert.equal(toggle.props["aria-checked"], false); toggle.props.onClick();
  }
  result.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(result.elements.find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.deepEqual([...result.calls, ...individual.calls], []);
});

test("offline still allows immediate pause but cannot resume or misreport pending confirmation", () => {
  const offline = view({ online: false, sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  const pause = offline.button("Приостановить обновления геопозиции");
  assert.equal(pause.props.disabled, false); pause.props.onClick();
  assert.deepEqual(offline.calls, [["ghost"]]);
  const paused = view({ online: false }, activeSettings);
  const resume = paused.button("Включить обновления геопозиции");
  assert.equal(resume.props.disabled, true); resume.props.onClick(); assert.deepEqual(paused.calls, []);
  const pending = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode: "GHOST" } }, { ...activeSettings, mode: "GHOST" });
  const action = pending.button("Включить обновления геопозиции");
  assert.equal(action.props["aria-pressed"], false);
  assert.equal(action.props.disabled, true); action.props.onClick();
  assert.match(pending.markup, /остановлена на устройстве/);
  assert.match(pending.markup, /Ждём подтверждения сервера/);
  assert.match(pending.markup, /Сохраняем приватность…/);
  assert.doesNotMatch(pending.markup, /На паузе · последнее место|на сервере включён|успешно/);
  assert.deepEqual(pending.calls, []);
});

test("pending OFF does not present deletion as a confirmed server freeze or enable updates", () => {
  const result = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode: "OFF" } });
  assert.match(result.markup, /Удаление доступа ещё не подтверждено сервером/);
  const button = result.button("Выбрать получателей в Людях");
  assert.equal(button.props["aria-pressed"], false); assert.equal(button.props.disabled, true); button.props.onClick();
  assert.doesNotMatch(result.markup, /Ждём подтверждения сервера/);
  assert.deepEqual(result.calls, []);
});

test("secondary accuracy and duration only apply on submit and keep frozen recipients", async () => {
  const result = view({ draft: { revision: 1, precision: "PRECISE", durationMinutes: 480 } }, activeSettings);
  assert.deepEqual(result.calls, []);
  await result.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "PRECISE", durationMinutes: 480 }]]);
});

test("busy and unavailable metadata keep enabling disabled, with actionable network and local errors", () => {
  for (const overrides of [{ sharing: { saving: true } }, { working: true }, { sharing: { settings: null, loading: true } }]) {
    const result = view(overrides, activeSettings);
    const button = result.button("Включить обновления геопозиции");
    assert.equal(button.props.disabled, true); button.props.onClick();
    assert.deepEqual(result.calls, []);
  }
  for (const overrides of [{ sharing: { error: "Сеть недоступна" } }, { localError: "Не удалось сохранить" }]) {
    const failed = view(overrides);
    assert.match(failed.markup, /role="alert"/);
    failed.button("Обновить настройки геопозиции").props.onClick();
    assert.deepEqual(failed.calls, [["refresh"]]);
  }
});

test("many friends do not turn the map settings into a second scrolling roster", () => {
  const people = { people: Array.from({ length: 110 }, (_, index) => ({ circleId: "id-" + index,
    user: { publicId: "person-" + index, displayName: "Друг " + index } })) };
  const result = view({ people });
  assert.equal(result.elements.filter(node => node.type === "li" || node.type === "ul").length, 0);
  assert.equal(result.elements.filter(node => node.type === "input" && node.props.type === "search").length, 0);
  assert.doesNotMatch(result.markup, /Друг 109|Друг 0/);
  assert.equal(result.elements.filter(node => node.type === "button").length, view().elements.filter(node => node.type === "button").length);
  result.elements.find(node => node.type === "button" && Children.toArray(node.props.children).some(child => isValidElement(child) && child.type === "span")).props.onClick();
  assert.deepEqual(result.calls, [["people"]]);
});

test("a full audience cannot accidentally authorize a 101st recipient", () => {
  const full = friendView({}, { ...activeSettings, recipientCircleIds: Array.from({ length: 100 }, (_, index) => "chosen-" + index), frozenCircleIds: [] });
  const toggle = friendSwitch(full, "Новый друг");
  assert.equal(toggle.props.disabled, true); toggle.props.onClick();
  assert.deepEqual(full.calls, []);
});
