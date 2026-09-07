import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const store = await vite.ssrLoadModule("/lib/dev-api-store.ts");
const nickname = await vite.ssrLoadModule("/lib/person-nickname.ts");
after(() => vite.close());
const key = () => crypto.randomUUID();
function ok(result) { assert.equal(result.kind, "ok"); return result.value; }
function connect(a, b) {
  const request = ok(store.sendDevDirectRequest(a.token, b.me.user.publicId, key()));
  ok(store.actOnDevDirectRequest(b.token, request.request.requestId, "ACCEPTED"));
  return ok(store.listDevPeople(a.token)).people.find(p => p.user.publicId === b.me.user.publicId);
}
test("nickname validation counts Unicode characters and rejects controls", () => {
  assert.equal(nickname.normalizePersonNickname("  Мама   💚  "), "Мама 💚");
  assert.equal(nickname.normalizePersonNickname(" "), "");
  assert.equal(nickname.normalizePersonNickname("😀".repeat(50)), "😀".repeat(50));
  for (const value of ["😀".repeat(51), "a\nb", "x\u202ey", "x\u0000y"]) assert.equal(nickname.normalizePersonNickname(value), null);
});
test("nickname belongs only to its viewer, survives reconnection and can be cleared", () => {
  store.resetDevStoreForTests();
  const owner = store.createDevIdentity("Владелец", key());
  const friend = store.createDevIdentity("Настоящее имя", key());
  const outsider = store.createDevIdentity("Посторонний", key());
  const person = connect(owner, friend);
  ok(store.updateDevSharing(owner.token, person.circleId, "OFF"));
  const before = ok(store.listDevPeople(owner.token));
  assert.equal(ok(store.updateDevNickname(owner.token, person.circleId, "  Мама  ")).nickname, "Мама");
  const after = ok(store.listDevPeople(owner.token));
  assert.deepEqual(after.people[0], { ...before.people[0], nickname: "Мама" });
  assert.equal(after.audienceCount, before.audienceCount);
  assert.equal(nickname.personDisplayName(after.people[0]), "Мама");
  assert.equal(store.getDevIdentity(friend.token).user.displayName, "Настоящее имя");
  assert.equal(ok(store.listDevPeople(friend.token)).people[0].nickname, null);
  assert.equal(store.updateDevNickname(undefined, person.circleId, "Чужое").kind, "unauthorized");
  assert.equal(store.updateDevNickname(outsider.token, person.circleId, "Чужое").kind, "forbidden");
  ok(store.removeDevPerson(owner.token, person.circleId));
  assert.equal(store.updateDevNickname(owner.token, person.circleId, "Чужое").kind, "not-found");
  const restored = connect(owner, friend);
  assert.notEqual(restored.circleId, person.circleId);
  assert.equal(restored.nickname, "Мама");
  ok(store.updateDevNickname(owner.token, restored.circleId, ""));
  const cleared = ok(store.listDevPeople(owner.token)).people[0];
  assert.equal(cleared.nickname, null);
  assert.equal(nickname.personDisplayName(cleared), "Настоящее имя");
});
test("removing a direct connection does not lift OFF through a shared group", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-06T12:00:00Z") });
  store.resetDevStoreForTests();
  const owner = store.createDevIdentity("Владелец", key());
  const friend = store.createDevIdentity("Друг", key());
  const person = connect(owner, friend);
  const groupId = ok(store.createDevGroup(owner.token, "Семья", null, [person.circleId], key())).groupId;
  const invite = ok(store.listDevGroups(friend.token)).incomingInvites[0];
  ok(store.actOnDevGroupInvite(friend.token, invite.inviteId, "ACCEPTED"));
  t.mock.timers.tick(1000);
  ok(store.updateDevSharing(owner.token, person.circleId, "OFF"));
  ok(store.removeDevPerson(owner.token, person.circleId));
  t.mock.timers.tick(1000);
  ok(store.updateDevStatus(owner.token, "Дома", key()));
  assert.equal(store.createDevCheckIn(owner.token, key()).kind, "accepted");
  const member = ok(store.listDevGroups(friend.token)).groups.find(g => g.groupId === groupId).members.find(m => m.user.publicId === owner.me.user.publicId);
  assert.equal(member.lastCheckInAt, null);
  assert.equal(member.status, null);
});
