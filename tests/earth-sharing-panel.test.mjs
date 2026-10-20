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
const settings = { ownerPublicId: "0000-0000-0001", mode: "OFF", revision: 0, precision: "APPROXIMATE",
  recipientCircleIds: [], frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: "2026-10-18T20:00:00Z" };
const friends = [{ circleId: "one", user: { publicId: "0000-0000-0002", displayName: "<script>Лена</script>" }, nickname: "Лена" },
  { circleId: "two", user: { publicId: "0000-0000-0003", displayName: "Дима" } },
  { circleId: "new", user: { publicId: "0000-0000-0004", displayName: "Новый друг" } }];
const activeSettings = { ...settings, mode: "SHARING", revision: 1, recipientCircleIds: ["one", "two"],
  frozenCircleIds: ["two"], sharingUntil: "2026-10-18T21:00:00Z" };

function view(overrides = {}, selection = {}) {
  const calls = [];
  const sharing = { settings: { ...settings, ...selection }, pendingGhost: false, pendingPrivacyMode: null,
    publishing: false, lastPublishedAt: null, saving: false, loading: false, error: null,
    refresh: () => calls.push(["refresh"]), ...overrides.sharing };
  const props = { sharing, people: { people: friends }, peopleLoading: false, online: true,
    onShare: async choices => { calls.push(["share", choices]); }, onGhost: () => calls.push(["ghost"]),
    onOff: () => calls.push(["off"]), onSetFrozen: async (id, frozen) => { calls.push(["frozen", id, frozen]); return true; },
    onRevokeRecipient: async id => { calls.push(["revoke", id]); return true; },
    draft: { revision: sharing.settings?.revision ?? null, precision: sharing.settings?.precision ?? "APPROXIMATE", durationMinutes: 60 },
    query: "", onQueryChange: value => calls.push(["query", value]),
    onPrecisionChange: value => calls.push(["precision", value]), onDurationChange: value => calls.push(["duration", value]),
    ...overrides, sharing };
  const tree = EarthSharingPanelContent(props), elements = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === EarthSharingToggle) { walk(EarthSharingToggle(node.props)); return; }
    elements.push(node); Children.forEach(node.props.children, walk);
  }
  walk(tree);
  return { calls, props, elements, markup: renderToStaticMarkup(tree),
    button: label => elements.find(node => node.type === "button" && node.props["aria-label"] === label),
    textButton: text => elements.find(node => node.type === "button" && Children.toArray(node.props.children).includes(text)) };
}
const friendSwitch = (result, name) => result.button("Обновлять геопозицию для " + name);

test("the compact panel starts private, approximate and one hour; rendering never grants recipients", () => {
  const result = view();
  assert.equal(result.elements.filter(node => node.props.role === "switch").length, 4);
  assert.ok(result.elements.filter(node => node.props.role === "switch").every(node => node.props["aria-checked"] === false));
  assert.match(result.markup, /Только я/);
  assert.match(result.markup, /<input(?=[^>]*value="APPROXIMATE")(?=[^>]*checked)[^>]*>/);
  assert.match(result.markup, /value="60" selected/);
  assert.equal(result.elements.find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.ok(result.elements.filter(node => node.type === "details").every(node => !node.props.open));
  assert.doesNotMatch(result.markup, /<script>|Найти себя|Разрешить выбранным|Подтвердить и обновлять позицию/);
  assert.deepEqual(result.calls, []);
});

test("the stateful entry point escapes names and preserves explicit precise and unlimited choices", () => {
  const result = view({ people: { people: [{ ...friends[0], nickname: null }] } }, { ...activeSettings, precision: "PRECISE", sharingUntil: null });
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, result.props));
  assert.match(html, /&lt;script&gt;Лена&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<input(?=[^>]*value="PRECISE")(?=[^>]*checked)[^>]*>/);
  assert.match(html, /value="forever" selected/);
  assert.deepEqual(result.calls, []);
});

test("a saved paused session resumes only explicitly, preserving the exact audience and frozen preferences", async () => {
  const result = view({}, activeSettings);
  assert.match(result.markup, /Обновление на паузе/);
  assert.equal(friendSwitch(result, "Лена").props["aria-checked"], true);
  assert.equal(friendSwitch(result, "Дима").props["aria-checked"], false);
  assert.equal(friendSwitch(result, "Новый друг").props["aria-checked"], false);
  assert.deepEqual(result.calls, []);
  await result.textButton("Возобновить").props.onClick();
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("global Ghost is a real switch in both directions and restores no unselected friend", async () => {
  const live = view({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  const toggle = live.button("Режим призрака");
  assert.equal(toggle.props["aria-checked"], false);
  toggle.props.onClick(); assert.deepEqual(live.calls, [["ghost"]]);
  const ghost = view({}, { ...activeSettings, mode: "GHOST" });
  assert.equal(ghost.button("Режим призрака").props["aria-checked"], true);
  assert.match(ghost.markup, /Включён для всех/);
  await ghost.button("Режим призрака").props.onClick();
  assert.deepEqual(ghost.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
  const emptyGhost = view({}, { mode: "GHOST" });
  emptyGhost.button("Режим призрака").props.onClick();
  assert.deepEqual(emptyGhost.calls, [["off"]], "a private account cannot gain recipients by leaving Ghost");
});

test("an existing friend's switch freezes and unfreezes only that recipient without sharing or GPS consent", async () => {
  const result = view({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, activeSettings);
  await friendSwitch(result, "Лена").props.onClick();
  await friendSwitch(result, "Дима").props.onClick();
  assert.deepEqual(result.calls, [["frozen", "one", true], ["frozen", "two", false]]);
  const frozen = view({}, { ...activeSettings, frozenCircleIds: ["one", "two"] });
  assert.equal(friendSwitch(frozen, "Лена").props["aria-checked"], false);
  assert.match(frozen.markup, /Место заморожено/);
  assert.equal(sharingSummary(frozen.props.sharing), "Все на паузе");
});

test("a never-authorized friend gets consent only from their own explicit switch", async () => {
  const initial = view();
  await friendSwitch(initial, "Новый друг").props.onClick();
  assert.deepEqual(initial.calls, [["share", { recipientCircleIds: ["new"], frozenCircleIds: [],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
  const existing = view({}, activeSettings);
  await friendSwitch(existing, "Новый друг").props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["one", "two", "new"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("the first consent uses chosen precision and duration without applying an unsaved draft to existing recipients", async () => {
  const draft = { revision: 0, precision: "PRECISE", durationMinutes: null };
  const first = view({ draft });
  await friendSwitch(first, "Новый друг").props.onClick();
  assert.deepEqual(first.calls, [["share", { recipientCircleIds: ["new"], frozenCircleIds: [],
    precision: "PRECISE", durationMinutes: null }]]);
  const existing = view({ draft }, activeSettings);
  await friendSwitch(existing, "Новый друг").props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["one", "two", "new"], frozenCircleIds: ["two"],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("revocation is separate from freezing and uses the narrow recipient action", async () => {
  const result = view({}, activeSettings);
  const controls = result.elements.filter(node => node.type === "button" && Children.toArray(node.props.children).includes("Убрать меня с карты друга"));
  assert.equal(controls.length, 2);
  await controls[0].props.onClick();
  assert.deepEqual(result.calls, [["revoke", "one"]]);
  result.textButton("Убрать меня с карты у всех").props.onClick();
  assert.deepEqual(result.calls, [["revoke", "one"], ["off"]]);
});

test("Ghost allows revoking a friend's access without resuming sharing or enabling their live switch", async () => {
  const result = view({}, { ...activeSettings, mode: "GHOST" });
  const revoke = result.textButton("Убрать меня с карты друга");
  assert.equal(revoke.props.disabled, false);
  await revoke.props.onClick();
  assert.equal(friendSwitch(result, "Лена").props.disabled, true);
  assert.deepEqual(result.calls, [["revoke", "one"]]);
});

test("global Ghost disables friend updates and settings while preserving choices", () => {
  const result = view({}, { ...activeSettings, mode: "GHOST" });
  assert.match(result.markup, /Выключи призрака, чтобы делиться/);
  for (const person of ["Лена", "Дима", "Новый друг"]) {
    const toggle = friendSwitch(result, person);
    assert.equal(toggle.props.disabled, true); assert.equal(toggle.props["aria-checked"], false); toggle.props.onClick();
  }
  result.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(result.elements.find(node => node.type === "button" && node.props.type === "submit").props.disabled, true);
  assert.deepEqual(result.calls, []);
});

test("offline still allows entering Ghost but cannot silently resume or change an individual friend's access", () => {
  const offline = view({ online: false }, activeSettings);
  const ghost = offline.button("Режим призрака");
  assert.equal(ghost.props.disabled, false); ghost.props.onClick();
  friendSwitch(offline, "Лена").props.onClick();
  assert.deepEqual(offline.calls, [["ghost"]]);
  const pending = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode: "GHOST" } }, { ...activeSettings, mode: "GHOST" });
  assert.equal(pending.button("Режим призрака").props["aria-checked"], true);
  assert.equal(pending.button("Режим призрака").props.disabled, true);
  pending.button("Режим призрака").props.onClick();
  assert.match(pending.markup, /остановлена на устройстве/);
  assert.match(pending.markup, /Ждём подтверждения сервера/);
  assert.doesNotMatch(pending.markup, /на сервере включён|успешно/);
  assert.deepEqual(pending.calls, []);
});

test("pending OFF does not present deletion as a confirmed server freeze or enable Ghost", () => {
  const result = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode: "OFF" } });
  assert.match(result.markup, /Удаление доступа ещё не подтверждено сервером/);
  assert.equal(result.button("Режим призрака").props["aria-checked"], false);
  assert.doesNotMatch(result.markup, /Ждём подтверждения сервера/);
});

test("secondary accuracy and duration only apply on submit and keep frozen recipients", async () => {
  const result = view({ draft: { revision: 1, precision: "PRECISE", durationMinutes: 480 } }, activeSettings);
  assert.deepEqual(result.calls, []);
  await result.elements.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: ["one", "two"], frozenCircleIds: ["two"],
    precision: "PRECISE", durationMinutes: 480 }]]);
});

test("busy and unavailable metadata keep live controls disabled, with actionable errors", () => {
  for (const overrides of [{ sharing: { saving: true } }, { working: true }, { sharing: { settings: null, loading: true } }]) {
    const result = view(overrides, activeSettings);
    const toggle = friendSwitch(result, "Новый друг");
    assert.equal(toggle.props.disabled, true); toggle.props.onClick();
    assert.deepEqual(result.calls, []);
  }
  const failed = view({ sharing: { error: "Сеть недоступна" } });
  assert.match(failed.markup, /role="alert"/);
  failed.button("Обновить настройки геопозиции").props.onClick();
  assert.deepEqual(failed.calls, [["refresh"]]);
});

test("search limits visible rows without selecting friends or losing saved choices", () => {
  const people = { people: Array.from({ length: 110 }, (_, index) => ({ circleId: "id-" + index,
    user: { publicId: "person-" + index, displayName: "Друг " + index } })) };
  const result = view({ people });
  assert.equal(result.elements.filter(node => node.type === "li").length, 100);
  assert.match(result.markup, /показаны первые 100/);
  result.elements.find(node => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "Друг 109" } });
  assert.deepEqual(result.calls, [["query", "Друг 109"]]);
  const filtered = view({ people, query: "Друг 109" });
  assert.equal(filtered.elements.filter(node => node.type === "li").length, 1);
  assert.deepEqual(filtered.calls, []);
});

test("a full audience cannot accidentally authorize a 101st recipient", () => {
  const full = view({}, { ...activeSettings, recipientCircleIds: Array.from({ length: 100 }, (_, index) => "chosen-" + index), frozenCircleIds: [] });
  const toggle = friendSwitch(full, "Новый друг");
  assert.equal(toggle.props.disabled, true); toggle.props.onClick();
  assert.deepEqual(full.calls, []);
});
