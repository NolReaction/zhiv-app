import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { canRecordEarthMeeting, earthMeetDetails, earthFriendWalkingRouteIssue, walkingRouteUrl } = await vite.ssrLoadModule("/features/earth/meet.ts");
const wall = Date.parse("2026-10-20T12:00:00Z"), mono = 10_000;
const self = (extra = {}) => ({ latitude: 0, longitude: 0, accuracy: 10, timestamp: wall, ...extra });
const friend = (extra = {}) => ({ circleId: "circle", user: { publicId: "friend", displayName: "Друг" },
  latitude: 0, longitude: 1, accuracyMeters: 20, precision: "PRECISE",
  updatedAt: new Date(wall).toISOString(), expiresAt: new Date(wall + 3_600_000).toISOString(),
  expiresAtMonotonic: mono + 3_600_000, ...extra });
const details = (from = self(), to = friend(), atMono = mono, atWall = wall) => earthMeetDetails(from, to, atMono, atWall);
const route = (to = friend(), atMono = mono, atWall = wall) => walkingRouteUrl(to, atMono, atWall);
const near = (value, expected, tolerance) => assert.ok(Math.abs(value - expected) < tolerance, `${value} must be near ${expected}`);

test("an explicit atlas meeting note requires two fresh precise nearby fixes and rechecks expiry", () => {
  const to = friend({ longitude: 0.0005 });
  assert.equal(canRecordEarthMeeting(self(), to, mono, wall), true);
  assert.equal(canRecordEarthMeeting(null, to, mono, wall), false);
  for (const from of [self({ accuracy: 51 }), self({ timestamp: wall - 60_001 }), self({ accuracy: NaN })]) {
    assert.equal(canRecordEarthMeeting(from, to, mono, wall), false);
  }
  for (const patch of [{ precision: "APPROXIMATE" }, { accuracyMeters: 51 }, { longitude: 0.001 },
    { updatedAt: new Date(wall - 60_001).toISOString() }, { expiresAtMonotonic: mono },
    { updatedAt: new Date(wall + 10_001).toISOString() }]) {
    assert.equal(canRecordEarthMeeting(self(), { ...to, ...patch }, mono, wall), false);
  }
  assert.equal(canRecordEarthMeeting(self(), to, mono + 60_001, wall + 60_001), false);
});

test("meeting estimates the straight-line distance and direction to the last received point without mutating either fix", () => {
  const from = self(), to = friend(), before = structuredClone([from, to]);
  const result = details(from, to);
  near(result.distanceMeters, 111_195, 1);
  near(result.bearingDegrees, 90, 1e-9);
  assert.equal(result.direction, "В");
  assert.equal(result.accuracyMeters, 30);
  assert.deepEqual([from, to], before);
  assert.equal("route" in result, false);
});

test("bearings cover all eight Russian compass directions and use the short antimeridian arc", () => {
  for (const [latitude, longitude, direction] of [[1, 0, "С"], [1, 1, "СВ"], [0, 1, "В"], [-1, 1, "ЮВ"],
    [-1, 0, "Ю"], [-1, -1, "ЮЗ"], [0, -1, "З"], [1, -1, "СЗ"]]) {
    assert.equal(details(self(), friend({ latitude, longitude })).direction, direction);
  }
  const east = details(self({ longitude: 179.9 }), friend({ longitude: -179.9 }));
  const west = details(self({ longitude: -179.9 }), friend({ longitude: 179.9 }));
  near(east.distanceMeters, 22_239, 1);
  near(west.distanceMeters, east.distanceMeters, 1e-6);
  assert.equal(east.direction, "В"); assert.equal(west.direction, "З");
});

test("overlapping accuracy areas, coincident points, antipodes and exact poles never invent a reliable direction", () => {
  const overlap = details(self({ accuracy: 100 }), friend({ longitude: 0.001, accuracyMeters: 100 }));
  assert.ok(overlap.distanceMeters > 100 && overlap.distanceMeters < 200);
  assert.equal(overlap.accuracyMeters, 200); assert.equal(overlap.bearingDegrees, null); assert.equal(overlap.direction, null);
  for (const [from, to] of [[self(), friend({ longitude: 0 })], [self(), friend({ longitude: 180 })],
    [self({ latitude: 90 }), friend({ latitude: 89, longitude: 45 })]]) {
    const result = details(from, to);
    assert.ok(Number.isFinite(result.distanceMeters));
    assert.equal(result.bearingDegrees, null); assert.equal(result.direction, null);
  }
  assert.equal(details(self({ longitude: 180, accuracy: 0 }), friend({ longitude: -180, accuracyMeters: 0 })).distanceMeters, 0);
});

test("fresh private fixes are required even when the friend point remains retained for hours", () => {
  assert.equal(details(null), null);
  assert.ok(details(self({ timestamp: wall - 60_000 })));
  assert.equal(details(self({ timestamp: wall - 60_001 })), null);
  assert.ok(details(self({ timestamp: wall + 10_000 })));
  assert.equal(details(self({ timestamp: wall + 10_001 })), null);
  const oldFriend = friend({ updatedAt: new Date(wall - 23 * 3_600_000).toISOString(), expiresAt: new Date(wall + 60_000).toISOString() });
  assert.ok(details(self(), oldFriend), "distance refers to an unexpired last-known point, without claiming it is current");
});

test("wall-clock and monotonic expiry independently retire distance and external routing", () => {
  for (const to of [friend({ expiresAt: new Date(wall).toISOString() }), friend({ expiresAtMonotonic: mono }),
    friend({ expiresAtMonotonic: mono - 1 }), friend({ updatedAt: new Date(wall + 10_001).toISOString() }),
    friend({ updatedAt: new Date(wall - 86_400_000).toISOString(), expiresAt: new Date(wall + 1).toISOString() })]) {
    assert.equal(details(self(), to), null); assert.equal(route(to), null);
  }
  assert.equal(details(self(), friend(), Number.NaN), null);
  assert.equal(route(friend(), mono, Number.NaN), null);
});

test("invalid coordinates, times and uncertainty radii cannot produce a distance, bearing or external URL", () => {
  for (const patch of [{ latitude: 91 }, { longitude: -181 }, { latitude: Infinity }, { accuracy: -1 },
    { accuracy: NaN }, { accuracy: 100_001 }, { timestamp: Infinity }, { timestamp: -1 }]) assert.equal(details(self(patch)), null);
  for (const patch of [{ latitude: -91 }, { longitude: 181 }, { longitude: NaN }, { accuracyMeters: -1 },
    { accuracyMeters: Infinity }, { accuracyMeters: 100_001 }, { updatedAt: "broken" }, { expiresAt: "broken" },
    { expiresAtMonotonic: Infinity }, { precision: "UNKNOWN" }]) {
    const to = friend(patch); assert.equal(details(self(), to), null); assert.equal(route(to), null);
  }
});

test("external walking directions name Google Maps and export only an authorized destination, never a private origin or identity", () => {
  const to = friend({ latitude: 55.75, longitude: 37.62 });
  const before = structuredClone(to), url = new URL(route(to));
  assert.equal(url.origin, "https://www.google.com"); assert.equal(url.pathname, "/maps/dir/");
  assert.deepEqual([...url.searchParams], [["api", "1"], ["destination", "55.75,37.62"], ["travelmode", "walking"]]);
  assert.equal(url.searchParams.has("origin"), false);
  assert.equal(url.searchParams.has("dir_action"), false);
  assert.equal(url.toString().includes("friend"), false);
  assert.deepEqual(to, before);
});

test("walking directions accept authorized last-known and approximate points while preserving capture metadata", () => {
  assert.ok(route(friend({ accuracyMeters: 200, updatedAt: new Date(wall - 300_000).toISOString() })));
  for (const patch of [{ precision: "APPROXIMATE", accuracyMeters: 1500 }, { accuracyMeters: 201 },
    { updatedAt: new Date(wall - 300_001).toISOString() }]) {
    const to = friend(patch);
    assert.ok(details(self(), to)); assert.ok(route(to));
  }
});


test("all map choices encode only an authorized destination with each provider's coordinate order and pedestrian mode", () => {
  const to = friend({ latitude: 55.751234, longitude: -37.621234 });
  const routes = Object.fromEntries(["yandex", "2gis", "google", "apple"].map(service => [service, new URL(walkingRouteUrl(to, mono, wall, service))]));
  assert.equal(routes.yandex.origin, "https://yandex.ru");
  assert.equal(routes.yandex.searchParams.get("rtext"), "~55.751234,-37.621234");
  assert.equal(routes.yandex.searchParams.get("rtt"), "pd");
  assert.equal(routes["2gis"].origin, "https://2gis.ru");
  assert.equal(routes["2gis"].pathname, "/directions/tab/pedestrian/points/|-37.621234,55.751234");
  assert.equal(routes.google.searchParams.get("destination"), "55.751234,-37.621234");
  assert.equal(routes.google.searchParams.get("travelmode"), "walking");
  assert.equal(routes.apple.origin, "https://maps.apple.com");
  assert.equal(routes.apple.searchParams.get("daddr"), "55.751234,-37.621234");
  assert.equal(routes.apple.searchParams.get("dirflg"), "w");
  for (const [service, url] of Object.entries(routes)) {
    assert.doesNotMatch(url.toString(), /friend|circle|publicId|origin|saddr|rstart|source|55,37/);
    for (const patch of [{ precision: "APPROXIMATE" }, { accuracyMeters: 201 }, { updatedAt: new Date(wall - 300_001).toISOString() },
      { expiresAtMonotonic: mono }]) assert.equal(Boolean(walkingRouteUrl(friend(patch), mono, wall, service)), patch.expiresAtMonotonic !== mono);
  }
  assert.equal(walkingRouteUrl(to, mono, wall, "untrusted"), null);
});

test("friend route eligibility accepts old coarse captures but keeps independent access deadlines", () => {
  for (const patch of [{}, { precision: "APPROXIMATE", accuracyMeters: 1500 }, { accuracyMeters: 201 },
    { updatedAt: new Date(wall - 300_001).toISOString() }]) {
    assert.equal(earthFriendWalkingRouteIssue(friend(patch), mono, wall), null);
    assert.ok(route(friend(patch)));
  }
  assert.equal(earthFriendWalkingRouteIssue(friend(), mono + 3_600_000, wall), "friend_unavailable");
  assert.equal(route(friend(), mono, wall + 3_600_000), null);
});
