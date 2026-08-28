import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const store = await vite.ssrLoadModule("/lib/dev-api-store.ts");

after(async () => {
  await vite.close();
});

function ok(result) {
  assert.equal(result.kind, "ok");
  return result.value;
}

function connect(first, second) {
  const sent = ok(
    store.sendDevDirectRequest(first.token, second.me.user.publicId, crypto.randomUUID()),
  );
  ok(store.actOnDevDirectRequest(second.token, sent.request.requestId, "ACCEPTED"));
  return ok(store.listDevPeople(first.token)).people.find(
    (person) => person.user.publicId === second.me.user.publicId,
  );
}

test("groups require consent and preserve sharing boundaries", () => {
  store.resetDevStoreForTests();
  const dima = store.createDevIdentity("Дима", crypto.randomUUID());
  const mama = store.createDevIdentity("Мама", crypto.randomUUID());
  const ded = store.createDevIdentity("Дедушка", crypto.randomUUID());

  const mamaPerson = connect(dima, mama);
  const dedPerson = connect(dima, ded);
  assert.ok(mamaPerson);
  assert.ok(dedPerson);

  const oldMamaMark = store.createDevCheckIn(mama.token, crypto.randomUUID());
  assert.equal(oldMamaMark.kind, "accepted");

  const creationKey = crypto.randomUUID();
  const created = ok(store.createDevGroup(
    dima.token,
    "Семья",
    "👨‍👩‍👧‍👦",
    [mamaPerson.circleId, dedPerson.circleId],
    creationKey,
  ));
  const replay = ok(store.createDevGroup(
    dima.token,
    "Другое название",
    null,
    [],
    creationKey,
  ));
  assert.equal(replay.groupId, created.groupId);
  assert.equal(replay.replayed, true);

  const beforeConsent = ok(store.listDevGroups(dima.token));
  assert.equal(beforeConsent.groups.length, 1);
  assert.equal(beforeConsent.groups[0].members.length, 1);
  assert.equal(beforeConsent.groups[0].pendingInvites.length, 2);

  const mamaInvite = ok(store.listDevGroups(mama.token)).incomingInvites[0];
  const dedInvite = ok(store.listDevGroups(ded.token)).incomingInvites[0];
  assert.equal(
    store.actOnDevGroupInvite(dima.token, mamaInvite.inviteId, "ACCEPTED").kind,
    "forbidden",
  );
  ok(store.actOnDevGroupInvite(mama.token, mamaInvite.inviteId, "ACCEPTED"));
  ok(store.actOnDevGroupInvite(ded.token, dedInvite.inviteId, "ACCEPTED"));

  const afterConsent = ok(store.listDevGroups(dima.token)).groups[0];
  const mamaMember = afterConsent.members.find(
    (member) => member.user.publicId === mama.me.user.publicId,
  );
  assert.equal(
    mamaMember.lastCheckInAt,
    null,
    "a mark from before joining must never appear in the group",
  );

  const dedMark = store.createDevCheckIn(ded.token, crypto.randomUUID());
  assert.equal(dedMark.kind, "accepted");
  const visibleDed = ok(store.listDevGroups(dima.token)).groups[0].members.find(
    (member) => member.user.publicId === ded.me.user.publicId,
  );
  assert.equal(visibleDed.lastCheckInAt, dedMark.value.checkedAt);

  ok(store.updateDevGroupSharing(ded.token, created.groupId, "OFF"));
  assert.equal(
    ok(store.listDevGroups(dima.token)).groups[0].members.find(
      (member) => member.user.publicId === ded.me.user.publicId,
    ).lastCheckInAt,
    null,
  );
  ok(store.updateDevGroupSharing(ded.token, created.groupId, "LATEST_ONLY"));
  assert.equal(
    ok(store.listDevGroups(dima.token)).groups[0].members.find(
      (member) => member.user.publicId === ded.me.user.publicId,
    ).lastCheckInAt,
    null,
    "re-enabling must not resurrect a mark from the previous sharing period",
  );

  assert.equal(
    ok(store.listDevPeople(dima.token)).audienceCount,
    2,
    "the same people reached through direct and group paths count once",
  );
});

test("only the owner manages members and archives the group", () => {
  store.resetDevStoreForTests();
  const owner = store.createDevIdentity("Создатель", crypto.randomUUID());
  const member = store.createDevIdentity("Участник", crypto.randomUUID());
  const person = connect(owner, member);
  const groupId = ok(store.createDevGroup(
    owner.token,
    "Друзья",
    "🤝",
    [person.circleId],
    crypto.randomUUID(),
  )).groupId;
  const invite = ok(store.listDevGroups(member.token)).incomingInvites[0];
  ok(store.actOnDevGroupInvite(member.token, invite.inviteId, "ACCEPTED"));

  assert.equal(
    store.updateDevGroup(member.token, groupId, "Взлом", null).kind,
    "forbidden",
  );
  assert.equal(store.deleteDevGroup(member.token, groupId).kind, "forbidden");

  const memberSnapshot = ok(store.listDevGroups(owner.token)).groups[0].members.find(
    (entry) => !entry.isMe,
  );
  ok(store.removeDevGroupMember(owner.token, groupId, memberSnapshot.membershipId));
  ok(
    store.removeDevGroupMember(owner.token, groupId, memberSnapshot.membershipId),
    "a lost successful response must be safe to retry",
  );
  assert.equal(ok(store.listDevGroups(owner.token)).groups[0].members.length, 1);
  ok(store.deleteDevGroup(owner.token, groupId));
  assert.equal(ok(store.listDevGroups(owner.token)).groups.length, 0);
});
