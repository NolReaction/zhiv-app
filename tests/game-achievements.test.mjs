import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const validation = await vite.ssrLoadModule("/lib/dev/game-validation.ts");
beforeEach(() => { identities.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });
after(() => vite.close());

function ok(result) {
  assert.equal(result.kind, "ok", JSON.stringify(result));
  return result.value;
}
function player(name) {
  const bootstrapKey = crypto.randomUUID();
  return { ...identities.createDevIdentity(name, bootstrapKey), bootstrapKey };
}
function connect(first, second) {
  const pending = ok(identities.sendDevDirectRequest(first.token, second.me.user.publicId, crypto.randomUUID()));
  return ok(identities.actOnDevDirectRequest(second.token, pending.request.requestId, "ACCEPTED")).person;
}
function score(user, taps) {
  const session = ok(game.createDevGameSession(user.token, user.me.user.publicId, crypto.randomUUID()));
  ok(game.submitDevGameBatch(user.token, { sessionId: session.sessionId, sequence: 1, tapCount: taps, runId: crypto.randomUUID() }));
  ok(game.updateDevGameVisibility(user.token, user.me.user.publicId, true, 0));
}
function achievement(user, id) {
  return ok(game.getDevGameAchievements(user.token)).achievements.find(item => item.id === id);
}

test("leaderboard scope validation accepts only one known value and defaults to global", () => {
  assert.equal(validation.parseDevGameScope(new URLSearchParams()), "global");
  assert.equal(validation.parseDevGameScope(new URLSearchParams("scope=global")), "global");
  assert.equal(validation.parseDevGameScope(new URLSearchParams("scope=friends")), "friends");
  for (const query of ["scope=", "scope=all", "scope=FRIENDS", "scope=friends&scope=friends", "scope=friends&scope=global"]) {
    assert.equal(validation.parseDevGameScope(new URLSearchParams(query)), null);
  }
});

test("friends leaderboard ranks only active direct friends and self with consent", () => {
  const owner = player("Owner");
  const friend = player("Friend");
  const hidden = player("Private friend");
  const pending = player("Pending");
  const former = player("Group only");
  const stranger = player("Stranger");
  const relation = connect(owner, friend);
  connect(hidden, owner);
  ok(identities.sendDevDirectRequest(owner.token, pending.me.user.publicId, crypto.randomUUID()));
  const formerRelation = connect(owner, former);
  const group = ok(identities.createDevGroup(owner.token, "Group", null, [formerRelation.circleId], crypto.randomUUID()));
  const invitations = ok(identities.listDevGroups(former.token));
  ok(identities.actOnDevGroupInvite(former.token, invitations.incomingInvites[0].inviteId, "ACCEPTED"));
  ok(identities.removeDevPerson(owner.token, formerRelation.circleId));
  assert.equal(ok(identities.listDevGroups(former.token)).groups[0].groupId, group.groupId);
  for (const [user, taps] of [[owner, 5], [friend, 10], [hidden, 20], [pending, 25], [former, 30], [stranger, 40]]) score(user, taps);
  ok(game.updateDevGameVisibility(hidden.token, hidden.me.user.publicId, false, 1));
  const board = ok(game.getDevGameLeaderboard(owner.token, "friends"));
  assert.equal(board.scope, "friends");
  assert.deepEqual(board.entries.map(item => [item.displayName, item.rank, item.isMe]), [["Friend", 1, false], ["Owner", 2, true]]);
  assert.equal(board.myRank, 2);
  assert.equal(ok(game.getDevGameLeaderboard(owner.token)).scope, "global");
  assert.equal(ok(game.getDevGameLeaderboard(owner.token)).myRank, 5);
  ok(identities.removeDevPerson(owner.token, relation.circleId));
  assert.equal(ok(game.getDevGameLeaderboard(owner.token, "friends")).myRank, 1);
  ok(game.updateDevGameVisibility(owner.token, owner.me.user.publicId, false, 1));
  assert.deepEqual(ok(game.getDevGameLeaderboard(owner.token, "friends")).entries, []);
  assert.equal(ok(game.getDevGameLeaderboard(owner.token, "friends")).myRank, null);
  assert.equal(game.getDevGameLeaderboard(undefined, "friends").code, "UNAUTHORIZED");
});

test("friends leaderboard keeps own rank outside its top 100 and does not rank strangers", () => {
  const owner = player("Owner");
  score(owner, 1);
  const invite = crypto.randomUUID();
  ok(identities.createDevDirectInviteLink(owner.token, invite, crypto.randomUUID()));
  for (let index = 0; index < 100; index++) {
    const friend = player(`Friend ${index}`);
    ok(identities.redeemDevDirectInvite(friend.token, invite, crypto.randomUUID()));
    score(friend, 2);
  }
  const stranger = player("Stranger");
  score(stranger, 60);
  const board = ok(game.getDevGameLeaderboard(owner.token, "friends"));
  assert.equal(board.entries.length, 100);
  assert.equal(board.myRank, 101);
  assert.ok(board.entries.every(item => !item.isMe && item.displayName !== "Stranger"));
  assert.deepEqual(board.entries.map(item => item.rank), Array.from({ length: 100 }, (_, index) => index + 1));
});

test("five friends is awarded on acceptance to both parties and survives removal before first read", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const first = player("First");
  const second = player("Second");
  for (const owner of [first, second]) {
    for (let index = 0; index < 4; index++) connect(owner, player(`${owner.me.user.displayName} ${index}`));
    assert.deepEqual(achievement(owner, "five_friends"), { id: "five_friends", progress: 4, target: 5, unlockedAt: null });
  }
  const pending = ok(identities.sendDevDirectRequest(first.token, second.me.user.publicId, crypto.randomUUID()));
  assert.equal(achievement(first, "five_friends").unlockedAt, null);
  const acceptedAt = new Date().toISOString();
  const relation = ok(identities.actOnDevDirectRequest(second.token, pending.request.requestId, "ACCEPTED")).person;
  context.mock.timers.setTime(Date.now() + 60_000);
  ok(identities.removeDevPerson(first.token, relation.circleId));
  for (const owner of [first, second]) {
    assert.deepEqual(achievement(owner, "five_friends"), { id: "five_friends", progress: 5, target: 5, unlockedAt: acceptedAt });
  }
  const anotherDevice = identities.createDevIdentity("Ignored", first.bootstrapKey);
  assert.equal(achievement(anotherDevice, "five_friends").unlockedAt, acceptedAt);
  assert.equal(achievement(player("Stranger"), "five_friends").unlockedAt, null);
});

test("multi-use invitation acceptance awards the fifth concurrent friend and repeat links do not inflate it", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player("Owner");
  const guest = player("Guest");
  const invite = crypto.randomUUID();
  ok(identities.createDevDirectInviteLink(owner.token, invite, crypto.randomUUID()));
  const key = crypto.randomUUID();
  ok(identities.redeemDevDirectInvite(guest.token, invite, key));
  ok(identities.redeemDevDirectInvite(guest.token, invite, key));
  assert.equal(achievement(owner, "five_friends").progress, 1);
  for (let index = 0; index < 3; index++) {
    const friend = player(`Friend ${index}`);
    ok(identities.redeemDevDirectInvite(friend.token, invite, crypto.randomUUID()));
  }
  const fifth = player("Fifth");
  const acceptedAt = new Date().toISOString();
  const relation = ok(identities.redeemDevDirectInvite(fifth.token, invite, crypto.randomUUID())).person;
  context.mock.timers.setTime(Date.now() + 60_000);
  ok(identities.removeDevPerson(owner.token, relation.circleId));
  assert.equal(achievement(owner, "five_friends").unlockedAt, acceptedAt);
  assert.equal(achievement(owner, "five_friends").progress, 5);
});

test("seven-day achievement follows the server rolling streak and records the qualifying check-in", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player("Owner");
  let qualifiedAt;
  for (let day = 0; day < 7; day++) {
    if (day) context.mock.timers.setTime(Date.now() + 86_400_000);
    const result = identities.createDevCheckIn(owner.token, crypto.randomUUID());
    assert.equal(result.kind, "accepted");
    assert.equal(result.value.streak.longestDays, day + 1);
    if (day === 5) assert.equal(achievement(owner, "seven_day_streak").unlockedAt, null);
    if (day === 6) qualifiedAt = result.value.checkedAt;
    ok(identities.updateDevTimeZone(owner.token, day % 2 ? "Etc/GMT+12" : "Pacific/Kiritimati", crypto.randomUUID()));
  }
  context.mock.timers.setTime(Date.now() + 3 * 86_400_000);
  assert.equal(identities.getDevIdentity(owner.token).streak.currentDays, 0);
  assert.deepEqual(achievement(owner, "seven_day_streak"), { id: "seven_day_streak", progress: 7, target: 7, unlockedAt: qualifiedAt });
});

test("only accepted server taps unlock a thousand taps and retries preserve the original award time", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player("Owner");
  const active = ok(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()));
  const runId = crypto.randomUUID();
  for (let index = 0; index < 16; index++) {
    if (index) context.mock.timers.setTime(Date.now() + 5_000);
    ok(game.submitDevGameBatch(owner.token, { sessionId: active.sessionId, sequence: index + 1, tapCount: 60, runId }));
  }
  const rejected = ok(game.submitDevGameBatch(owner.token, { sessionId: active.sessionId, sequence: 17, tapCount: 40, runId }));
  assert.equal(rejected.acceptedTaps, 0);
  assert.deepEqual(achievement(owner, "thousand_taps"), { id: "thousand_taps", progress: 960, target: 1_000, unlockedAt: null });
  context.mock.timers.setTime(Date.now() + 5_000);
  const request = { sessionId: active.sessionId, sequence: 18, tapCount: 40, runId };
  const qualifiedAt = new Date().toISOString();
  assert.equal(ok(game.submitDevGameBatch(owner.token, request)).progress.lifetimeTaps, 1_000);
  context.mock.timers.setTime(Date.now() + 60_000);
  assert.equal(ok(game.submitDevGameBatch(owner.token, request)).replayed, true);
  assert.deepEqual(achievement(owner, "thousand_taps"), { id: "thousand_taps", progress: 1_000, target: 1_000, unlockedAt: qualifiedAt });
  const anotherDevice = identities.createDevIdentity("Ignored", owner.bootstrapKey);
  const response = ok(game.getDevGameAchievements(anotherDevice.token));
  assert.equal(response.ownerPublicId, owner.me.user.publicId);
  assert.deepEqual(response.achievements.map(item => item.id), ["seven_day_streak", "thousand_taps", "five_friends", "ten_thousand_series", "linked_email", "saved_recovery_code"]);
  assert.equal(response.achievements[1].unlockedAt, qualifiedAt);
  assert.equal(game.getDevGameAchievements(undefined).code, "UNAUTHORIZED");
  identities.resetDevStoreForTests();
  assert.equal(game.getDevGameAchievements(owner.token).code, "UNAUTHORIZED");
  assert.ok(ok(game.getDevGameAchievements(player("New owner").token)).achievements.every(item => item.unlockedAt === null && item.progress === 0));
});


test("five friends needs five simultaneous connections, not repeated adding and removing", () => {
  const owner = player("Owner");
  for (let index = 0; index < 6; index++) {
    const relation = connect(owner, player(`Friend ${index}`));
    ok(identities.removeDevPerson(owner.token, relation.circleId));
  }
  connect(owner, player("Current friend"));
  assert.deepEqual(achievement(owner, "five_friends"), { id: "five_friends", progress: 1, target: 5, unlockedAt: null });
});

test("thirty-day reward and four items survive a broken streak and another device", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player("Owner");
  for (let day = 1; day <= 30; day++) {
    if (day > 1) context.mock.timers.setTime(Date.now() + 86_400_000);
    const result = identities.createDevCheckIn(owner.token, crypto.randomUUID()); assert.equal(result.kind, "accepted");
    const items = ok(game.getDevGameProgress(owner.token)).items;
    assert.equal(items.length, [3,7,14,30].filter(target => day >= target).length);
  }
  context.mock.timers.setTime(Date.now() + 3 * 86_400_000);
  const second = identities.createDevIdentity("Ignored", owner.bootstrapKey);
  assert.deepEqual(ok(game.getDevGameProgress(second.token)).items, ["flower", "leaf_bed", "keepsakes", "leaf_garland"]);
});
test("ten thousand in one game uses accepted best series, never combined lifetime taps", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player("Owner"), active = ok(game.createDevGameSession(owner.token, owner.me.user.publicId, crypto.randomUUID()));
  let runId = crypto.randomUUID(), sequence = 0;
  const send = taps => {
    context.mock.timers.setTime(Date.now() + 2_000);
    const request = { sessionId: active.sessionId, runId, sequence: ++sequence, tapCount: taps };
    assert.equal(ok(game.submitDevGameBatch(owner.token, request)).acceptedTaps, taps);
    return request;
  };
  for (let i = 0; i < 200; i++) { runId = crypto.randomUUID(); send(50); }
  assert.equal(ok(game.getDevGameProgress(owner.token)).lifetimeTaps, 10_000);
  assert.deepEqual(achievement(owner, "ten_thousand_series"), { id: "ten_thousand_series", progress: 50, target: 10_000, unlockedAt: null });
  runId = crypto.randomUUID();
  let total = 0;
  while (total < 9_999) { const taps = Math.min(60,9_999-total); send(taps); total += taps; }
  assert.equal(achievement(owner, "ten_thousand_series").progress, 9_999);
  assert.equal(achievement(owner, "ten_thousand_series").unlockedAt, null);
  const request = send(1), at = new Date().toISOString();
  context.mock.timers.setTime(Date.now() + 20_000); ok(game.submitDevGameBatch(owner.token,request));
  assert.equal(achievement(owner, "ten_thousand_series").unlockedAt, at);
});

test("saved code achievement requires successful activation and survives replacement and use", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T10:00:00Z") });
  const owner = player("Owner"), stranger = player("Stranger");
  const code = "generated-only", replacement = "replacement";
  assert.equal(achievement(owner,"saved_recovery_code").progress, 0);
  assert.equal(identities.activateDevRecoveryCode(undefined,code).kind,"unauthorized");
  const at = new Date().toISOString();
  ok(identities.activateDevRecoveryCode(owner.token,code));
  context.mock.timers.setTime(Date.now() + 60_000);
  ok(identities.activateDevRecoveryCode(owner.token,code));
  assert.equal(identities.activateDevRecoveryCode(stranger.token,code).kind,"conflict");
  assert.equal(achievement(stranger,"saved_recovery_code").unlockedAt,null);
  ok(identities.activateDevRecoveryCode(owner.token,replacement));
  const recovered = identities.redeemDevRecoveryCode(replacement,"retry-secret");
  assert.ok(recovered);
  assert.deepEqual(achievement(recovered,"saved_recovery_code"), {id:"saved_recovery_code",progress:1,target:1,unlockedAt:at});
  assert.equal(achievement(recovered,"linked_email").unlockedAt,null,"development accounts do not fake verified email");
});
