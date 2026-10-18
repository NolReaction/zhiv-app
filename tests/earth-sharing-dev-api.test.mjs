import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), originalMode = process.env.NODE_ENV;
const cookieModule = "\0earth-sharing-dev-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-sharing-dev-cookie", resolveId(id) { if (id === cookieModule) return id; }, load(id) {
    if (id === cookieModule) return "export async function cookies() { if(globalThis.__earthCookieFail) throw new Error('production read cookies'); return { get() { return { value: globalThis.__earthCookieToken }; } }; }";
  } }],
});
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const store = await vite.ssrLoadModule("/lib/dev/earth-sharing-store.ts");
const { devEarthSharingState } = await vite.ssrLoadModule("/lib/dev/earth-sharing-state.ts");
const contract = await vite.ssrLoadModule("/lib/earth-sharing-contract.ts");
const sharing = await vite.ssrLoadModule("/app/api/v1/earth/sharing/route.ts");
const location = await vite.ssrLoadModule("/app/api/v1/earth/location/route.ts");
const people = await vite.ssrLoadModule("/app/api/v1/earth/people/route.ts");
beforeEach(() => { process.env.NODE_ENV = "test"; identity.resetDevStoreForTests(); delete globalThis.__earthCookieToken; delete globalThis.__earthCookieFail; });
after(async () => {
  identity.resetDevStoreForTests();
  if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  delete globalThis.__earthCookieToken; delete globalThis.__earthCookieFail; await vite.close();
});
const uuid = () => crypto.randomUUID();
const player = (name = "Человек", bootstrap = uuid()) => identity.createDevIdentity(name, bootstrap);
function ok(result) { assert.equal(result.kind, "ok", JSON.stringify(result)); return result.value; }
function error(result, status, code) { assert.equal(result.kind, "error"); assert.equal(result.status, status); if (code) assert.equal(result.code, code); return result; }
function connect(a, b) {
  const request = ok(identity.sendDevDirectRequest(a.token, b.me.user.publicId, uuid()));
  return ok(identity.actOnDevDirectRequest(b.token, request.request.requestId, "ACCEPTED")).person.circleId;
}
function write(owner, circleIds, values = {}) {
  const settings = ok(store.getDevEarthSharing(owner.token));
  return { expectedOwnerPublicId: owner.me.user.publicId, expectedRevision: settings.revision, mode: "SHARING", precision: "APPROXIMATE",
    recipientCircleIds: circleIds, durationMinutes: 60, ...values };
}
function enable(owner, circleIds, values = {}) { return ok(store.putDevEarthSharing(owner.token, write(owner, circleIds, values))); }
function position(owner, settings, values = {}) {
  return { expectedOwnerPublicId: owner.me.user.publicId, publicationEpoch: settings.publicationEpoch, sequence: 1,
    latitude: 55.752345, longitude: 37.623123, accuracyMeters: 12, capturedAt: new Date().toISOString(), ...values };
}
function send(method, path, value, headers = {}) {
  return new Request(`http://localhost:3000/api/v1/earth/${path}`, { method,
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "Idempotency-Key": uuid(), ...headers },
    ...(value === undefined ? {} : { body: typeof value === "string" || value instanceof ReadableStream ? value : JSON.stringify(value) }),
    ...(value instanceof ReadableStream ? { duplex: "half" } : {}) });
}
async function status(response, expected, cache = "private, no-store") {
  assert.equal(response.status, expected); assert.equal(response.headers.get("cache-control"), cache); return response;
}

test("sharing defaults OFF and loading metadata never grants an epoch or starts a publisher", () => {
  const a = player();
  const first = contract.earthSharingSettingsSchema.parse(ok(store.getDevEarthSharing(a.token)));
  assert.equal(first.mode, "OFF"); assert.equal(first.precision, "APPROXIMATE"); assert.equal(first.revision, 0);
  assert.equal(first.publicationEpoch, null); assert.deepEqual(first.recipientCircleIds, []);
  assert.deepEqual(ok(store.getDevEarthPeople(a.token)).people, []);
  error(store.getDevEarthSharing(undefined), 401, "UNAUTHORIZED");
  assert.equal(devEarthSharingState().cleanup, null);
});

test("explicit DIRECT permission is independent of check-in visibility and never grants outsiders or unselected friends", () => {
  const a = player("А"), b = player("Б"), c = player("В"), outsider = player("Чужой");
  const ab = connect(a, b); connect(a, c);
  ok(identity.updateDevSharing(a.token, ab, "OFF"));
  const settings = enable(a, [ab]);
  assert.equal(ok(store.getDevEarthSharing(a.token)).publicationEpoch, null);
  ok(store.putDevEarthPosition(a.token, position(a, settings)));
  const visible = contract.earthPeopleResponseSchema.parse(ok(store.getDevEarthPeople(b.token)));
  assert.equal(visible.people.length, 1); assert.equal(visible.people[0].user.publicId, a.me.user.publicId);
  assert.equal(visible.people[0].latitude, 55.75); assert.equal(visible.people[0].longitude, 37.62); assert.equal(visible.people[0].accuracyMeters, 1500);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []); assert.deepEqual(ok(store.getDevEarthPeople(outsider.token)).people, []);
  assert.equal(ok(store.getDevEarthSharing(b.token)).mode, "OFF", "viewing never forces reciprocity");
  assert.deepEqual(Object.keys(visible.people[0]).sort(), ["circleId", "user", "latitude", "longitude", "accuracyMeters", "precision", "updatedAt", "expiresAt"].sort());
});

test("group membership and a foreign circle never substitute for direct opt-in", () => {
  const a = player(), b = player(), c = player(); const ab = connect(a, b), bc = connect(b, c);
  const group = ok(identity.createDevGroup(a.token, "Группа", null, [ab], uuid())).groupId;
  error(store.putDevEarthSharing(a.token, write(a, [group])), 400);
  error(store.putDevEarthSharing(a.token, write(a, [bc])), 400);
  error(store.putDevEarthSharing(a.token, write(a, [uuid()])), 400);
  assert.equal(ok(store.getDevEarthSharing(a.token)).mode, "OFF");
});

test("owner fences, CAS and session-bound epochs stop cross-account writes and old enable replay", () => {
  const bootstrap = uuid(), a = player("А", bootstrap), b = player("Б"); const circle = connect(a, b);
  const command = write(a, [circle]); const first = ok(store.putDevEarthSharing(a.token, command));
  error(store.putDevEarthSharing(a.token, command), 409, "EARTH_REVISION_CONFLICT");
  error(store.putDevEarthSharing(b.token, command), 409, "EARTH_OWNER_MISMATCH");
  const secondSession = player("А", bootstrap);
  assert.equal(ok(store.getDevEarthSharing(secondSession.token)).publicationEpoch, null);
  error(store.putDevEarthPosition(secondSession.token, position(a, first)), 409, "EARTH_PUBLICATION_CONFLICT");
  const second = enable(secondSession, [circle], { precision: "PRECISE" });
  assert.notEqual(second.publicationEpoch, first.publicationEpoch);
  error(store.putDevEarthPosition(a.token, position(a, first)), 409);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  ok(store.putDevEarthPosition(secondSession.token, position(a, second)));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people[0].latitude, 55.752345);
});

test("GHOST ignores stale CAS, stops publishing and preserves choices; OFF clears choices without notifying anyone", () => {
  const a = player(), b = player(), circle = connect(a, b); const shared = enable(a, [circle], { precision: "PRECISE" });
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  const ghost = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST", expectedRevision: 0, precision: "APPROXIMATE" })));
  assert.equal(ghost.mode, "GHOST"); assert.equal(ghost.precision, "PRECISE"); assert.deepEqual(ghost.recipientCircleIds, [circle]); assert.equal(ghost.publicationEpoch, null);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  error(store.putDevEarthPosition(a.token, position(a, shared)), 409);
  const off = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "OFF", expectedRevision: 0 })));
  assert.deepEqual(off.recipientCircleIds, []); assert.equal(off.mode, "OFF");
  assert.deepEqual(Object.keys(ok(store.getDevEarthPeople(b.token))).sort(), ["ownerPublicId", "people", "serverTime"]);
});

test("precision or audience edits rotate epochs and require a new fix; old scoped stops cannot erase a newer publisher", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), first = enable(a, [circle], { precision: "PRECISE" });
  ok(store.putDevEarthPosition(a.token, position(a, first)));
  const second = enable(a, [circle]);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  t.mock.timers.tick(30_000); ok(store.putDevEarthPosition(a.token, position(a, second)));
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: first.publicationEpoch }));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: second.publicationEpoch }));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  assert.equal(ok(store.getDevEarthSharing(a.token)).mode, "SHARING", "scoped stop pauses publisher without erasing consent");
  t.mock.timers.tick(30_000); error(store.putDevEarthPosition(a.token, position(a, second, { sequence: 2 })), 409);
});

test("fixes are fresh, increasing and single-use; identical fixes cannot heartbeat or renew expiry", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), shared = enable(a, [circle]);
  const first = position(a, shared), receipt = ok(store.putDevEarthPosition(a.token, first));
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.acceptedAt), 120_000);
  error(store.putDevEarthPosition(a.token, first), 409);
  error(store.putDevEarthPosition(a.token, { ...first, sequence: 2 }), 409);
  t.mock.timers.tick(30_000);
  for (const changed of [{ sequence: 1 }, { capturedAt: new Date(Date.now() - 60_001).toISOString() }, { capturedAt: new Date(Date.now() + 10_001).toISOString() }]) {
    assert.equal(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2, ...changed })).kind, "error");
  }
  const old = position(a, shared, { sequence: 2, capturedAt: new Date(Date.now() - 10_000).toISOString() });
  const accepted = ok(store.putDevEarthPosition(a.token, old));
  assert.equal(Date.parse(accepted.expiresAt), Date.parse(old.capturedAt) + 120_000);
  t.mock.timers.tick(110_000); assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
});

test("consent duration expires, ghost never resumes automatically, and revoked publisher sessions disappear immediately", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), shared = enable(a, [circle]);
  assert.equal(Date.parse(shared.sharingUntil) - Date.now(), 3_600_000);
  t.mock.timers.tick(3_600_000); error(store.putDevEarthPosition(a.token, position(a, shared)), 409);
  const fresh = enable(a, [circle], { durationMinutes: null }); ok(store.putDevEarthPosition(a.token, position(a, fresh)));
  const internal = globalThis.__zhivDevStore;
  internal.sessions.delete(a.token);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  error(store.putDevEarthPosition(a.token, position(a, fresh, { sequence: 2 })), 401);
});

test("ghost stays paused after every duration and a different session cannot issue a scoped stop for the current publisher", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const bootstrap = uuid(), a = player("А", bootstrap), b = player("Б"), circle = connect(a, b);
  const shared = enable(a, [circle], { durationMinutes: 480 });
  assert.equal(Date.parse(shared.sharingUntil) - Date.now(), 480 * 60_000);
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  const otherSession = player("А", bootstrap);
  ok(store.stopDevEarthPosition(otherSession.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: shared.publicationEpoch }));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
  ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" })));
  t.mock.timers.tick(24 * 3_600_000);
  assert.equal(ok(store.getDevEarthSharing(otherSession.token)).mode, "GHOST");
  assert.deepEqual(ok(store.getDevEarthSharing(otherSession.token)).recipientCircleIds, [circle]);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  error(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2 })), 409);
});

test("each feed is bounded to one hundred positions in stable order and response objects cannot change stored fixes", () => {
  const viewer = player("Зритель"); const circles = [];
  for (let index = 0; index < 101; index++) {
    const subject = player(`Человек ${index}`), circle = connect(subject, viewer), shared = enable(subject, [circle]);
    circles.push(circle); ok(store.putDevEarthPosition(subject.token, position(subject, shared)));
  }
  const first = ok(store.getDevEarthPeople(viewer.token));
  assert.equal(first.people.length, 100);
  assert.deepEqual(first.people.map(person => person.circleId), [...circles].sort().slice(0, 100));
  const savedLatitude = first.people[0].latitude;
  first.people[0].latitude = 89; first.people[0].user.displayName = "Подмена";
  const second = ok(store.getDevEarthPeople(viewer.token));
  assert.equal(second.people[0].latitude, savedLatitude); assert.notEqual(second.people[0].user.displayName, "Подмена");
  for (const record of devEarthSharingState().owners.values()) {
    if (record.position) assert.deepEqual(Object.keys(record.position).sort(), ["latitude", "longitude", "accuracyMeters", "updatedAt", "expiresAt"].sort());
  }
});

test("archiving a direct link removes both grants and re-adding never inherits location access", () => {
  const a = player(), b = player(), circle = connect(a, b);
  const sa = enable(a, [circle]), sb = enable(b, [circle]);
  ok(store.putDevEarthPosition(a.token, position(a, sa))); ok(store.putDevEarthPosition(b.token, position(b, sb)));
  ok(identity.removeDevPerson(a.token, circle));
  assert.deepEqual(ok(store.getDevEarthSharing(a.token)).recipientCircleIds, []);
  assert.deepEqual(ok(store.getDevEarthSharing(b.token)).recipientCircleIds, []);
  error(store.putDevEarthPosition(a.token, position(a, sa, { sequence: 2, capturedAt: new Date(Date.now() + 1).toISOString() })), 409);
  assert.deepEqual(ok(store.getDevEarthPeople(a.token)).people, []);
  const replacement = connect(a, b); assert.notEqual(replacement, circle);
  assert.deepEqual(ok(store.getDevEarthPeople(a.token)).people, []); assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
});

test("privacy commands bypass exhausted enable, read and GPS budgets", () => {
  const a = player(), b = player(), circle = connect(a, b);
  let shared;
  for (let index = 0; index < 10; index++) shared = enable(a, [circle]);
  error(store.putDevEarthSharing(a.token, write(a, [circle])), 429);
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  error(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2, capturedAt: new Date(Date.now() + 1).toISOString() })), 429);
  for (let index = 0; index < 600; index++) store.getDevEarthPeople(a.token);
  error(store.getDevEarthPeople(a.token), 429);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: shared.publicationEpoch }));
  ok(store.putDevEarthSharing(a.token, { expectedOwnerPublicId: a.me.user.publicId, expectedRevision: 0,
    mode: "GHOST", precision: "APPROXIMATE", recipientCircleIds: [], durationMinutes: null }));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
});

test("latest positions are physically removed on the bounded cleanup timer and account reset removes all geo state", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), shared = enable(a, [circle]);
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  const state = devEarthSharingState(); assert.ok(state.cleanup); assert.ok(state.owners.get(a.me.user.publicId).position);
  t.mock.timers.tick(120_000); assert.equal(state.owners.get(a.me.user.publicId).position, null); assert.equal(state.cleanup, null);
  identity.resetDevStoreForTests(); assert.equal(devEarthSharingState().owners.size, 0);
});

test("private geo routes require auth, owner, idempotency, JSON and exact body shapes", async () => {
  const a = player(), b = player(), circle = connect(a, b), body = write(a, [circle]);
  await status(await sharing.GET(send("GET", "sharing")), 401);
  globalThis.__earthCookieToken = a.token;
  const initial = await (await status(await sharing.GET(send("GET", "sharing")), 200)).json();
  assert.equal(initial.publicationEpoch, null);
  await status(await sharing.PUT(send("PUT", "sharing", body, { "Idempotency-Key": "invalid" })), 400);
  await status(await sharing.PUT(send("PUT", "sharing", body, { "Content-Type": "application/jsonp" })), 415);
  await status(await sharing.PUT(send("PUT", "sharing", { ...body, altitude: 1 })), 400);
  await status(await sharing.PUT(send("PUT", "sharing", { ...body, expectedOwnerPublicId: b.me.user.publicId })), 409);
  await status(await sharing.PUT(send("PUT", "sharing", body, { Origin: "https://evil.test" })), 403, "no-store");
  await status(await sharing.GET(send("GET", "sharing?latitude=55")), 400);
  const settings = await (await status(await sharing.PUT(send("PUT", "sharing", body)), 200)).json();
  const receipt = await (await status(await location.PUT(send("PUT", "location", position(a, settings))), 200)).json();
  contract.earthPositionReceiptSchema.parse(receipt); assert.equal("latitude" in receipt, false);
  globalThis.__earthCookieToken = b.token;
  contract.earthPeopleResponseSchema.parse(await (await status(await people.GET(send("GET", "people")), 200)).json());
});

test("actual streamed 8KiB limit, false Content-Length and malformed UTF-8 fail before any setting mutation", async () => {
  const a = player(), b = player(), circle = connect(a, b); globalThis.__earthCookieToken = a.token;
  let cancelled = false;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8192)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await status(await sharing.PUT(send("PUT", "sharing", oversized, { "Content-Length": "1" })), 413);
  assert.equal(cancelled, true); assert.equal(ok(store.getDevEarthSharing(a.token)).mode, "OFF");
  const invalidUtf8 = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
  await status(await sharing.PUT(send("PUT", "sharing", invalidUtf8)), 400);
  const valid = JSON.stringify(write(a, [circle])), encoder = new TextEncoder();
  const exact = encoder.encode(valid + " ".repeat(8192 - encoder.encode(valid).byteLength));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(exact.subarray(0, 200)); controller.enqueue(exact.subarray(200)); controller.close(); } });
  await status(await sharing.PUT(send("PUT", "sharing", stream)), 200);
});

test("all new geo route methods reject production before cookie access and never become public weather exceptions", async () => {
  process.env.NODE_ENV = "production"; globalThis.__earthCookieFail = true;
  for (const [route, method, path] of [[sharing, "GET", "sharing"], [sharing, "PUT", "sharing"], [location, "PUT", "location"], [location, "DELETE", "location"], [people, "GET", "people"]]) {
    const response = await status(await route[method](send(method, path, method === "GET" ? undefined : {})), 503, "no-store");
    assert.equal((await response.json()).code, "DEV_API_DISABLED");
  }
});


test("removing any recipient fences the publisher while preserving remaining choices until explicit reconfirmation", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player("А"), b = player("Б"), c = player("В");
  const ab = connect(a, b), ac = connect(a, c), shared = enable(a, [ab, ac], { precision: "PRECISE" });
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
  assert.equal(ok(store.getDevEarthPeople(c.token)).people.length, 1);
  ok(identity.removeDevPerson(a.token, ab));
  const paused = ok(store.getDevEarthSharing(a.token));
  assert.equal(paused.revision, shared.revision + 1);
  assert.deepEqual(paused.recipientCircleIds, [ac]); assert.equal(paused.precision, "PRECISE");
  assert.equal(paused.publicationEpoch, null);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, [], "remaining recipients cannot keep the pre-edit point");
  t.mock.timers.tick(30_000);
  error(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2 })), 409, "EARTH_PUBLICATION_CONFLICT");
  const confirmed = enable(a, [ac], { precision: "PRECISE" });
  assert.notEqual(confirmed.publicationEpoch, shared.publicationEpoch);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, [], "reconfirmation alone cannot revive an old fix");
  ok(store.putDevEarthPosition(a.token, position(a, confirmed)));
  assert.equal(ok(store.getDevEarthPeople(c.token)).people.length, 1);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
});
