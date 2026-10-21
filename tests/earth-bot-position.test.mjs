import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-earth-bot-position-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { moveBotPosition, nearbyBotPosition, parseBotPosition } = await vite.ssrLoadModule("/features/earth/dev/bot-position.ts");

function distance(first, second) {
  const radians = Math.PI / 180;
  const latitude = (second.latitude - first.latitude) * radians;
  const longitude = (second.longitude - first.longitude) * radians;
  const haversine = Math.sin(latitude / 2) ** 2
    + Math.cos(first.latitude * radians) * Math.cos(second.latitude * radians) * Math.sin(longitude / 2) ** 2;
  return 2 * 6_371_008.8 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

test("the four manual directions move 100 metres while preserving the private input and accuracy", () => {
  const origin = Object.freeze({ latitude: 55.75, longitude: 37.62, accuracyMeters: 7 });
  for (const [bearing, direction] of [[0, "north"], [90, "east"], [180, "south"], [270, "west"]]) {
    const moved = moveBotPosition(origin, bearing);
    assert.notEqual(moved, origin);
    assert.ok(Math.abs(distance(origin, moved) - 100) < 0.00001, direction);
    assert.equal(moved.accuracyMeters, 7);
    if (direction === "north") assert.ok(moved.latitude > origin.latitude);
    if (direction === "south") assert.ok(moved.latitude < origin.latitude);
    if (direction === "east") assert.ok(moved.longitude > origin.longitude);
    if (direction === "west") assert.ok(moved.longitude < origin.longitude);
  }
  assert.deepEqual(origin, { latitude: 55.75, longitude: 37.62, accuracyMeters: 7 });
});

test("steps cross the date line and approach either pole without invalid map coordinates", () => {
  for (const [origin, bearing] of [
    [{ latitude: 0, longitude: 179.9999, accuracyMeters: 12 }, 90],
    [{ latitude: 0, longitude: -179.9999, accuracyMeters: 12 }, 270],
    [{ latitude: 89.9999, longitude: 37.62, accuracyMeters: 12 }, 0],
    [{ latitude: -89.9999, longitude: -37.62, accuracyMeters: 12 }, 180],
  ]) {
    const moved = moveBotPosition(origin, bearing);
    assert.ok(Number.isFinite(moved.latitude) && Math.abs(moved.latitude) <= 90);
    assert.ok(Number.isFinite(moved.longitude) && moved.longitude >= -180 && moved.longitude < 180);
    assert.ok(Math.abs(distance(origin, moved) - 100) < 0.01);
    assert.equal(moved.accuracyMeters, 12);
    if (origin.longitude === 179.9999) assert.ok(moved.longitude < 0, "east wraps to the western hemisphere");
    if (origin.longitude === -179.9999) assert.ok(moved.longitude > 0, "west wraps to the eastern hemisphere");
  }
});

test("nearby placement uses one fresh fix and offsets the synthetic friend 200 metres east", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const position = Object.freeze({ latitude: 55.75, longitude: 37.62, accuracy: 80, timestamp: now - 1_000 });
  const moved = nearbyBotPosition(position, now);
  assert.ok(moved);
  assert.ok(Math.abs(distance(position, moved) - 200) < 0.00001);
  assert.ok(moved.longitude > position.longitude);
  assert.equal(moved.accuracyMeters, 20, "synthetic accuracy is independent of the viewer's private GPS accuracy");
  assert.deepEqual(Object.keys(moved).sort(), ["accuracyMeters", "latitude", "longitude"]);
  assert.deepEqual(position, { latitude: 55.75, longitude: 37.62, accuracy: 80, timestamp: now - 1_000 });
});

test("nearby placement accepts the freshness boundaries and rejects stale, future or invalid coordinates", () => {
  const now = 1_000_000;
  const position = { latitude: 0, longitude: 0, accuracy: 10, timestamp: now };
  assert.ok(nearbyBotPosition({ ...position, timestamp: now - 60_000 }, now));
  assert.ok(nearbyBotPosition({ ...position, timestamp: now + 10_000 }, now));
  for (const changed of [
    { timestamp: now - 60_001 }, { timestamp: now + 10_001 }, { timestamp: NaN }, { timestamp: Infinity },
    { latitude: 90.000001 }, { latitude: -90.000001 }, { latitude: NaN }, { latitude: Infinity },
    { longitude: 180.000001 }, { longitude: -180.000001 }, { longitude: NaN }, { longitude: -Infinity },
  ]) assert.equal(nearbyBotPosition({ ...position, ...changed }, now), null, JSON.stringify(changed));
  assert.equal(nearbyBotPosition(null, now), null);
});

test("nearby placement requires a finite current clock before using private coordinates", () => {
  const position = { latitude: 55.75, longitude: 37.62, accuracy: 10, timestamp: 1_000_000 };
  for (const now of [NaN, Infinity, -Infinity]) assert.equal(nearbyBotPosition(position, now), null);
});

test("manual coordinates support trimmed decimal commas, zero and inclusive bounds", () => {
  assert.deepEqual(parseBotPosition(" 55,752345 ", " 37.623123 ", " 12,5 "),
    { latitude: 55.752345, longitude: 37.623123, accuracyMeters: 12.5 });
  assert.deepEqual(parseBotPosition("0", "0", "1"), { latitude: 0, longitude: 0, accuracyMeters: 1 });
  assert.deepEqual(parseBotPosition("90", "180", "50000"), { latitude: 90, longitude: 180, accuracyMeters: 50_000 });
  assert.deepEqual(parseBotPosition("-90", "-180", "1"), { latitude: -90, longitude: -180, accuracyMeters: 1 });
});

test("manual coordinates reject missing fields, non-finite numbers and out-of-range accuracy or positions", () => {
  for (const fields of [
    ["", "0", "20"], ["0", "  ", "20"], ["0", "0", ""],
    ["NaN", "0", "20"], ["0", "Infinity", "20"], ["0", "0", "-Infinity"],
    ["90.000001", "0", "20"], ["-90.000001", "0", "20"],
    ["0", "180.000001", "20"], ["0", "-180.000001", "20"],
    ["0", "0", "0"], ["0", "0", "0.999"], ["0", "0", "50000.001"],
    ["55,75,1", "0", "20"], ["0", "37 degrees", "20"], ["0", "0", "20m"],
  ]) assert.equal(parseBotPosition(...fields), null, JSON.stringify(fields));
});
