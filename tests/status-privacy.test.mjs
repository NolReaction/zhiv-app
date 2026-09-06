import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType:"custom", configFile:false, root, resolve:{alias:{"@":root}}, server:{middlewareMode:true,hmr:false} });
const store = await vite.ssrLoadModule("/lib/dev-api-store.ts");
const status = await vite.ssrLoadModule("/lib/user-status.ts");
after(() => vite.close());
const key = () => crypto.randomUUID();
function ok(result) { assert.equal(result.kind,"ok"); return result.value; }
function connect(a,b) {
  const request=ok(store.sendDevDirectRequest(a.token,b.me.user.publicId,key()));
  ok(store.actOnDevDirectRequest(b.token,request.request.requestId,"ACCEPTED"));
  return ok(store.listDevPeople(a.token)).people.find(p=>p.user.publicId===b.me.user.publicId);
}
function group(owner,members,title) {
  const id=ok(store.createDevGroup(owner.token,title,null,members.map(m=>m.person.circleId),key())).groupId;
  for(const {account} of members) {
    const invitation=ok(store.listDevGroups(account.token)).incomingInvites.find(i=>i.groupId===id);
    ok(store.actOnDevGroupInvite(account.token,invitation.inviteId,"ACCEPTED"));
  }
  return id;
}
test("status validation accepts plain Unicode and rejects controls/oversize",()=>{
  assert.equal(status.normalizeUserStatus("  гуляю   дома "),"гуляю дома");
  assert.equal(status.normalizeUserStatus(""),"");
  assert.equal(status.normalizeUserStatus("😀".repeat(120)),"😀".repeat(120));
  for(const value of ["я\nдома","a\u202eb","x".repeat(121)]) assert.equal(status.normalizeUserStatus(value),null);
});
test("group OFF closes every route, person ON only restores that recipient, and status follows privacy",t=>{
  t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-09-05T12:00:00Z")});
  store.resetDevStoreForTests();
  const owner=store.createDevIdentity("Дима",key());
  const vanya=store.createDevIdentity("Ваня",key());
  const mama=store.createDevIdentity("Мама",key());
  const outsider=store.createDevIdentity("Посторонний",key());
  const vp=connect(owner,vanya),mp=connect(owner,mama);
  const family=group(owner,[{account:vanya,person:vp},{account:mama,person:mp}],"Семья");
  const other=group(owner,[{account:vanya,person:vp}],"Друзья");
  t.mock.timers.tick(1000);
  const before=ok(store.updateDevStatus(owner.token,"гуляю",key()));
  assert.equal(before.checkInCount,0);
  assert.equal(before.lastCheckInAt,null);
  const mark=store.createDevCheckIn(owner.token,key()); assert.equal(mark.kind,"accepted");
  assert.equal(ok(store.listDevPeople(vanya.token)).people[0].status.text,"гуляю");
  ok(store.updateDevGroupSharing(owner.token,family,"OFF"));
  assert.equal(ok(store.listDevPeople(owner.token)).audienceCount,0);
  for(const account of [vanya,mama]) {
    const person=ok(store.listDevPeople(account.token)).people[0];
    assert.equal(person.theirSharingMode,"OFF");assert.equal(person.lastCheckInAt,null);assert.equal(person.status,null);
  }
  assert.equal(ok(store.listDevGroups(owner.token)).groups.find(g=>g.groupId===other).mySharingMode,"OFF");
  assert.equal(store.updateDevSharing(outsider.token,vp.circleId,"LATEST_ONLY").kind,"forbidden");
  assert.equal(store.updateDevGroupSharing(outsider.token,family,"LATEST_ONLY").kind,"not-found");
  t.mock.timers.tick(1000);
  ok(store.updateDevSharing(owner.token,vp.circleId,"LATEST_ONLY"));
  const mixed=ok(store.listDevGroups(owner.token)).groups.find(g=>g.groupId===family);
  assert.equal(mixed.sharingMixed,true);
  assert.equal(ok(store.listDevPeople(owner.token)).audienceCount,1);
  assert.equal(ok(store.listDevPeople(vanya.token)).people[0].lastCheckInAt,null);
  assert.equal(ok(store.listDevPeople(vanya.token)).people[0].status,null,"old status must not reappear");
  t.mock.timers.tick(1000);
  const writeKey=key();
  ok(store.updateDevStatus(owner.token,"дома",writeKey));
  assert.equal(ok(store.listDevPeople(vanya.token)).people[0].status.text,"дома");
  assert.equal(ok(store.listDevPeople(mama.token)).people[0].status,null);
  assert.equal(store.updateDevStatus(owner.token,"учусь",writeKey).kind,"conflict");
  ok(store.updateDevStatus(owner.token,"",key()));
  assert.equal(ok(store.listDevPeople(vanya.token)).people[0].status,null);
  assert.equal(store.getDevIdentity(owner.token).checkInCount,1);
  assert.equal(store.updateDevStatus(undefined,"дома",key()).kind,"unauthorized");
  ok(store.deleteDevGroup(owner.token,family));
  assert.equal(ok(store.listDevPeople(mama.token)).people[0].theirSharingMode,"OFF","archiving group cannot lift a saved deny");
});

test("optional status deadlines expire in every view and retries never extend them", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-06T12:00:00Z") });
  store.resetDevStoreForTests();
  const owner = store.createDevIdentity("Дима", key());
  const friend = store.createDevIdentity("Друг", key());
  const person = connect(owner, friend);
  const groupId = group(owner, [{ account: friend, person }], "Семья");
  t.mock.timers.tick(1000);
  const writeKey = key();
  const saved = ok(store.updateDevStatus(owner.token, "Гуляю", writeKey, 120));
  assert.equal(Date.parse(saved.status.expiresAt) - Date.parse(saved.status.updatedAt), 7_200_000);
  const memberStatus = account => ok(store.listDevGroups(account.token)).groups.find(g => g.groupId === groupId).members.find(m => m.user.publicId === owner.me.user.publicId).status;
  t.mock.timers.tick(7_199_999);
  assert.deepEqual(store.getDevIdentity(owner.token).status, saved.status);
  assert.deepEqual(ok(store.listDevPeople(friend.token)).people[0].status, saved.status);
  assert.deepEqual(memberStatus(owner), saved.status);
  assert.deepEqual(memberStatus(friend), saved.status);
  assert.deepEqual(ok(store.updateDevStatus(owner.token, "Гуляю", writeKey, 120)).status, saved.status);
  assert.equal(store.updateDevStatus(owner.token, "Гуляю", writeKey, 60).kind, "conflict");
  t.mock.timers.tick(1);
  for (const value of [store.getDevIdentity(owner.token).status, ok(store.listDevPeople(friend.token)).people[0].status, memberStatus(owner), memberStatus(friend)]) assert.equal(value, null);
  assert.equal(ok(store.updateDevStatus(owner.token, "Гуляю", writeKey, 120)).status, null);
  const renewed = ok(store.updateDevStatus(owner.token, "Гуляю", key(), 60));
  assert.ok(renewed.status.updatedAt > saved.status.updatedAt);
  assert.equal(renewed.checkInCount, 0);
  assert.equal(renewed.lastCheckInAt, null);
  const indefinite = ok(store.updateDevStatus(owner.token, "Гуляю", key()));
  assert.equal(indefinite.status.expiresAt, null);
  t.mock.timers.tick(3 * 86_400_000);
  assert.deepEqual(store.getDevIdentity(owner.token).status, indefinite.status);
  assert.equal(ok(store.updateDevStatus(owner.token, "", key(), 60)).status, null);
});

test("duration validation and client visibility agree at the exact deadline", () => {
  for (const value of [undefined, null, 60, 120, 240, 480, 1440]) assert.equal(status.validStatusDuration(value), true);
  for (const value of [0, -1, 60.5, 30, 1441, "120", true, {}, NaN]) assert.equal(status.validStatusDuration(value), false);
  const timed = { text: "Дома", updatedAt: "2026-09-06T12:00:00Z", expiresAt: "2026-09-06T14:00:00Z" };
  assert.equal(status.activeUserStatus(timed, Date.parse(timed.expiresAt) - 1), timed);
  assert.equal(status.activeUserStatus(timed, Date.parse(timed.expiresAt)), null);
  assert.equal(status.activeUserStatus({ ...timed, expiresAt: null }, Date.parse("2027-01-01T00:00:00Z")).text, "Дома");
  assert.equal(status.formatStatusUpdatedAt(timed.updatedAt, Date.parse(timed.updatedAt) + 5 * 60_000), "обновлён 5 мин назад");
});

test("favorites are private durable choices without changing visibility", () => {
  store.resetDevStoreForTests();
  const owner = store.createDevIdentity("Владелец", key());
  const anna = store.createDevIdentity("Анна", key());
  const yana = store.createDevIdentity("Яна", key());
  const outsider = store.createDevIdentity("Посторонний", key());
  connect(owner, anna);
  const person = connect(owner, yana);
  ok(store.updateDevSharing(owner.token, person.circleId, "OFF"));
  const before = ok(store.listDevPeople(owner.token));
  assert.equal(before.people[0].user.publicId, anna.me.user.publicId);
  ok(store.updateDevFavorite(owner.token, person.circleId, true));
  ok(store.updateDevFavorite(owner.token, person.circleId, true));
  const after = ok(store.listDevPeople(owner.token));
  assert.equal(after.people[0].user.publicId, yana.me.user.publicId);
  assert.equal(after.people[0].isFavorite, true);
  assert.equal(after.people[0].mySharingMode, "OFF");
  assert.equal(after.audienceCount, before.audienceCount);
  assert.equal(ok(store.listDevPeople(yana.token)).people[0].isFavorite, false);
  assert.equal(store.updateDevFavorite(outsider.token, person.circleId, true).kind, "forbidden");
  assert.equal(store.updateDevFavorite(undefined, person.circleId, true).kind, "unauthorized");
  ok(store.updateDevFavorite(owner.token, person.circleId, false));
  assert.equal(ok(store.listDevPeople(owner.token)).people[0].user.publicId, anna.me.user.publicId);
  ok(store.updateDevFavorite(owner.token, person.circleId, true));
  ok(store.removeDevPerson(owner.token, person.circleId));
  assert.equal(store.updateDevFavorite(owner.token, person.circleId, true).kind, "not-found");
  const reconnected = connect(owner, yana);
  assert.notEqual(reconnected.circleId, person.circleId);
  assert.equal(reconnected.isFavorite, false);
});
