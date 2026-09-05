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
