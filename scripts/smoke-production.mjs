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
await api("POST", "/api/v1/check-ins", { cookie: owner.cookie });
const marked = await api("GET", "/api/v1/me", { cookie: owner.cookie });
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
console.log("Production smoke passed: secure cookies, relations/groups, privacy/status, code recovery, revocation, retirement.");
