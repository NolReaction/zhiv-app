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
assert.equal(gameScore.data.progress.lifetimeTaps, 7);
assert.equal(gameScore.data.progress.bestSeries, 7);
assert.equal(gameScore.data.progress.month, gameScore.data.progress.serverTime.slice(0, 7));
const gameReplay = await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: gameBatch });
assert.equal(gameReplay.data.replayed, true);
assert.equal(gameReplay.data.progress.lifetimeTaps, 7);
await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: { ...gameBatch, tapCount: 8 }, expected: 409 });
await api("POST", "/api/v1/game/batches", { cookie: owner.cookie, body: { ...gameBatch, sequence: 2, lifetimeTaps: 999999 }, expected: 400 });
assert.deepEqual((await api("GET", "/api/v1/game/leaderboard", { cookie: friend.cookie })).data.entries, []);
const gameVisible = await api("PATCH", "/api/v1/game/visibility", { cookie: owner.cookie,
  body: { ownerPublicId: owner.data.user.publicId, leaderboardOptIn: true, expectedVersion: 0 } });
const gameBoard = await api("GET", "/api/v1/game/leaderboard", { cookie: friend.cookie });
assert.equal(gameBoard.headers["cache-control"], "no-store");
assert.equal(gameBoard.data.entries[0].taps, 7);
assert.deepEqual(Object.keys(gameBoard.data.entries[0]).sort(), ["displayName", "isMe", "rank", "taps"]);
await api("PATCH", "/api/v1/game/visibility", { cookie: owner.cookie,
  body: { ownerPublicId: owner.data.user.publicId, leaderboardOptIn: false, expectedVersion: gameVisible.data.visibilityVersion } });
await api("PATCH", "/api/v1/game/visibility", { cookie: owner.cookie,
  body: { ownerPublicId: owner.data.user.publicId, leaderboardOptIn: true, expectedVersion: 0 }, expected: 409 });
assert.deepEqual((await api("GET", "/api/v1/game/leaderboard", { cookie: friend.cookie })).data.entries, []);
assert.equal((await api("GET", "/api/v1/me", { cookie: owner.cookie })).data.checkInCount, marked.data.checkInCount);

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
console.log("Production smoke passed: secure cookies, relations/groups, privacy/status/nicknames, code recovery, revocation, retirement.");
