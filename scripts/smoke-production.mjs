import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:https";

// Creates disposable profiles ONLY in the CI Compose stack, never a live deployment.
assert.equal(process.env.CI, "true", "Run only against the isolated CI stack");
const origin = "https://localhost";
async function api(method, path, { cookie, body, expected = 200, key = randomUUID(), source = origin } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const result = await new Promise((resolve, reject) => {
    const headers = { Origin: source, "Idempotency-Key": key };
    if (cookie) headers.Cookie = cookie;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = request(new URL(path, origin), {
      method, headers, rejectUnauthorized: false, timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({
        status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Isolated API timeout")));
    req.end(payload);
  });
  assert.equal(result.status, expected, method + " " + path + " returned " + result.status);
  let data = null;
  if (result.text && result.headers["content-type"]?.includes("application/json")) data = JSON.parse(result.text);
  return { ...result, data, cookie: result.headers["set-cookie"]?.[0]?.split(";")[0] };
}
async function profile(name) {
  const result = await api("POST", "/api/v1/bootstrap", { body: { displayName: name }, expected: 201 });
  const header = result.headers["set-cookie"]?.[0] ?? "";
  for (const flag of ["__Host-zhiv_session=", "HttpOnly", "Secure", "SameSite=Lax"]) {
    assert.ok(header.includes(flag), "Missing cookie protection: " + flag);
  }
  return result;
}
const owner = await profile("CI owner");
const friend = await profile("CI friend");
const sent = await api("POST", "/api/v1/direct-requests", {
  cookie: owner.cookie, body: { publicId: friend.data.user.publicId }, expected: 201,
});
const accepted = await api("POST", "/api/v1/direct-requests/" + sent.data.request.requestId + "/accept", { cookie: friend.cookie });
const circle = accepted.data.person.circleId;
const created = await api("POST", "/api/v1/groups", {
  cookie: owner.cookie, body: { title: "CI family", inviteeCircleIds: [circle] }, expected: 201,
});
const group = created.data.groupId;
const invitations = await api("GET", "/api/v1/groups", { cookie: friend.cookie });
await api("POST", "/api/v1/group-invites/" + invitations.data.incomingInvites[0].inviteId + "/accept", { cookie: friend.cookie });
const calendarKey = randomUUID();
const checkIn = await api("POST", "/api/v1/check-ins", { cookie: owner.cookie, key: calendarKey });
await api("POST", "/api/v1/check-ins", { cookie: owner.cookie, key: calendarKey });
await api("GET", "/api/v1/me/calendar", { expected: 401 });
const calendar = await api("GET", "/api/v1/me/calendar", { cookie: owner.cookie });
assert.equal(calendar.headers["cache-control"], "no-store");
assert.equal(calendar.data.days.reduce((sum, day) => sum + day.count, 0), 1);
const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: calendar.data.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(checkIn.data.checkedAt));
assert.equal(calendar.data.days[0].date, localDay);
assert.deepEqual((await api("GET", "/api/v1/me/calendar", { cookie: friend.cookie })).data.days, []);
const marked = await api("GET", "/api/v1/me", { cookie: owner.cookie });
// Timezone writes and reusable receipts must work with the restricted production role.
const timeZoneKey = randomUUID();
const moved = await api("PATCH", "/api/v1/me/time-zone", { cookie: owner.cookie, key: timeZoneKey, body: { timeZone: "Asia/Tokyo" } });
assert.equal(moved.data.profile.timeZone, "Asia/Tokyo");
assert.equal(moved.data.lastCheckInAt, marked.data.lastCheckInAt);
assert.deepEqual(moved.data.streak, marked.data.streak);
await api("PATCH", "/api/v1/me/time-zone", { cookie: owner.cookie, key: timeZoneKey, body: { timeZone: "UTC" }, expected: 409 });
await api("PATCH", "/api/v1/me/time-zone", { cookie: owner.cookie, body: { timeZone: "+03:00" }, expected: 400 });
const localCalendar = await api("GET", "/api/v1/me/calendar?month=" + localDay.slice(0, 7), { cookie: owner.cookie });
assert.equal(localCalendar.data.days[0].date, localDay);
assert.ok(Date.parse(localCalendar.data.nextDayAt) > Date.parse(localCalendar.data.serverTime));
const guestA = await profile("CI invite A"), guestB = await profile("CI invite B");
const multiToken = randomBytes(32).toString("base64url");
await api("POST", "/api/v1/direct-invite-links", { cookie: owner.cookie, body: { token: multiToken }, expected: 201 });
const receiptKey = randomUUID();
const guestOne = await api("POST", "/api/v1/direct-invite-links/redeem", { cookie: guestA.cookie, key: receiptKey, body: { token: multiToken } });
const guestTwo = await api("POST", "/api/v1/direct-invite-links/redeem", { cookie: guestB.cookie, body: { token: multiToken } });
assert.notEqual(guestOne.data.person.circleId, guestTwo.data.person.circleId);
assert.equal(guestOne.data.person.lastCheckInAt, null);
assert.equal(guestTwo.data.person.lastCheckInAt, null);
assert.equal((await api("POST", "/api/v1/direct-invite-links/redeem", { cookie: guestA.cookie, key: receiptKey, body: { token: multiToken } })).data.replayed, true);
await api("DELETE", "/api/v1/people/" + guestOne.data.person.circleId, { cookie: owner.cookie, expected: 204 });
await api("POST", "/api/v1/direct-invite-links/redeem", { cookie: guestA.cookie, key: receiptKey, body: { token: multiToken }, expected: 409 });
await api("DELETE", "/api/v1/people/" + guestTwo.data.person.circleId, { cookie: owner.cookie, expected: 204 });

// World enrollment, commands and ledger writes use the restricted runtime role.
await api("GET", "/api/v1/world", { expected: 401 });
const worldBefore = await api("GET", "/api/v1/world", { cookie: owner.cookie });
assert.equal(worldBefore.headers["cache-control"], "no-store");
assert.deepEqual(worldBefore.data.state.resources, { sparks: 0, wood: 0, stone: 0 });
const deniedDevGrant = await api("POST", "/api/v1/world/commands", { cookie: owner.cookie, expected: 400,
  body: { requestId: randomUUID(), ownerPublicId: owner.data.user.publicId, expectedRevision: worldBefore.data.revision,
    action: "dev_grant_resources", target: "" } });
assert.equal(deniedDevGrant.data.code, "INVALID_WORLD_COMMAND");
const afterDeniedGrant = await api("GET", "/api/v1/world", { cookie: owner.cookie });
assert.equal(afterDeniedGrant.data.revision, worldBefore.data.revision);
assert.deepEqual(afterDeniedGrant.data.state, worldBefore.data.state);
const outfit = { requestId: randomUUID(), ownerPublicId: owner.data.user.publicId, expectedRevision: worldBefore.data.revision, action: "equip", target: "amber_scarf" };
const equipped = await api("POST", "/api/v1/world/commands", { cookie: owner.cookie, body: outfit });
assert.equal(equipped.data.snapshot.state.equipment.neck, "amber_scarf");
assert.equal((await api("POST", "/api/v1/world/commands", { cookie: owner.cookie, body: outfit })).data.replayed, true);
await api("POST", "/api/v1/world/commands", { cookie: friend.cookie, body: outfit, expected: 409 });
await api("POST", "/api/v1/world/commands", { cookie: owner.cookie, body: { ...outfit, requestId: randomUUID() }, source: "https://untrusted.example", expected: 403 });

// Cosmetic memory has independent revisions and requires grants on both V31 tables.
const forestPath = "/api/v1/world/forest-memory";
const forestOwner = owner.data.user.publicId;
const forestClientA = randomUUID(), forestClientB = randomUUID();
const forestReadPath = (clientId, publicId = forestOwner) => forestPath + "?" + new URLSearchParams({
  expectedOwnerPublicId: publicId, clientId,
});
const forestCommand = (clientId, expectedRevision, action, fields = {}) => ({
  ownerPublicId: forestOwner, clientId, requestId: randomUUID(), expectedRevision, action, ...fields,
});
const forestWrite = (body, options = {}) => api("POST", forestPath + "/commands", { cookie: owner.cookie, body, ...options });
const forestSnapshot = {
  version: 1, sceneId: "ci-forest", fingerprint: "ci-geometry-v1",
  mind: { elapsed: 20, needs: { energy: 0.7, curiosity: 0.6, comfort: 0.8, attention: 0.4 },
    recent: [{ key: "grass-1-1", action: "look", outcome: "completed", at: 15, duration: 2 }], attentionUntil: 30 },
  hero: { position: { x: 100, y: 120 }, sleepingHome: false, awakeFor: 10, restFor: 0,
    recent: [{ id: "grass-1-1", activity: "look", age: 5 }] },
  mushrooms: [{ id: "ci-mushroom", position: { x: 130, y: 140 }, growth: 0.6, regrowIn: 8 }],
};
await api("GET", forestReadPath(forestClientA), { expected: 401 });
const forestBefore = await api("GET", forestReadPath(forestClientA), { cookie: owner.cookie });
assert.equal(forestBefore.headers["cache-control"], "no-store");
assert.equal(forestBefore.data.ownerPublicId, forestOwner);
assert.equal(forestBefore.data.revision, 0);
assert.equal(forestBefore.data.snapshot, null);
assert.deepEqual(forestBefore.data.lease, { owned: false, expiresAt: null, token: null });
assert.equal((await api("GET", forestReadPath(forestClientA), { cookie: friend.cookie, expected: 409 })).data.code,
  "FOREST_MEMORY_ACCOUNT_CHANGED");
const forestAcquireA = forestCommand(forestClientA, 0, "acquire");
await forestWrite(forestAcquireA, { cookie: undefined, expected: 401 });
await forestWrite(forestAcquireA, { source: "https://untrusted.invalid", expected: 403 });
assert.equal((await forestWrite(forestAcquireA, { cookie: friend.cookie, expected: 409 })).data.code,
  "FOREST_MEMORY_ACCOUNT_CHANGED");
const forestLeaseA = (await forestWrite(forestAcquireA)).data;
assert.equal(forestLeaseA.acceptedRevision, 1);
assert.equal(forestLeaseA.state.lease.owned, true);
assert.ok(forestLeaseA.state.lease.token);
const forestSaveA = forestCommand(forestClientA, 1, "save", {
  leaseToken: forestLeaseA.state.lease.token, snapshot: forestSnapshot,
});
const forestSavedA = await forestWrite(forestSaveA);
assert.equal(forestSavedA.headers["cache-control"], "no-store");
assert.equal(forestSavedA.data.acceptedRevision, 2);
assert.deepEqual(forestSavedA.data.state.snapshot, forestSnapshot);
const forestReplayA = (await forestWrite(forestSaveA)).data;
assert.equal(forestReplayA.replayed, true);
assert.equal(forestReplayA.acceptedRevision, 2);
assert.equal(forestReplayA.state.revision, 2);
assert.equal(forestReplayA.state.lease.expiresAt, forestSavedA.data.state.lease.expiresAt);
assert.equal((await forestWrite({ ...forestSaveA, snapshot: { ...forestSnapshot, fingerprint: "changed" } }, { expected: 409 })).data.code,
  "FOREST_MEMORY_REQUEST_CONFLICT");
assert.equal((await forestWrite({ ...forestSaveA, requestId: randomUUID() }, { expected: 409 })).data.code,
  "FOREST_MEMORY_REVISION_CONFLICT");
await forestWrite({ ...forestSaveA, requestId: randomUUID(), expectedRevision: 2,
  snapshot: { ...forestSnapshot, resources: { sparks: 999999 } } }, { expected: 400 });
const forestAcquireB = forestCommand(forestClientB, 2, "acquire");
assert.equal((await forestWrite(forestAcquireB, { expected: 409 })).data.code, "FOREST_MEMORY_ACTIVE_ELSEWHERE");
const forestLeaseB = (await forestWrite({ ...forestAcquireB, requestId: randomUUID(), takeover: true })).data;
assert.equal(forestLeaseB.state.revision, 3);
assert.equal(forestLeaseB.state.lease.owned, true);
assert.notEqual(forestLeaseB.state.lease.token, forestLeaseA.state.lease.token);
assert.deepEqual(forestLeaseB.state.snapshot, forestSnapshot);
const forestOldReader = (await api("GET", forestReadPath(forestClientA), { cookie: owner.cookie })).data;
assert.equal(forestOldReader.lease.owned, false);
assert.equal(forestOldReader.lease.token, null);
assert.deepEqual(forestOldReader.snapshot, forestSnapshot);
assert.equal((await forestWrite({ ...forestSaveA, requestId: randomUUID(), expectedRevision: 3 }, { expected: 409 })).data.code,
  "FOREST_MEMORY_LEASE_LOST");
const forestDelayedReplay = (await forestWrite(forestSaveA)).data;
assert.equal(forestDelayedReplay.replayed, true);
assert.equal(forestDelayedReplay.acceptedRevision, 2);
assert.equal(forestDelayedReplay.state.revision, 3);
assert.equal(forestDelayedReplay.state.lease.owned, false);
assert.equal(forestDelayedReplay.state.lease.token, null);
const forestSnapshotB = { ...forestSnapshot, mind: { ...forestSnapshot.mind,
  needs: { ...forestSnapshot.mind.needs, energy: 0.9 } } };
const forestSavedB = (await forestWrite(forestCommand(forestClientB, 3, "save", {
  leaseToken: forestLeaseB.state.lease.token, snapshot: forestSnapshotB,
}))).data;
assert.equal(forestSavedB.state.revision, 4);
const forestReleased = (await forestWrite(forestCommand(forestClientB, 4, "release", {
  leaseToken: forestLeaseB.state.lease.token,
}))).data;
assert.equal(forestReleased.state.revision, 5);
assert.deepEqual(forestReleased.state.lease, { owned: false, expiresAt: null, token: null });
assert.deepEqual(forestReleased.state.snapshot, forestSnapshotB);
assert.equal((await forestWrite(forestCommand(forestClientB, 5, "save", {
  leaseToken: forestLeaseB.state.lease.token, snapshot: forestSnapshot,
}), { expected: 409 })).data.code, "FOREST_MEMORY_LEASE_LOST");
const worldAfterForest = (await api("GET", "/api/v1/world", { cookie: owner.cookie })).data;
assert.equal(worldAfterForest.revision, equipped.data.snapshot.revision);
assert.deepEqual(worldAfterForest.state, equipped.data.snapshot.state);

// The online game has a separate score and must work under the runtime DB role.
await api("GET", "/api/v1/game/progress", { expected: 401 });
const gameBefore = await api("GET", "/api/v1/game/progress", { cookie: owner.cookie });
assert.equal(gameBefore.data.lifetimeTaps, 0);
assert.equal(gameBefore.data.leaderboardOptIn, false);
const gameRequest = { ownerPublicId: owner.data.user.publicId, requestId: randomUUID() };
const gameSession = await api("POST", "/api/v1/game/sessions", { cookie: owner.cookie, body: gameRequest });
assert.equal((await api("POST", "/api/v1/game/sessions", { cookie: owner.cookie, body: gameRequest })).data.sessionId, gameSession.data.sessionId);
const gameBatch = { sessionId: gameSession.data.sessionId, sequence: 1, tapCount: 7, runId: randomUUID() };
const gameScore = await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: gameBatch });
assert.equal(gameScore.data.acceptedTaps, 7);
assert.equal(gameScore.data.runTaps, 7);
assert.equal(gameScore.data.progress.lifetimeTaps, 7);
assert.equal(gameScore.data.progress.bestSeries, 7);
assert.equal(gameScore.data.progress.month, gameScore.data.progress.serverTime.slice(0, 7));
const gameReplay = await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: gameBatch });
assert.equal(gameReplay.data.replayed, true);
assert.equal(gameReplay.data.runTaps, 7);
const worldEarned = await api("GET", "/api/v1/world", { cookie: owner.cookie });
assert.equal(worldEarned.data.state.resources.sparks, 1);
const travel = { requestId: randomUUID(), ownerPublicId: owner.data.user.publicId, expectedRevision: worldEarned.data.revision, action: "start_journey", target: "first_path" };
const travelling = await api("POST", "/api/v1/world/commands", { cookie: owner.cookie, body: travel });
assert.equal(travelling.data.snapshot.state.journeys.length, 1);
assert.equal((await api("POST", "/api/v1/world/commands", { cookie: owner.cookie, body: travel })).data.replayed, true);
assert.equal(gameReplay.data.progress.lifetimeTaps, 7);
await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: { ...gameBatch, tapCount: 8 }, expected: 409 });
await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: { ...gameBatch, sequence: 2, lifetimeTaps: 999999 }, expected: 400 });
assert.deepEqual((await api("GET", "/api/v1/game/leaderboard", { cookie: friend.cookie })).data.entries, []);
const gameVisible = await api("PATCH", "/api/v1/game/visibility", { cookie: owner.cookie,
  body: { ownerPublicId: owner.data.user.publicId, leaderboardOptIn: true, expectedVersion: 0 } });
const gameBoard = await api("GET", "/api/v1/game/leaderboard", { cookie: friend.cookie });
assert.equal(gameBoard.headers["cache-control"], "no-store");
assert.equal(gameBoard.data.entries[0].taps, 7);
assert.deepEqual(Object.keys(gameBoard.data.entries[0]).sort(), ["displayName", "isMe", "rank", "score", "tag", "taps"]);
assert.equal(gameBoard.data.entries[0].tag, null);
assert.equal(gameBoard.data.scope, "global");
const seriesBoard = await api("GET", "/api/v1/game/leaderboard?metric=best_series", { cookie: owner.cookie });
assert.equal(seriesBoard.data.metric, "best_series");
assert.equal(seriesBoard.data.entries[0].score, 7);
assert.equal(seriesBoard.data.myRank, 1);
const friendBoard = await api("GET", "/api/v1/game/leaderboard?scope=friends", { cookie: friend.cookie });
assert.equal(friendBoard.data.scope, "friends");
assert.equal(friendBoard.data.entries[0].displayName, owner.data.user.displayName);
assert.equal(friendBoard.data.entries[0].rank, 1);
assert.deepEqual((await api("GET", "/api/v1/game/leaderboard?scope=friends", { cookie: guestA.cookie })).data.entries, []);
await api("GET", "/api/v1/game/leaderboard?scope=invalid", { cookie: owner.cookie, expected: 400 });
await api("GET", "/api/v1/game/leaderboard?scope=global&scope=friends", { cookie: owner.cookie, expected: 400 });
await api("PATCH", "/api/v1/game/visibility", { cookie: owner.cookie,
  body: { ownerPublicId: owner.data.user.publicId, leaderboardOptIn: false, expectedVersion: gameVisible.data.visibilityVersion } });
await api("PATCH", "/api/v1/game/visibility", { cookie: owner.cookie,
  body: { ownerPublicId: owner.data.user.publicId, leaderboardOptIn: true, expectedVersion: 0 }, expected: 409 });
assert.deepEqual((await api("GET", "/api/v1/game/leaderboard", { cookie: friend.cookie })).data.entries, []);
assert.deepEqual((await api("GET", "/api/v1/game/leaderboard?scope=friends", { cookie: friend.cookie })).data.entries, []);
assert.equal((await api("GET", "/api/v1/me", { cookie: owner.cookie })).data.checkInCount, marked.data.checkInCount);
await api("GET", "/api/v1/game/achievements", { expected: 401 });
const achievements = await api("GET", "/api/v1/game/achievements?catalog=3", { cookie: owner.cookie });
assert.equal(achievements.headers["cache-control"], "no-store");
assert.equal(achievements.data.ownerPublicId, owner.data.user.publicId);
assert.deepEqual(achievements.data.achievements.map(item => [item.id, item.progress, item.target, item.unlockedAt]), [
  ["seven_day_streak", 1, 7, null], ["thousand_taps", 7, 1000, null], ["five_friends", 1, 5, null],
  ["ten_thousand_series", 7, 10000, null], ["linked_email", 0, 1, null], ["saved_recovery_code", 0, 1, null],
]);

await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, body: { text: "гуляю" } });
const people = () => api("GET", "/api/v1/people", { cookie: friend.cookie });
assert.equal((await people()).data.people[0].status.text, "гуляю");
await api("PATCH", "/api/v1/groups/" + group + "/sharing", { cookie: owner.cookie, body: { sharingMode: "OFF" } });
const hidden = (await people()).data.people[0];
assert.equal(hidden.theirSharingMode, "OFF");
assert.equal(hidden.status, null);
assert.equal(hidden.lastCheckInAt, null);
await api("PATCH", "/api/v1/people/" + circle + "/sharing", { cookie: owner.cookie, body: { sharingMode: "LATEST_ONLY" } });
assert.equal((await people()).data.people[0].status, null);
await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, body: { text: "дома" } });
assert.equal((await people()).data.people[0].status.text, "дома");
const unchanged = await api("GET", "/api/v1/me", { cookie: owner.cookie });
assert.equal(unchanged.data.checkInCount, marked.data.checkInCount);
assert.equal(unchanged.data.lastCheckInAt, marked.data.lastCheckInAt);
await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, source: "https://untrusted.invalid", body: { text: "no" }, expected: 403 });

// Optional lifetime and private favorites use the production DTOs and restricted DB role.
const timedKey = randomUUID();
const timed = await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, key: timedKey, body: { text: "Гуляю", expiresInMinutes: 120 } });
assert.equal(Date.parse(timed.data.status.expiresAt) - Date.parse(timed.data.status.updatedAt), 7_200_000);
const timedRetry = await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, key: timedKey, body: { text: "Гуляю", expiresInMinutes: 120 } });
assert.deepEqual(timedRetry.data.status, timed.data.status);
await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, key: timedKey, body: { text: "Гуляю", expiresInMinutes: 60 }, expected: 409 });
for (const expiresInMinutes of [0, -1, 60.5, "120", true, {}, [], 1441]) {
  await api("PUT", "/api/v1/me/status", { cookie: owner.cookie, body: { text: "Гуляю", expiresInMinutes }, expected: 400 });
}
assert.deepEqual((await api("GET", "/api/v1/me", { cookie: owner.cookie })).data.status, timed.data.status);
assert.deepEqual((await people()).data.people[0].status, timed.data.status);
await api("PATCH", "/api/v1/people/" + circle + "/favorite", { cookie: owner.cookie, body: { isFavorite: true } });
assert.equal((await api("GET", "/api/v1/people", { cookie: owner.cookie })).data.people[0].isFavorite, true);
assert.equal((await people()).data.people[0].isFavorite, false);
await api("PATCH", "/api/v1/people/" + circle + "/favorite", { cookie: owner.cookie, body: { isFavorite: false } });
assert.equal((await api("GET", "/api/v1/people", { cookie: owner.cookie })).data.people[0].isFavorite, false);
for (const isFavorite of ["yes", "true", "false", 1, null, {}, []]) {
  await api("PATCH", "/api/v1/people/" + circle + "/favorite", { cookie: owner.cookie, body: { isFavorite }, expected: 400 });
}
assert.equal((await api("GET", "/api/v1/people", { cookie: owner.cookie })).data.people[0].isFavorite, false);

// Private nickname: exercise the HTTP boundary and migrated runtime-role grants.
const nicknamePath = "/api/v1/people/" + circle + "/nickname";
const named = await api("PATCH", nicknamePath, { cookie: owner.cookie, body: { nickname: "  Мама  💚 " } });
assert.equal(named.data.nickname, "Мама 💚");
assert.equal(named.headers["cache-control"], "no-store");
const ownerPeople = () => api("GET", "/api/v1/people", { cookie: owner.cookie });
assert.equal((await ownerPeople()).data.people[0].nickname, "Мама 💚");
assert.equal((await ownerPeople()).data.people[0].user.displayName, "CI friend");
assert.equal((await people()).data.people[0].nickname, null);
for (const nickname of [1, true, null, {}, [], "x".repeat(51), "a\nb", "x\u202ey"]) {
  await api("PATCH", nicknamePath, { cookie: owner.cookie, body: { nickname }, expected: 400 });
}
await api("PATCH", nicknamePath, { cookie: owner.cookie, body: { nickname: "ok", extra: true }, expected: 400 });
await api("PATCH", nicknamePath, { body: { nickname: "no" }, expected: 401 });
await api("PATCH", nicknamePath, { cookie: owner.cookie, source: "https://untrusted.invalid", body: { nickname: "no" }, expected: 403 });
await api("PATCH", "/api/v1/people/not-a-uuid/nickname", { cookie: owner.cookie, body: { nickname: "no" }, expected: 400 });
await api("PATCH", nicknamePath, { cookie: owner.cookie, body: { nickname: "" } });
assert.equal((await ownerPeople()).data.people[0].nickname, null);

const code = "ZHIV-R1-" + randomBytes(32).toString("base64url");
const retrySecret = randomBytes(32).toString("base64url");
await api("PUT", "/api/v1/recovery-code", { cookie: owner.cookie, body: { code } });
const restored = await api("POST", "/api/v1/recovery-code/redeem", { body: { code, retrySecret } });
assert.equal(restored.data.user.publicId, owner.data.user.publicId);
assert.ok(restored.cookie, "Restored session missing");
await api("GET", "/api/v1/me", { cookie: owner.cookie, expected: 401 });
await api("GET", forestReadPath(forestClientA), { cookie: owner.cookie, expected: 401 });
const recoveredForest = (await api("GET", forestReadPath(randomUUID()), { cookie: restored.cookie })).data;
assert.deepEqual(recoveredForest.snapshot, forestSnapshotB, "Account recovery must preserve the last forest snapshot");
assert.equal(recoveredForest.lease.owned, false);
assert.equal(recoveredForest.lease.token, null);
const replay = await api("POST", "/api/v1/recovery-code/redeem", { body: { code, retrySecret } });
assert.ok(replay.cookie === restored.cookie, "Lost response must return the same session");
await api("POST", "/api/v1/recovery-code/redeem", {
  body: { code, retrySecret: randomBytes(32).toString("base64url") }, expected: 401,
});
assert.equal((await api("GET", "/api/v1/recovery-code", { cookie: restored.cookie })).data.active, false);
await api("PUT", "/api/v1/recovery-code", { cookie: restored.cookie, body: { code }, expected: 409 });
// These writes specifically exercise the restricted runtime DB role after friend recovery retirement.
await api("DELETE", "/api/v1/people/" + circle, { cookie: restored.cookie, expected: 204 });
await api("DELETE", "/api/v1/groups/" + group, { cookie: restored.cookie, expected: 204 });
await api("POST", "/api/v1/account-recovery/attempts", { expected: 404 });
console.log("Production smoke passed: secure cookies, relations/groups, privacy/status/nicknames, forest memory/leases/replays, code recovery, revocation, retirement.");
