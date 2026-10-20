import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-people-earth-sharing-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { EarthFriendSharingControls, EarthSharingToggle, FriendSharingButton, confirmedEarthChoices } =
  await vite.ssrLoadModule("/features/earth/earth-friend-sharing.tsx");

const person = { circleId: "friend-one", user: { publicId: "AAAA-0000-0002", displayName: "<script>Лена</script>" }, nickname: "Лена" };
const settings = { ownerPublicId: "AAAA-0000-0001", mode: "OFF", revision: 0, precision: "APPROXIMATE",
  recipientCircleIds: [], frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: "2026-10-20T12:00:00Z" };
const active = { ...settings, mode: "SHARING", revision: 1, recipientCircleIds: [person.circleId, "friend-two"],
  frozenCircleIds: ["friend-two"], sharingUntil: "2026-10-20T13:00:00Z" };
const text = node => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";

function view(overrides = {}, choices = {}) {
  const calls = [];
  const sharing = { settings: { ...settings, ...choices }, publishing: false, lastPublishedAt: null,
    pendingGhost: false, pendingPrivacyMode: null, saving: false, loading: false, error: null, ...overrides.sharing };
  const props = { person, sharing, online: true,
    onShare: async value => { calls.push(["share", value]); },
    onSetFrozen: async (circleId, frozen) => { calls.push(["frozen", circleId, frozen]); return true; },
    onRevokeRecipient: async circleId => { calls.push(["revoke", circleId]); return true; },
    onOpenMap: () => calls.push(["map"]), ...overrides, sharing };
  const tree = EarthFriendSharingControls(props), elements = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === EarthSharingToggle) { walk(EarthSharingToggle(node.props)); return; }
    if (node.type === FriendSharingButton) { walk(FriendSharingButton(node.props)); return; }
    elements.push(node); Children.forEach(node.props.children, walk);
  }
  walk(tree);
  return { props, calls, tree, elements, markup: renderToStaticMarkup(tree),
    toggle: elements.find(node => node.props.role === "switch" || node.type === "button" && node.props["aria-label"] === "Обновлять геопозицию для " + (props.person.nickname ?? props.person.user.displayName)),
    button: label => elements.find(node => node.type === "button" && text(node) === label),
    status: elements.find(node => node.props.id === `${props.idPrefix ?? "earth-friend-access"}-${props.person.circleId}`) };
}

test("a People/map friend starts without location access and first consent is approximate for one hour", async () => {
  const result = view();
  assert.equal(result.toggle.props.type, "button");
  assert.equal(result.toggle.props["aria-label"], "Обновлять геопозицию для Лена");
  assert.equal(result.toggle.props["aria-checked"], false);
  assert.equal(result.toggle.props.disabled, false);
  assert.equal(text(result.status), "Нет доступа");
  assert.equal(result.elements.filter(node => node.type === "details").length, 0);
  assert.equal(result.button("Возобновить на карте"), undefined);
  assert.deepEqual(result.calls, [], "rendering a People card neither grants access nor starts GPS");
  await result.toggle.props.onClick();
  assert.deepEqual(result.calls, [["share", { recipientCircleIds: [person.circleId], frozenCircleIds: [],
    precision: "APPROXIMATE", durationMinutes: 60 }]]);
});

test("existing live and frozen permissions use only the narrow recipient action", async () => {
  const live = view({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, active);
  assert.equal(live.toggle.props["aria-checked"], true);
  assert.equal(text(live.status), "Обновляется");
  await live.toggle.props.onClick();
  assert.deepEqual(live.calls, [["frozen", person.circleId, true]]);
  const frozen = view({}, { ...active, frozenCircleIds: [person.circleId, "friend-two"] });
  assert.equal(frozen.toggle.props["aria-checked"], false);
  assert.equal(frozen.status.props["data-frozen"], true);
  assert.equal(text(frozen.status), "Последнее место");
  assert.equal(frozen.button("Возобновить на карте"), undefined);
  await frozen.toggle.props.onClick();
  assert.deepEqual(frozen.calls, [["frozen", person.circleId, false]], "unfreezing cannot issue broad sharing consent or GPS commands");
});

test("revocation is explicit, separate from freezing, and remains available in global Ghost", async () => {
  for (const mode of ["SHARING", "GHOST"]) {
    const result = view({}, { ...active, mode });
    const disclosure = result.elements.find(node => node.type === "details");
    assert.ok(disclosure);
    assert.equal(disclosure.props.open, undefined, "secondary access actions start collapsed");
    assert.equal(result.button("Убрать доступ").props.disabled, false);
    await result.button("Убрать доступ").props.onClick();
    assert.deepEqual(result.calls, [["revoke", person.circleId]]);
    if (mode === "GHOST") {
      assert.equal(result.toggle.props.disabled, true);
      assert.equal(result.toggle.props["aria-checked"], false);
      assert.equal(text(result.status), "Последнее место · призрак");
      await result.toggle.props.onClick();
      assert.deepEqual(result.calls, [["revoke", person.circleId]], "Ghost cannot resume sharing via a disabled friend switch");
    }
  }
  const newcomer = view({}, { ...active, mode: "GHOST", recipientCircleIds: ["friend-two"] });
  assert.equal(text(newcomer.status), "Нет доступа");
  assert.equal(newcomer.toggle.props.disabled, true);
  await newcomer.toggle.props.onClick();
  assert.deepEqual(newcomer.calls, []);
});

test("paused GPS, finding a fix and publishing are distinct from a permitted frozen point", () => {
  const paused = view({ sharing: { lastPublishedAt: settings.serverTime } }, active);
  assert.equal(text(paused.status), "Передача на паузе");
  assert.equal(paused.status.props["data-frozen"], undefined);
  const finding = view({ sharing: { publishing: true } }, active);
  assert.equal(text(finding.status), "Ищем местоположение…");
  const publishing = view({ sharing: { publishing: true, lastPublishedAt: settings.serverTime } }, active);
  assert.equal(text(publishing.status), "Обновляется");
  const frozen = view({}, { ...active, frozenCircleIds: [person.circleId] });
  assert.equal(text(frozen.status), "Последнее место");
  assert.deepEqual([...paused.calls, ...finding.calls, ...publishing.calls, ...frozen.calls], []);
});

test("opening the map from a paused permission only navigates and never consents or resumes GPS", async () => {
  const paused = view({}, active);
  assert.ok(paused.button("Возобновить на карте"));
  await paused.button("Возобновить на карте").props.onClick();
  assert.deepEqual(paused.calls, [["map"]]);
  for (const [overrides, choices] of [
    [{}, settings], [{}, { ...active, mode: "GHOST" }], [{}, { ...active, frozenCircleIds: [person.circleId] }],
    [{ sharing: { publishing: true } }, active], [{ onOpenMap: undefined }, active],
  ]) assert.equal(view(overrides, choices).button("Возобновить на карте"), undefined);
});

test("only a first consent can apply draft precision and duration; adding friends preserves confirmed choices", async () => {
  const firstChoices = { revision: 123, precision: "PRECISE", durationMinutes: null };
  const first = view({ firstChoices });
  await first.toggle.props.onClick();
  assert.deepEqual(first.calls, [["share", { recipientCircleIds: [person.circleId], frozenCircleIds: [],
    precision: "PRECISE", durationMinutes: null }]], "panel-only draft fields cannot enter the strict consent command");
  const existing = view({ firstChoices }, { ...active, recipientCircleIds: ["friend-two"],
    frozenCircleIds: ["friend-two"], sharingUntil: "2026-10-20T20:00:00Z" });
  await existing.toggle.props.onClick();
  assert.deepEqual(existing.calls, [["share", { recipientCircleIds: ["friend-two", person.circleId], frozenCircleIds: ["friend-two"],
    precision: "APPROXIMATE", durationMinutes: 480 }]]);
  const narrow = view({ firstChoices }, active);
  await narrow.toggle.props.onClick();
  assert.deepEqual(narrow.calls, [["frozen", person.circleId, true]], "existing consent never applies another friend's hidden draft");
});

test("offline, saving, pending privacy and local work block mutations in both native and handler contracts", async () => {
  for (const overrides of [
    { online: false }, { sharing: { saving: true } }, { working: true },
    { sharing: { pendingGhost: true, pendingPrivacyMode: "GHOST" } },
    { sharing: { pendingGhost: true, pendingPrivacyMode: "OFF" } },
  ]) {
    const existing = view(overrides, active);
    assert.equal(existing.toggle.props.disabled, true);
    assert.equal(existing.button("Убрать доступ").props.disabled, true);
    await existing.toggle.props.onClick();
    await existing.button("Убрать доступ").props.onClick();
    const newcomer = view(overrides);
    assert.equal(newcomer.toggle.props.disabled, true);
    await newcomer.toggle.props.onClick();
    assert.deepEqual([...existing.calls, ...newcomer.calls], []);
  }
});

test("pending Ghost and revocation report unconfirmed changes without claiming a server-side freeze or removal", () => {
  for (const pendingPrivacyMode of ["GHOST", "OFF"]) {
    const result = view({ online: false, sharing: { pendingGhost: true, pendingPrivacyMode } }, active);
    assert.equal(text(result.status), "Ждём подтверждения…");
    assert.match(result.markup, /Изменение доступа ещё не подтверждено\./);
    assert.doesNotMatch(result.markup, /Призрак включён для всех|Последнее место · призрак|Обновления выключены|Нет доступа/);
    assert.equal(result.toggle.props.disabled, true);
    assert.equal(result.button("Убрать доступ").props.disabled, true);
    assert.deepEqual(result.calls, []);
  }
});

test("missing metadata or callbacks and a full audience cannot implicitly grant or alter access", async () => {
  const loading = view({ sharing: { settings: null, loading: true } });
  assert.equal(text(loading.status), "Загружаем…");
  assert.equal(loading.toggle.props.disabled, true);
  await loading.toggle.props.onClick();
  assert.deepEqual(loading.calls, []);
  for (const [overrides, choices] of [
    [{ onShare: undefined }, settings], [{ onSetFrozen: undefined }, active],
    [{}, { ...active, recipientCircleIds: Array.from({ length: 100 }, (_, index) => `selected-${index}`), frozenCircleIds: [] }],
  ]) {
    const result = view(overrides, choices);
    assert.equal(result.toggle.props.disabled, true);
    await result.toggle.props.onClick();
    assert.deepEqual(result.calls, []);
  }
  const noRevoke = view({ onRevokeRecipient: undefined }, active);
  assert.equal(noRevoke.button("Убрать доступ").props.disabled, true);
  await noRevoke.button("Убрать доступ").props.onClick();
  assert.deepEqual(noRevoke.calls, []);
});

test("confirmed choices clone recipient arrays and preserve privacy, frozen preferences and consent duration", () => {
  const original = { ...active, recipientCircleIds: Object.freeze([person.circleId, "friend-two"]), frozenCircleIds: Object.freeze(["friend-two"]),
    precision: "PRECISE", sharingUntil: null };
  const result = confirmedEarthChoices(original);
  assert.deepEqual(result, { recipientCircleIds: [person.circleId, "friend-two"], frozenCircleIds: ["friend-two"], precision: "PRECISE", durationMinutes: null });
  assert.notEqual(result.recipientCircleIds, original.recipientCircleIds);
  assert.notEqual(result.frozenCircleIds, original.frozenCircleIds);
  result.recipientCircleIds.push("new"); result.frozenCircleIds.length = 0;
  assert.deepEqual(original.recipientCircleIds, [person.circleId, "friend-two"]);
  assert.deepEqual(original.frozenCircleIds, ["friend-two"]);
  assert.equal(confirmedEarthChoices({ ...active, mode: "GHOST", sharingUntil: null }).durationMinutes, null);
  assert.equal(confirmedEarthChoices(active).durationMinutes, 60);
  assert.equal(confirmedEarthChoices({ ...active, sharingUntil: "2026-10-20T20:00:00Z" }).durationMinutes, 480);
  assert.equal(confirmedEarthChoices(settings).durationMinutes, 60, "an OFF account defaults to a bounded first consent");
  assert.deepEqual(confirmedEarthChoices({ ...settings, frozenCircleIds: undefined }).frozenCircleIds, []);
});

test("People and map instances have independent accessible descriptions and escape custom friend names", () => {
  const people = view({ idPrefix: "people-location", heading: "Моя геопозиция", person: { ...person, nickname: null } }, active);
  const map = view({ idPrefix: "map-location" }, active);
  assert.equal(people.toggle.props["aria-describedby"], "people-location-friend-one");
  assert.equal(map.toggle.props["aria-describedby"], "map-location-friend-one");
  assert.notEqual(people.status.props.id, map.status.props.id);
  assert.match(people.markup, /&lt;script&gt;Лена&lt;\/script&gt;/);
  assert.doesNotMatch(people.markup, /<script>/);
  assert.match(people.markup, /Моя геопозиция/);
  assert.deepEqual([...people.calls, ...map.calls], []);
});


test("paired buttons preserve the consent, pause and explicit revoke actions without starting GPS", async () => {
  const companionControl = FriendSharingButton({ checked: false, disabled: false, label: "Делиться статусом", title: "Статус",
    icon: null, status: "Не делюсь", onChange() {} });
  const first = view({ presentation: "buttons", companionControl });
  assert.equal(first.toggle.props.role, undefined);
  assert.equal(first.toggle.props["aria-pressed"], false);
  assert.equal(first.toggle.props["aria-describedby"], "earth-friend-access-friend-one");
  assert.equal(first.elements.filter(node => node.type === "button" && typeof node.props["aria-pressed"] === "boolean").length, 2);
  assert.doesNotMatch(first.markup, /role="switch"/);
  await first.toggle.props.onClick();
  assert.deepEqual(first.calls, [["share", { recipientCircleIds: [person.circleId], frozenCircleIds: [], precision: "APPROXIMATE", durationMinutes: 60 }]]);
  const live = view({ presentation: "buttons", companionControl }, active);
  assert.equal(live.toggle.props["aria-pressed"], true);
  assert.equal(text(live.status), "Передача на паузе");
  assert.equal(live.elements.find(node => node.type === "details").props.open, undefined);
  await live.toggle.props.onClick();
  await live.button("Убрать доступ").props.onClick();
  assert.deepEqual(live.calls, [["frozen", person.circleId, true], ["revoke", person.circleId]]);
});

test("paired location button preserves disabled privacy and mutation states", async () => {
  for (const [overrides, choices] of [
    [{}, { ...active, mode: "GHOST" }], [{ online: false }, active], [{ working: true }, active],
    [{ sharing: { saving: true } }, active], [{ sharing: { pendingGhost: true, pendingPrivacyMode: "OFF" } }, active],
    [{ sharing: { settings: null, loading: true } }, active], [{ onSetFrozen: undefined }, active],
    [{ onShare: undefined }, settings],
  ]) {
    const result = view({ presentation: "buttons", ...overrides }, choices);
    assert.equal(result.toggle.props.disabled, true);
    await result.toggle.props.onClick();
    assert.deepEqual(result.calls, []);
  }
  const frozen = view({ presentation: "buttons" }, { ...active, frozenCircleIds: [person.circleId] });
  assert.equal(frozen.toggle.props["aria-pressed"], false);
  assert.equal(text(frozen.status), "Последнее место");
  await frozen.toggle.props.onClick();
  assert.deepEqual(frozen.calls, [["frozen", person.circleId, false]]);
});

test("the compact status control reports text and pressed state and honours native and handler disabling", () => {
  for (const checked of [false, true]) for (const disabled of [false, true]) {
    const calls = [];
    const button = FriendSharingButton({ checked, disabled, label: "Делиться статусом", title: "Статус", icon: null,
      status: checked ? "Делюсь" : "Не делюсь", description: "status-scope", onChange: () => calls.push("change") });
    assert.equal(button.props["aria-pressed"], checked);
    assert.equal(button.props["aria-describedby"], "status-scope");
    assert.equal(button.props.disabled, disabled);
    assert.equal(text(button), "Статус" + (checked ? "Делюсь" : "Не делюсь"));
    button.props.onClick();
    assert.deepEqual(calls, disabled ? [] : ["change"]);
  }
});
