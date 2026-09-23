import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { getAdminTapActivity } = await vite.ssrLoadModule("/features/admin/admin-api.ts");
const { currentTapReport, formatTapBucket } = await vite.ssrLoadModule("/features/admin/tap-activity-range.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => vite.close());
const publicId = "7K3P-2Q9M-W8ZR";
const serverTime = "2026-09-23T12:30:35Z";
function report(rangeMinutes = 30) {
  return { publicId, displayName: "Тестер", watchlisted: false, serverTime,
    windows: [10, 30, 60, 1800].map(seconds => ({ seconds, receivedTaps: 2, eventTaps: 0, tapsPerSecond: 0 })),
    minutes: [], rejectedTaps: 0, delayedTaps: 2, legacyTaps: 0,
    analysis: { status: "insufficient_data", stableMinutes: 0, activeMinutes: 0, meanTapsPerMinute: null,
      minuteVariation: null, intervalVariation: null, intervalSamples: 0, reasons: [] },
    history: { rangeMinutes, bucketMinutes: rangeMinutes === 10080 ? 120 : rangeMinutes === 1440 ? 30 : 1,
      from: "2026-09-22T12:30:00Z", to: serverTime, coverageFrom: "2026-09-23T10:00:00Z", coverageComplete: false,
      receivedTaps: 5, eventTaps: 3, rejectedTaps: 1, delayedTaps: 2, legacyTaps: 0,
      buckets: [{ at: "2026-09-22T12:30:00Z", until: "2026-09-22T13:00:00Z", receivedTaps: null, eventTaps: null,
        complete: true, coverageComplete: false }, { at: "2026-09-23T12:30:00Z", until: serverTime,
        receivedTaps: 5, eventTaps: 3, complete: false, coverageComplete: true }] },
  };
}

test("tap ranges request the selected history with authentication and preserve unknown buckets", async () => {
  for (const range of [30, 1440, 10080]) {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `/api/v1/admin/users/${publicId}/tap-activity?rangeMinutes=${range}`);
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.cache, "no-store");
      return Response.json(report(range));
    };
    const result = await getAdminTapActivity(publicId, undefined, range);
    assert.equal(result.history.buckets[0].receivedTaps, null);
    assert.equal(result.history.receivedTaps, 5);
    assert.equal(result.history.eventTaps, 3);
    assert.equal(result.windows.at(-1).receivedTaps, 2);
  }
});

test("mismatched player or range and invalid history cannot be displayed as the requested result", async () => {
  const bodies = [report(30), { ...report(1440), publicId: "7K3P-2Q9M-W8ZS" }, report(1440), report(1440)];
  bodies[2].history.buckets[0].receivedTaps = -1;
  bodies[3].history.buckets = Array.from({ length: 86 }, () => bodies[3].history.buckets[0]);
  for (const body of bodies) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(getAdminTapActivity(publicId, undefined, 1440), error => error.status === 502);
  }
});

test("changing range or player hides an earlier report until matching data arrives", () => {
  const day = report(1440);
  assert.equal(currentTapReport(day, publicId, 10080), null);
  assert.equal(currentTapReport(day, "7K3P-2Q9M-W8ZS", 1440), null);
  assert.equal(currentTapReport(null, publicId, 1440), null);
  assert.equal(currentTapReport(day, publicId, 1440), day);
});

test("long ranges include UTC date labels so adjacent days are distinguishable", () => {
  assert.equal(formatTapBucket("2026-09-22T23:59:00Z", 30), "23:59");
  assert.match(formatTapBucket("2026-09-22T23:59:00Z", 1440), /22\.09.*23:59/);
  assert.match(formatTapBucket("2026-09-23T00:00:00Z", 10080), /23\.09.*00:00/);
});
