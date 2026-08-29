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
const gameEvents = await vite.ssrLoadModule("/lib/game-events.ts");
const devEvents = await vite.ssrLoadModule("/lib/dev-api-events.ts");

after(async () => vite.close());

const validEvent = {
  eventId: "4a272b65-8ada-4b0d-aad8-6a6ef845f41b",
  type: "CLICKER_SERIES_FINISHED",
  tapCount: 20,
  bestSeries: 50,
  level: 5,
  storyId: "space",
  durationMs: 12_345,
  reason: "IDLE_TIMEOUT",
};

test("accepts only a consistent aggregate clicker event", () => {
  assert.deepEqual(gameEvents.parseClickerSeriesEvent(validEvent), validEvent);
  assert.equal(gameEvents.parseClickerSeriesEvent({ ...validEvent, tapCount: 0 }), null);
  assert.equal(gameEvents.parseClickerSeriesEvent({ ...validEvent, level: 4 }), null);
  assert.equal(gameEvents.parseClickerSeriesEvent({ ...validEvent, storyId: "../../token" }), null);
  assert.equal(gameEvents.parseClickerSeriesEvent({ ...validEvent, cookie: "secret" }), null);
});

test("writes a strict privacy-safe development log line", () => {
  const lines = [];
  devEvents.logDevClickerSeries(validEvent, (line) => lines.push(line));
  devEvents.logDevClickerSeries(validEvent, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), [
    "best_series",
    "client_reported",
    "duration_ms",
    "event",
    "level",
    "reason",
    "schema_version",
    "source",
    "story_id",
    "tap_count",
  ]);
  assert.doesNotMatch(
    lines[0],
    /cookie|token|displayName|publicId|idempotency|eventId|event_id/i,
  );
});
