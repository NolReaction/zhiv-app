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
const resumeRoute = await vite.ssrLoadModule("/app/api/v1/earth/sharing/resume/route.ts");
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
function resume(owner, settings, values = {}) {
  return store.resumeDevEarthSharing(owner.token, { expectedOwnerPublicId: owner.me.user.publicId,
    expectedRevision: settings.revision, ...values });
}
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
  assert.equal(first.mode, "OFF"); assert.equal(first.precision, "PRECISE"); assert.equal(first.revision, 0); assert.equal(first.sharingUntil, null);
  assert.equal(first.publicationEpoch, null); assert.deepEqual(first.recipientCircleIds, []);
  assert.deepEqual(ok(store.getDevEarthPeople(a.token)).people, []);
  error(store.getDevEarthSharing(undefined), 401, "UNAUTHORIZED");
  assert.equal(devEarthSharingState().cleanup, null);
});

test("first precise permanent consent still needs an explicitly selected friend", () => {
  const a = player(), b = player(), c = player(), ab = connect(a, b); connect(a, c);
  const defaults = ok(store.getDevEarthSharing(a.token));
  error(resume(a, defaults), 409, "EARTH_PUBLICATION_CONFLICT");
  const grant = enable(a, [ab], { precision: defaults.precision, durationMinutes: null });
  assert.equal(grant.sharingUntil, null); assert.equal(grant.precision, "PRECISE");
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people[0].latitude, 55.752345);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
});

test("publisher resume preserves exact consent deadline, precision, frozen recipients and last known points", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T12:00:00Z") });
  const bootstrap = uuid(), a = player("А", bootstrap), b = player(), c = player(), d = player();
  const ab = connect(a, b), ac = connect(a, c); connect(a, d);
  const grant = enable(a, [ab, ac]); ok(store.putDevEarthPosition(a.token, position(a, grant)));
  const frozen = ok(store.putDevEarthSharing(a.token, write(a, [ab, ac], { frozenOnly: true, frozenCircleIds: [ab] })));
  const before = ok(store.getDevEarthPeople(b.token)).people;
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: grant.publicationEpoch }));
  t.mock.timers.tick(10 * 60_000);
  const secondSession = player("А", bootstrap);
  const current = contract.earthSharingSettingsSchema.parse(ok(resume(secondSession, frozen)));
  assert.equal(current.revision, frozen.revision + 1); assert.notEqual(current.publicationEpoch, grant.publicationEpoch);
  assert.equal(current.sharingUntil, grant.sharingUntil); assert.equal(current.precision, "APPROXIMATE");
  assert.deepEqual(current.recipientCircleIds, frozen.recipientCircleIds); assert.deepEqual(current.frozenCircleIds, [ab]);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  assert.equal(ok(store.getDevEarthPeople(c.token)).people[0].updatedAt, before[0].updatedAt, "resume alone retains the original common point");
  assert.equal(ok(store.getDevEarthSharing(a.token)).publicationEpoch, null);
  error(resume(a, frozen), 409, "EARTH_REVISION_CONFLICT");
  error(store.resumeDevEarthSharing(b.token, { expectedOwnerPublicId: a.me.user.publicId, expectedRevision: current.revision }), 409, "EARTH_OWNER_MISMATCH");
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: grant.publicationEpoch }));
  error(store.putDevEarthPosition(a.token, position(a, current)), 409, "EARTH_PUBLICATION_CONFLICT");
  ok(store.putDevEarthPosition(secondSession.token, position(a, current, { latitude: 56.2345 })));
  assert.equal(ok(store.getDevEarthPeople(c.token)).people[0].latitude, 56.23);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  assert.deepEqual(ok(store.getDevEarthPeople(d.token)).people, []);
  assert.equal(ok(store.getDevEarthSharing(a.token)).sharingUntil, grant.sharingUntil);
});

test("resume cannot revive OFF or expired consent and GHOST needs an explicit action", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), grant = enable(a, [circle]);
  const ghost = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" })));
  error(resume(a, ghost), 409, "EARTH_PUBLICATION_CONFLICT");
  const resumed = ok(resume(a, ghost, { resumeGhost: true }));
  assert.equal(resumed.mode, "SHARING"); assert.ok(resumed.publicationEpoch);
  assert.equal(resumed.sharingUntil, grant.sharingUntil); assert.equal(resumed.precision, grant.precision);
  const off = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "OFF" })));
  error(resume(a, resumed), 409, "EARTH_PUBLICATION_CONFLICT");
  error(resume(a, off, { resumeGhost: true }), 409, "EARTH_PUBLICATION_CONFLICT");
  const finite = enable(a, [circle]); t.mock.timers.tick(60 * 60_000);
  error(resume(a, finite, { resumeGhost: true }), 409, "EARTH_PUBLICATION_CONFLICT");
});

test("all frozen recipients cannot acquire a publisher while explicit ghost exit retains their snapshots", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), grant = enable(a, [circle]);
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  const frozen = ok(store.putDevEarthSharing(a.token, write(a, [circle], { frozenOnly: true, frozenCircleIds: [circle] })));
  const before = ok(store.getDevEarthPeople(b.token)).people;
  error(resume(a, frozen), 409, "EARTH_PUBLICATION_CONFLICT");
  const ghost = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" })));
  const resumed = ok(resume(a, ghost, { resumeGhost: true }));
  assert.equal(resumed.mode, "SHARING"); assert.equal(resumed.publicationEpoch, null);
  assert.deepEqual(resumed.frozenCircleIds, [circle]); assert.equal(resumed.sharingUntil, grant.sharingUntil);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  error(resume(a, resumed), 409, "EARTH_PUBLICATION_CONFLICT");
});

test("adding a friend preserves exact finite consent without treating a legacy duration hint as renewal", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c), grant = enable(a, [ab]);
  ok(store.putDevEarthPosition(a.token, position(a, grant))); t.mock.timers.tick(10 * 60_000);
  const added = enable(a, [ab, ac], { preserveSharingUntil: true, durationMinutes: 480 });
  assert.equal(added.sharingUntil, grant.sharingUntil); assert.equal(added.precision, grant.precision);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
  error(store.putDevEarthSharing(a.token, write(a, [ab, ac], { preserveSharingUntil: true, precision: "PRECISE" })), 400, "INVALID_EARTH_SHARING");
  error(store.putDevEarthSharing(a.token, write(a, [ab, ac], { preserveSharingUntil: true, durationMinutes: null })), 400, "INVALID_EARTH_SHARING");
  error(store.putDevEarthSharing(a.token, write(a, [ac], { preserveSharingUntil: true })), 400, "INVALID_EARTH_SHARING");
  t.mock.timers.tick(1); ok(store.putDevEarthPosition(a.token, position(a, added)));
  assert.equal(ok(store.getDevEarthPeople(c.token)).people[0].expiresAt, grant.sharingUntil);
  t.mock.timers.tick(50 * 60_000);
  error(store.putDevEarthSharing(a.token, { ...write(a, [ab, ac]), preserveSharingUntil: true }), 400, "INVALID_EARTH_SHARING");
});

test("adding during GHOST preserves its old point and hides that point from the new recipient until a fresh capture", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const grant = enable(a, [ab], { precision: "PRECISE", durationMinutes: null });
  ok(store.putDevEarthPosition(a.token, position(a, grant))); const before = ok(store.getDevEarthPeople(b.token)).people;
  ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" }))); t.mock.timers.tick(60_000);
  const added = enable(a, [ab, ac], { preserveSharingUntil: true, precision: "PRECISE", durationMinutes: null });
  assert.equal(added.mode, "GHOST"); assert.equal(added.publicationEpoch, null); assert.equal(added.sharingUntil, null);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before); assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
  const resumed = ok(resume(a, added, { resumeGhost: true }));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before); assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
  t.mock.timers.tick(1); ok(store.putDevEarthPosition(a.token, position(a, resumed)));
  assert.equal(ok(store.getDevEarthPeople(c.token)).people.length, 1);
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
  const before = ok(store.getDevEarthPeople(b.token)).people;
  const ghost = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST", expectedRevision: 0, precision: "APPROXIMATE" })));
  assert.equal(ghost.mode, "GHOST"); assert.equal(ghost.precision, "PRECISE"); assert.deepEqual(ghost.recipientCircleIds, [circle]); assert.equal(ghost.publicationEpoch, null);
  assert.equal(ghost.sharingUntil, shared.sharingUntil);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  error(store.putDevEarthPosition(a.token, position(a, shared)), 409);
  const off = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "OFF", expectedRevision: 0 })));
  assert.deepEqual(off.recipientCircleIds, []); assert.equal(off.mode, "OFF");
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  ok(store.putDevEarthSharing(a.token, write(a, [circle], { mode: "GHOST", durationMinutes: null })));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "OFF to GHOST cannot restore removed access or coordinates");
  assert.deepEqual(Object.keys(ok(store.getDevEarthPeople(b.token))).sort(), ["ownerPublicId", "people", "serverTime"]);
});

test("precision or audience edits rotate epochs and require a new fix; old scoped stops cannot erase a newer publisher", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), first = enable(a, [circle], { precision: "PRECISE" });
  ok(store.putDevEarthPosition(a.token, position(a, first)));
  const second = enable(a, [circle]);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  t.mock.timers.tick(1); ok(store.putDevEarthPosition(a.token, position(a, second)));
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: first.publicationEpoch }));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: second.publicationEpoch }));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1, "pause retains the last known point");
  assert.equal(ok(store.getDevEarthSharing(a.token)).mode, "SHARING", "scoped stop pauses publisher without erasing consent");
  t.mock.timers.tick(30_000); error(store.putDevEarthPosition(a.token, position(a, second, { sequence: 2 })), 409);
});

test("fixes are fresh, increasing and single-use; identical fixes cannot heartbeat or renew expiry", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), shared = enable(a, [circle], { durationMinutes: null });
  const first = position(a, shared), receipt = ok(store.putDevEarthPosition(a.token, first));
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.acceptedAt), 86_400_000);
  error(store.putDevEarthPosition(a.token, first), 409);
  error(store.putDevEarthPosition(a.token, { ...first, sequence: 2 }), 409);
  t.mock.timers.tick(30_000);
  for (const changed of [{ sequence: 1 }, { capturedAt: new Date(Date.now() - 60_001).toISOString() }, { capturedAt: new Date(Date.now() + 10_001).toISOString() }]) {
    assert.equal(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2, ...changed })).kind, "error");
  }
  const old = position(a, shared, { sequence: 2, capturedAt: new Date(Date.now() - 10_000).toISOString() });
  const accepted = ok(store.putDevEarthPosition(a.token, old));
  assert.equal(Date.parse(accepted.expiresAt), Date.parse(old.capturedAt) + 86_400_000);
  t.mock.timers.tick(86_390_000); assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
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

test("timed ghost consent expires and a different session cannot issue a scoped stop for the current publisher", t => {
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
  assert.equal(ok(store.getDevEarthSharing(otherSession.token)).mode, "OFF");
  assert.deepEqual(ok(store.getDevEarthSharing(otherSession.token)).recipientCircleIds, []);
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
  error(resume(a, shared), 429, "EARTH_RATE_LIMITED");
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  error(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2, capturedAt: new Date(Date.now() + 1).toISOString() })), 429);
  for (let index = 0; index < 1_800; index++) store.getDevEarthPeople(a.token);
  error(store.getDevEarthPeople(a.token), 429);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: shared.publicationEpoch }));
  ok(store.putDevEarthSharing(a.token, { expectedOwnerPublicId: a.me.user.publicId, expectedRevision: 0,
    mode: "GHOST", precision: "APPROXIMATE", recipientCircleIds: [], durationMinutes: null }));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1, "privacy pause keeps last known coordinates");
});

test("latest positions are physically removed on the bounded cleanup timer and account reset removes all geo state", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), shared = enable(a, [circle]);
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  const state = devEarthSharingState(); assert.ok(state.cleanup); assert.ok(state.owners.get(a.me.user.publicId).position);
  t.mock.timers.tick(3_600_000); assert.equal(state.owners.get(a.me.user.publicId).position, null); assert.equal(state.cleanup, null);
  identity.resetDevStoreForTests(); assert.equal(devEarthSharingState().owners.size, 0);
});

test("private geo routes require auth, owner, idempotency, JSON and exact body shapes", async () => {
  const a = player(), b = player(), circle = connect(a, b), body = write(a, [circle]);
  await status(await sharing.GET(send("GET", "sharing")), 401);
  await status(await resumeRoute.POST(send("POST", "sharing/resume", {})), 401);
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
  const resumeBody = { expectedOwnerPublicId: a.me.user.publicId, expectedRevision: settings.revision };
  await status(await resumeRoute.POST(send("POST", "sharing/resume", resumeBody, { "Idempotency-Key": "invalid" })), 400);
  await status(await resumeRoute.POST(send("POST", "sharing/resume", { ...resumeBody, durationMinutes: null })), 400);
  await status(await resumeRoute.POST(send("POST", "sharing/resume?latitude=55", resumeBody)), 400);
  const resumed = await (await status(await resumeRoute.POST(send("POST", "sharing/resume", resumeBody)), 200)).json();
  assert.equal(resumed.sharingUntil, settings.sharingUntil); contract.earthSharingSettingsSchema.parse(resumed);
  const receipt = await (await status(await location.PUT(send("PUT", "location", position(a, resumed))), 200)).json();
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
  for (const [route, method, path] of [[sharing, "GET", "sharing"], [sharing, "PUT", "sharing"], [resumeRoute, "POST", "sharing/resume"], [location, "PUT", "location"], [location, "DELETE", "location"], [people, "GET", "people"]]) {
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
  t.mock.timers.tick(1);
  error(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2 })), 409, "EARTH_PUBLICATION_CONFLICT");
  const confirmed = enable(a, [ac], { precision: "PRECISE" });
  assert.notEqual(confirmed.publicationEpoch, shared.publicationEpoch);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, [], "reconfirmation alone cannot revive an old fix");
  ok(store.putDevEarthPosition(a.token, position(a, confirmed)));
  assert.equal(ok(store.getDevEarthPeople(c.token)).people.length, 1);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
});


test("fresh publication epochs resume immediately after ghost and scoped stop while their own GPS cadence remains bounded", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b);
  const first = enable(a, [circle]);
  ok(store.putDevEarthPosition(a.token, position(a, first)));
  error(store.putDevEarthPosition(a.token, position(a, first, { sequence: 2, capturedAt: new Date(Date.now() + 1).toISOString() })), 429);
  ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" })));
  const resumed = enable(a, [circle]);
  t.mock.timers.tick(1);
  ok(store.putDevEarthPosition(a.token, position(a, resumed)));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
  error(store.putDevEarthPosition(a.token, position(a, first, { sequence: 2 })), 409, "EARTH_PUBLICATION_CONFLICT");
  error(store.putDevEarthPosition(a.token, position(a, resumed, { sequence: 2, capturedAt: new Date(Date.now() + 1).toISOString() })), 429);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: resumed.publicationEpoch }));
  const restarted = enable(a, [circle]);
  t.mock.timers.tick(1);
  ok(store.putDevEarthPosition(a.token, position(a, restarted)));
  error(store.putDevEarthPosition(a.token, position(a, restarted, { sequence: 2, capturedAt: new Date(Date.now() + 1).toISOString() })), 429);
  t.mock.timers.tick(30_000);
  ok(store.putDevEarthPosition(a.token, position(a, restarted, { sequence: 2 })));
});

test("last known points have one retention policy across GPS pause, offline and GHOST without a public mode flag", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const shared = enable(a, [ab], { durationMinutes: null, precision: "PRECISE" });
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "polling before the first fix cannot revoke its epoch");
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  const before = contract.earthPeopleResponseSchema.parse(ok(store.getDevEarthPeople(b.token))).people;
  assert.equal(contract.earthSharedPersonSchema.safeParse({ ...before[0], expiresAt: new Date(Date.parse(before[0].updatedAt) + 86_400_001).toISOString() }).success, false);
  assert.equal(Date.parse(before[0].expiresAt) - Date.parse(before[0].updatedAt), 86_400_000);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: shared.publicationEpoch }));
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  const command = write(a, [ac], { mode: "GHOST", expectedRevision: 0, durationMinutes: 480 });
  ok(store.putDevEarthSharing(a.token, command));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, [], "GHOST cannot add a recipient supplied in its body");
  t.mock.timers.tick(30_000); ok(store.putDevEarthSharing(a.token, command));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before, "replayed privacy writes do not extend retention or update fix time");
  error(store.putDevEarthPosition(a.token, position(a, shared, { sequence: 2 })), 409);
  t.mock.timers.tick(86_070_000);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "the original 24 hour deadline still expires");
});

test("GHOST preserves the original timed grant and never extends it with a requested duration", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), circle = connect(a, b), shared = enable(a, [circle]);
  ok(store.putDevEarthPosition(a.token, position(a, shared)));
  const before = ok(store.getDevEarthPeople(b.token)).people;
  assert.equal(before[0].expiresAt, shared.sharingUntil);
  t.mock.timers.tick(3_500_000);
  const frozen = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST", durationMinutes: null })));
  assert.equal(frozen.sharingUntil, shared.sharingUntil);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, before);
  t.mock.timers.tick(100_000);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  ok(store.putDevEarthSharing(a.token, write(a, [circle], { mode: "GHOST", durationMinutes: 480 })));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "expired access cannot be revived with GHOST");
});

test("a frozen point is revoked by friendship removal and by its original publisher session even when another session enables ghost", () => {
  for (const revoke of ["friend", "session"]) {
    identity.resetDevStoreForTests();
    const bootstrap = uuid(), a = player("А", bootstrap), b = player(), circle = connect(a, b), shared = enable(a, [circle]);
    ok(store.putDevEarthPosition(a.token, position(a, shared)));
    const other = player("А", bootstrap);
    ok(store.putDevEarthSharing(other.token, write(other, [], { mode: "GHOST" })));
    assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
    if (revoke === "friend") ok(identity.removeDevPerson(a.token, circle));
    else globalThis.__zhivDevStore.sessions.delete(a.token);
    assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
    assert.equal(devEarthSharingState().owners.get(a.me.user.publicId).position, null);
  }
});

function preferences(owner, recipients, frozen, changes = {}) {
  return ok(store.putDevEarthSharing(owner.token, write(owner, recipients, {
    frozenOnly: true, frozenCircleIds: frozen, durationMinutes: null, ...changes,
  })));
}

test("freeze preferences normalize old wire payloads and reject duplicates or recipients outside consent", () => {
  const a = player(), b = player(), circle = connect(a, b);
  assert.deepEqual(contract.earthSharingSettingsSchema.parse(ok(store.getDevEarthSharing(a.token))).frozenCircleIds, []);
  const legacy = ok(store.getDevEarthSharing(a.token)); delete legacy.frozenCircleIds;
  assert.deepEqual(contract.earthSharingSettingsSchema.parse(legacy).frozenCircleIds, []);
  for (const frozenCircleIds of [[circle, circle], [uuid()], ["invalid"]]) {
    error(store.putDevEarthSharing(a.token, write(a, [circle], { frozenCircleIds })), 400);
  }
  const granted = enable(a, [circle]);
  error(store.putDevEarthSharing(b.token, write(a, [circle], { frozenOnly: true, frozenCircleIds: [circle] })), 409, "EARTH_OWNER_MISMATCH");
  error(store.putDevEarthSharing(a.token, write(a, [circle], { frozenOnly: true, frozenCircleIds: [circle], expectedRevision: granted.revision - 1 })), 409);
});

test("one frozen recipient keeps the exact earlier point while another receives fresh live fixes without renewed consent", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const grant = enable(a, [ab, ac], { precision: "PRECISE" });
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  const before = ok(store.getDevEarthPeople(b.token)).people[0];
  t.mock.timers.tick(30_000);
  const frozen = preferences(a, [ab, ac], [ab], { precision: "APPROXIMATE", durationMinutes: null });
  assert.equal(frozen.sharingUntil, grant.sharingUntil); assert.equal(frozen.precision, "PRECISE");
  assert.equal(frozen.publicationEpoch, null); assert.deepEqual(frozen.frozenCircleIds, [ab]);
  const record = devEarthSharingState().owners.get(a.me.user.publicId);
  assert.equal(record.publicationEpoch, grant.publicationEpoch, "the active publisher lease and sequence survive a narrow change");
  ok(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 2, latitude: 56.123456 })));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people[0], before);
  const live = ok(store.getDevEarthPeople(c.token)).people[0];
  assert.equal(live.latitude, 56.123456); assert.notEqual(live.updatedAt, before.updatedAt);
  assert.equal(live.expiresAt, grant.sharingUntil, "live samples never extend the grant deadline");
  assert.equal("frozenCircleIds" in live, false); assert.equal("frozen" in live, false);
  t.mock.timers.tick(3_570_000);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []); assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
});

test("freeze before a first fix and unfreeze then freeze without a new fix cannot reveal a later common point", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const grant = enable(a, [ab, ac], { frozenCircleIds: [ab] });
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  assert.equal(ok(store.getDevEarthPeople(c.token)).people.length, 1);
  preferences(a, [ab, ac], []);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "unfreezing waits for a new sample instead of disclosing the existing common fix");
  preferences(a, [ab, ac], [ab]);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "refreezing cannot capture that prohibited common fix");
  preferences(a, [ab, ac], []);
  t.mock.timers.tick(30_000);
  ok(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 2, latitude: 56 })));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people[0].latitude, 56);
});

test("global ghost and explicit resume preserve individual snapshots, their original precision and their source session", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const bootstrap = uuid(), a = player("А", bootstrap), b = player(), c = player(), d = player();
  const ab = connect(a, b), ac = connect(a, c), ad = connect(a, d);
  const grant = enable(a, [ab, ac], { precision: "PRECISE", durationMinutes: null });
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  const original = ok(store.getDevEarthPeople(b.token)).people[0]; preferences(a, [ab, ac], [ab]);
  t.mock.timers.tick(30_000); ok(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 2, latitude: 56 })));
  const otherLast = ok(store.getDevEarthPeople(c.token)).people[0];
  const ghost = ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST", frozenOnly: true })));
  assert.deepEqual(ghost.frozenCircleIds, [ab]); assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people[0], original);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people[0], otherLast);
  const secondSession = player("А", bootstrap);
  const resumed = enable(secondSession, [ab, ac, ad], { frozenCircleIds: [ab, ad], precision: "APPROXIMATE", durationMinutes: null });
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people[0], original);
  assert.deepEqual(ok(store.getDevEarthPeople(d.token)).people, [], "a newly selected frozen friend never inherits a point already shared with others");
  t.mock.timers.tick(1); ok(store.putDevEarthPosition(secondSession.token, position(secondSession, resumed, { latitude: 57.123456 })));
  assert.equal(ok(store.getDevEarthPeople(c.token)).people[0].precision, "APPROXIMATE");
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people[0], original);
  globalThis.__zhivDevStore.sessions.delete(a.token);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "the original snapshot session still owns its revocation");
  assert.equal(ok(store.getDevEarthPeople(c.token)).people.length, 1, "the independent new publisher session remains live");
  assert.equal(devEarthSharingState().owners.get(a.me.user.publicId).frozenPositions.has(ab), false);
});

test("narrow audience revocation cannot add a friend, renew the deadline, restart a paused publisher or resurrect OFF", () => {
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const grant = enable(a, [ab, ac]); ok(store.putDevEarthPosition(a.token, position(a, grant)));
  preferences(a, [ab, ac], [ab]);
  ok(store.stopDevEarthPosition(a.token, { expectedOwnerPublicId: a.me.user.publicId, publicationEpoch: grant.publicationEpoch }));
  const changed = preferences(a, [ac], []);
  assert.equal(changed.sharingUntil, grant.sharingUntil); assert.deepEqual(changed.recipientCircleIds, [ac]);
  assert.equal(devEarthSharingState().owners.get(a.me.user.publicId).publicationEpoch, null);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  error(store.putDevEarthSharing(a.token, write(a, [ab, ac], { frozenOnly: true })), 400);
  const off = preferences(a, [], []); assert.equal(off.mode, "OFF"); assert.equal(off.sharingUntil, null);
  assert.deepEqual(off.frozenCircleIds, []); assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
  error(store.putDevEarthSharing(a.token, write(a, [ac], { frozenOnly: true })), 400);
  ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" })));
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
});

test("real HTTP preference writes are owner-only and keep public feed shape and the old deadline", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  globalThis.__earthCookieToken = a.token;
  const grant = await (await status(await sharing.PUT(send("PUT", "sharing", write(a, [ab, ac]))), 200)).json();
  await status(await location.PUT(send("PUT", "location", position(a, grant))), 200);
  const original = ok(store.getDevEarthPeople(b.token)).people[0];
  const update = write(a, [ab, ac], { frozenOnly: true, frozenCircleIds: [ab], durationMinutes: null });
  const ack = await (await status(await sharing.PUT(send("PUT", "sharing", update)), 200)).json();
  assert.equal(ack.sharingUntil, grant.sharingUntil); assert.equal(ack.publicationEpoch, null); assert.deepEqual(ack.frozenCircleIds, [ab]);
  t.mock.timers.tick(30_000); await status(await location.PUT(send("PUT", "location", position(a, grant, { sequence: 2, latitude: 56 }))), 200);
  globalThis.__earthCookieToken = b.token;
  const publicFeed = await (await status(await people.GET(send("GET", "people")), 200)).json();
  assert.deepEqual(publicFeed.people[0], original); assert.equal("frozenCircleIds" in publicFeed.people[0], false);
  await status(await sharing.PUT(send("PUT", "sharing", write(a, [ab, ac], { frozenOnly: true, frozenCircleIds: [ab] }))), 409);
  globalThis.__earthCookieToken = a.token;
  await status(await sharing.PUT(send("PUT", "sharing", write(a, [ab, ac], { frozenOnly: true, frozenCircleIds: [ab, ab] }))), 400);
  const off = await (await status(await sharing.PUT(send("PUT", "sharing", write(a, [], { mode: "OFF", frozenOnly: true, expectedRevision: 0 }))), 200)).json();
  assert.equal(off.mode, "OFF"); assert.deepEqual(off.frozenCircleIds, []);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
});

test("frozen snapshots expire physically and friendship revocation clears stale cached snapshots without retaining a route", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const grant = enable(a, [ab, ac]); ok(store.putDevEarthPosition(a.token, position(a, grant)));
  preferences(a, [ab, ac], [ab, ac]);
  const record = devEarthSharingState().owners.get(a.me.user.publicId);
  assert.equal(record.frozenPositions.size, 2);
  ok(identity.removeDevPerson(a.token, ab));
  assert.equal(record.frozenPositions.size, 0); assert.deepEqual(record.frozenCircleIds, [ac]);
  const renewed = enable(a, [ac], { frozenCircleIds: [] });
  t.mock.timers.tick(1); ok(store.putDevEarthPosition(a.token, position(a, renewed)));
  preferences(a, [ac], [ac]); assert.equal(record.frozenPositions.size, 1);
  t.mock.timers.tick(3_600_000);
  assert.equal(record.position, null); assert.equal(record.frozenPositions.size, 0); assert.equal(devEarthSharingState().cleanup, null);
});

test("development HMR initializes missing preference containers without inventing frozen points", () => {
  const a = player(), b = player(), ab = connect(a, b), grant = enable(a, [ab]);
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  const old = devEarthSharingState(), record = old.owners.get(a.me.user.publicId);
  delete old.version; delete record.frozenCircleIds; delete record.frozenPositions; delete record.awaitingFreshSince;
  const migrated = devEarthSharingState().owners.get(a.me.user.publicId);
  assert.deepEqual(ok(store.getDevEarthSharing(a.token)).frozenCircleIds, []);
  assert.equal(migrated.frozenPositions.size, 0); assert.equal(migrated.awaitingFreshSince.size, 0);
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
});

test("global OFF and GHOST outrank a stale frozenOnly flag and ignored frozen preferences through HTTP", async () => {
  for (const mode of ["GHOST", "OFF"]) {
    identity.resetDevStoreForTests();
    const a = player(), b = player(), circle = connect(a, b), grant = enable(a, [circle]);
    ok(store.putDevEarthPosition(a.token, position(a, grant)));
    const before = ok(store.getDevEarthPeople(b.token)).people;
    globalThis.__earthCookieToken = a.token;
    const ack = await (await status(await sharing.PUT(send("PUT", "sharing", write(a, [], {
      mode, frozenOnly: true, expectedRevision: 0, frozenCircleIds: [circle],
    }))), 200)).json();
    assert.equal(ack.mode, mode); assert.equal(ack.publicationEpoch, null);
    assert.deepEqual(ack.frozenCircleIds, [], "global GHOST does not adopt the ignored incoming individual preferences");
    assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, mode === "GHOST" ? before : []);
    error(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 2 })), 409);
  }
});

test("a late fix captured before or exactly at unfreeze stays hidden and cannot be captured by refreeze", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  for (const offset of [-5_000, 0]) {
    identity.resetDevStoreForTests();
    const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
    const grant = enable(a, [ab, ac]); ok(store.putDevEarthPosition(a.token, position(a, grant)));
    t.mock.timers.tick(10_000); preferences(a, [ab, ac], [ab]);
    t.mock.timers.tick(10_000); preferences(a, [ab, ac], []);
    const unfreezeAt = Date.now();
    t.mock.timers.tick(10_000);
    ok(store.putDevEarthPosition(a.token, position(a, grant, {
      sequence: 2, latitude: 56, capturedAt: new Date(unfreezeAt + offset).toISOString(),
    })));
    assert.equal(ok(store.getDevEarthPeople(c.token)).people[0].latitude, 56, "the still-live recipient can receive an otherwise valid delayed fix");
    assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "server acceptance after unfreeze cannot promote an earlier GPS capture");
    preferences(a, [ab, ac], [ab]);
    assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, [], "refreeze cannot capture the prohibited delayed common point");
    preferences(a, [ab, ac], []);
    t.mock.timers.tick(30_000);
    ok(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 3, latitude: 57 })));
    assert.equal(ok(store.getDevEarthPeople(b.token)).people[0].latitude, 57);
  }
});

test("development HMR converts legacy awaiting flags into conservative capture-time fences", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00Z") });
  const a = player(), b = player(), ab = connect(a, b), grant = enable(a, [ab]);
  ok(store.putDevEarthPosition(a.token, position(a, grant)));
  const state = devEarthSharingState(), record = state.owners.get(a.me.user.publicId);
  t.mock.timers.tick(10_000);
  state.version = 2; delete record.awaitingFreshSince; record.awaitingFreshCircleIds = new Set([ab]);
  const migrated = devEarthSharingState().owners.get(a.me.user.publicId);
  assert.equal(migrated.awaitingFreshSince.get(ab), Date.now());
  assert.equal("awaitingFreshCircleIds" in migrated, false);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  t.mock.timers.tick(20_000); ok(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 2 })));
  assert.equal(ok(store.getDevEarthPeople(b.token)).people.length, 1);
});

test("HTTP narrow revocation during global GHOST preserves ghost, the remaining last point and its original deadline", async () => {
  const a = player(), b = player(), c = player(), ab = connect(a, b), ac = connect(a, c);
  const grant = enable(a, [ab, ac]); ok(store.putDevEarthPosition(a.token, position(a, grant)));
  preferences(a, [ab, ac], [ab]);
  ok(store.putDevEarthSharing(a.token, write(a, [], { mode: "GHOST" })));
  const remaining = ok(store.getDevEarthPeople(c.token)).people;
  globalThis.__earthCookieToken = a.token;
  const revoke = await (await status(await sharing.PUT(send("PUT", "sharing", write(a, [ac], {
    mode: "SHARING", frozenOnly: true, frozenCircleIds: [], durationMinutes: null,
  }))), 200)).json();
  assert.equal(revoke.mode, "GHOST"); assert.equal(revoke.publicationEpoch, null); assert.equal(revoke.sharingUntil, grant.sharingUntil);
  assert.deepEqual(revoke.recipientCircleIds, [ac]); assert.deepEqual(revoke.frozenCircleIds, []);
  assert.deepEqual(ok(store.getDevEarthPeople(b.token)).people, []);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, remaining);
  error(store.putDevEarthPosition(a.token, position(a, grant, { sequence: 2 })), 409);
  const off = await (await status(await sharing.PUT(send("PUT", "sharing", write(a, [], {
    mode: "SHARING", frozenOnly: true, frozenCircleIds: [], durationMinutes: null,
  }))), 200)).json();
  assert.equal(off.mode, "OFF"); assert.equal(off.sharingUntil, null);
  assert.deepEqual(ok(store.getDevEarthPeople(c.token)).people, []);
});
