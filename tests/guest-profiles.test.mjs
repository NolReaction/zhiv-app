import assert from "node:assert/strict";
import test, { after, beforeEach, afterEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/people/guest-profile-model.ts");
const api = await vite.ssrLoadModule("/features/people/guest-profile-api.ts");
const ui = await vite.ssrLoadModule("/features/people/guest-profile.tsx");
const fetchOriginal = globalThis.fetch;
after(() => vite.close());
beforeEach(() => social.resetDevStoreForTests());
afterEach(() => { globalThis.fetch = fetchOriginal; });
const key = () => crypto.randomUUID();
const player = () => social.createDevIdentity("Лесник", key());
function ok(result) { assert.equal(result.kind, "ok"); return result.value; }
function connect(a, b) { const request = ok(social.sendDevDirectRequest(a.token, b.me.user.publicId, key())); return ok(social.actOnDevDirectRequest(b.token, request.request.requestId, "ACCEPTED")).person.circleId; }
const read = (a, circle) => ok(social.getDevGuestProfile(a.token, circle));

 test("friend read is read-only and does not initialize another player's game or economy", () => {
  const a = player(), b = player(), circle = connect(a, b);
  const before = structuredClone(globalThis.__zhivDevEconomyStore?.profiles);
  const result = read(a, circle);
  assert.equal(result.homeLevel, 1); assert.equal(result.completedExplorations, 0);
  assert.deepEqual(result.collections, { travel: [], fishing: [], quarry: [] }); assert.deepEqual(result.achievements, []);
  assert.equal(result.ownerPublicId, a.me.user.publicId); assert.equal(result.user.publicId, b.me.user.publicId);
  assert.equal(model.guestProfileSchema.safeParse(result).success, true);
  assert.equal(globalThis.__zhivDevEconomyStore.profiles.size, before?.size ?? 0);
});

test("guest projection only contains known personal discoveries and safe earned world achievements", () => {
  const a = player(), b = player(), circle = connect(a, b);
  economy.getDevEconomy(b.token);
  const record = globalThis.__zhivDevEconomyStore.profiles.get(b.me.user.publicId);
  const fish = model.GUEST_COLLECTION_IDS.fishing[0];
  Object.assign(record.state, { buildings: { home: 3, warehouse: 1 }, completedExplorations: 12,
    inventory: { fish_silverfin: 800, wood: 999 }, wallet: { coins: 123, pearls: 8 }, fishingCastSeed: "secret",
    rareDropState: { version: 1, remainingSeconds: 99999, itemId: "ancient_core" } });
  record.state.progression.collections = { finds: ["acorn", "acorn", "quartz_cluster", "unknown"], travelSeconds: 999, quarrySeconds: 123 };
  record.state.fishing.catches = { [fish]: 4, unknown: 999 };
  for (const id of ["home_builder", "linked_email", "saved_recovery_code", "seven_day_streak", "five_friends", "thousand_taps"])
    social.grantDevAchievementForAdmin(b.me.user.publicId, id);
  const before = structuredClone(record), result = read(a, circle);
  assert.equal(result.homeLevel, 3); assert.equal(result.completedExplorations, 12);
  assert.deepEqual(result.collections, { travel: ["acorn"], fishing: [fish], quarry: ["quartz_cluster"] });
  assert.deepEqual(result.achievements, [{ id: "home_builder", level: 4 }]);
  assert.deepEqual(record, before);
  assert.deepEqual(Object.keys(result).sort(), ["ownerPublicId", "circleId", "user", "homeLevel", "completedExplorations", "achievements", "collections", "serverTime"].sort());
  for (const secret of ["wallet", "inventory", "jobs", "fishingCastSeed", "rareDropState", "unlockedAt", "travelSeconds", "quarrySeconds", "linked_email", "saved_recovery_code", "status", "bestSeries"])
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  result.collections.travel.push("forged"); assert.deepEqual(read(a, circle).collections.travel, ["acorn"]);
});

test("unknown circles outsiders requests only removed friendships and subject OFF return the same not-found", () => {
  const a = player(), b = player(), stranger = player(), circle = connect(a, b);
  assert.deepEqual(social.getDevGuestProfile(undefined, circle), { kind: "unauthorized" });
  for (const [token, id] of [[stranger.token, circle], [a.token, key()], [a.token, b.me.user.publicId]])
    assert.deepEqual(social.getDevGuestProfile(token, id), { kind: "not-found" });
  ok(social.updateDevSharing(a.token, circle, "OFF")); read(a, circle);
  assert.deepEqual(social.getDevGuestProfile(b.token, circle), { kind: "not-found" });
  ok(social.updateDevSharing(b.token, circle, "OFF"));
  assert.deepEqual(social.getDevGuestProfile(a.token, circle), { kind: "not-found" });
  ok(social.updateDevSharing(b.token, circle, "LATEST_ONLY")); read(a, circle);
  ok(social.removeDevPerson(a.token, circle));
  assert.deepEqual(social.getDevGuestProfile(a.token, circle), { kind: "not-found" });
});

test("group privacy denial reaches direct friend profiles and removing the group cannot reopen it", () => {
  const a = player(), b = player(), circle = connect(a, b);
  const groupId = ok(social.createDevGroup(b.token, "Круг", null, [circle], key())).groupId;
  const invite = ok(social.listDevGroups(a.token)).incomingInvites.find(item => item.groupId === groupId);
  ok(social.actOnDevGroupInvite(a.token, invite.inviteId, "ACCEPTED")); read(a, circle);
  ok(social.updateDevGroupSharing(b.token, groupId, "OFF"));
  assert.deepEqual(social.getDevGuestProfile(a.token, circle), { kind: "not-found" });
  ok(social.deleteDevGroup(b.token, groupId));
  assert.deepEqual(social.getDevGuestProfile(a.token, circle), { kind: "not-found" });
  ok(social.updateDevSharing(b.token, circle, "LATEST_ONLY")); read(a, circle);
});

test("API binds every successful response to viewer friendship and subject and never sends an owner override", async () => {
  const a = player(), b = player(), circle = connect(a, b), value = read(a, circle);
  let called;
  globalThis.fetch = async (url, options) => { called = { url, options }; return Response.json(value); };
  assert.deepEqual(await api.getGuestProfile(a.me.user.publicId, circle, b.me.user.publicId), value);
  assert.equal(called.url, `/api/v1/people/${circle}/game-profile`); assert.equal(called.options.cache, "no-store");
  assert.equal(called.options.credentials, "same-origin");
  for (const patch of [{ ownerPublicId: b.me.user.publicId }, { circleId: key() }, { user: { ...value.user, publicId: a.me.user.publicId } }]) {
    globalThis.fetch = async () => Response.json({ ...value, ...patch });
    await assert.rejects(api.getGuestProfile(a.me.user.publicId, circle, b.me.user.publicId), { status: 409 });
  }
  globalThis.fetch = async () => Response.json({ ...value, inventory: { wood: 999 } });
  await assert.rejects(api.getGuestProfile(a.me.user.publicId, circle, b.me.user.publicId), { status: 502 });
});

test("closed or switched profile ignores even a transport that finishes after cancellation", async () => {
  const a = player(), b = player(), circle = connect(a, b), value = read(a, circle), controller = new AbortController();
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = () => resolve(Response.json(value)); });
  const request = api.getGuestProfile(a.me.user.publicId, circle, b.me.user.publicId, controller.signal);
  controller.abort(); finish();
  await assert.rejects(request, { name: "AbortError" });
});

test("strict profile schema rejects hidden IDs duplicated discoveries invalid tiers and private nested fields", () => {
  const a = player(), b = player(), circle = connect(a, b), value = read(a, circle);
  for (const patch of [
    { achievements: [{ id: "linked_email", level: 1 }] }, { achievements: [{ id: "explorer", level: 4 }] },
    { achievements: [{ id: "first_path", level: 1, unlockedAt: value.serverTime }] },
    { collections: { ...value.collections, travel: ["acorn", "acorn"] } },
    { collections: { ...value.collections, fishing: ["ancient_core"] } },
    { user: { ...value.user, email: "private@example.test" } }, { homeLevel: 0 }, { completedExplorations: -1 },
  ]) assert.equal(model.guestProfileSchema.safeParse({ ...value, ...patch }).success, false);
});

test("profile content renders labeled safe stats medals and collection chapters with offline privacy states", () => {
  const a = player(), b = player(), circle = connect(a, b), value = read(a, circle);
  value.achievements = [{ id: "home_builder", level: 2 }]; value.collections.travel = ["acorn"];
  const html = renderToStaticMarkup(createElement(ui.GuestProfileContents, { profile: value }));
  for (const text of ["Уровень дома", "Завершено вылазок", "Страниц коллекции", "Достижения друга", "Книга находок", "Ступень 2 из 4", "Посещение самой поляны появится позже."])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('<summary>Путешествия')); assert.ok(html.includes('data-collection-icon="acorn"'));
  for (const text of ["Жемчуг", "Монеты", "Получить награду", "fishingCastSeed"]) assert.equal(html.includes(text), false);
  const props = { ownerPublicId: a.me.user.publicId, circleId: circle, targetPublicId: b.me.user.publicId, onSessionLost() {}, sharingAllowed: false, isOnline: true };
  assert.ok(renderToStaticMarkup(createElement(ui.GuestProfileSection, props)).includes("скрыт настройками"));
  assert.ok(renderToStaticMarkup(createElement(ui.GuestProfileSection, { ...props, sharingAllowed: true, isOnline: false })).includes("Подключитесь к интернету"));
});
