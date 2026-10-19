import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthCacheBudgets, createEarthCachePolicy } = await vite.ssrLoadModule("/features/earth/resource-cache-policy.ts");
const MIB = 1024 * 1024;
const url = (z, x, y) => `https://tiles.openfreemap.org/planet/dated/${z}/${x}/${y}.pbf`;
const entry = (value, saved = 1000, size = 16) => ({ url: value, saved, size });

test("device and origin storage hints only reduce deterministic hard budgets", () => {
  const normal = earthCacheBudgets();
  assert.equal(normal.diskBytes, 64 * MIB);
  assert.equal(normal.memoryBytes, 16 * MIB);
  assert.equal(normal.tileEntries, 64);
  const low = earthCacheBudgets({ deviceMemory: 2 });
  assert.equal(low.diskBytes, 32 * MIB);
  assert.equal(low.memoryBytes, 8 * MIB);
  assert.equal(low.concurrency, 2);
  assert.equal(low.pendingEntries, 32);
  assert.equal(low.tileEntries, 32);
  const excessive = earthCacheBudgets({ maxBytes: Infinity, maxEntries: 10_000, concurrency: 100 });
  assert.equal(excessive.diskEntries, 512);
  assert.equal(excessive.concurrency, 4);
  assert.equal(excessive.diskBytes, 64 * MIB);
  assert.equal(earthCacheBudgets({ maxBytes: 10 ** 12 }).diskBytes, 100 * MIB);
  const tight = earthCacheBudgets({ quotaBytes: 100 * MIB, usageBytes: 99 * MIB });
  assert.equal(tight.diskBytes, MIB / 4);
  const allocated = earthCacheBudgets({ quotaBytes: 100 * MIB, usageBytes: 99 * MIB, storedBytes: MIB });
  assert.equal(allocated.diskBytes, MIB + MIB / 4, "our existing bytes do not repeatedly shrink our own allowance");
  assert.equal(earthCacheBudgets({ quotaBytes: 0, usageBytes: 0 }).diskBytes, 0);
  assert.equal(normal.resourceBytes * normal.concurrency * 2, 32 * MIB, "body chunks plus assembly have a bounded aggregate budget");
});

test("bounded actual reuse keeps frequent areas above one-off detail and eventually ages away", () => {
  let time = 1000;
  const policy = createEarthCachePolicy({ now: () => time });
  const frequent = entry(url(12, 100, 100)), passing = entry(url(12, 3000, 3000));
  for (let i = 0; i < 30; i++) policy.touch(frequent.url);
  policy.touch(passing.url);
  assert.ok(policy.compare(frequent, passing) > 0);
  time += 30 * 86_400_000;
  const recent = entry(url(12, 1500, 1500), time);
  policy.touch(recent.url);
  assert.ok(policy.compare(recent, frequent) > 0, "historical frequency cannot pin a region forever");
  for (let i = 0; i < 1000; i++) policy.touch(url(12, i, 0));
  assert.equal(policy.historySize(), 512);
});

test("viewport priority follows antimeridian and zoom without adding a location history", () => {
  const policy = createEarthCachePolicy({ now: () => 1000 });
  const west = entry(url(8, 0, 128)), east = entry(url(8, 255, 128)), distant = entry(url(8, 128, 128));
  policy.setView({ longitude: 179.9, latitude: 0, zoom: 8 });
  assert.ok(policy.compare(east, distant) > 0);
  assert.ok(policy.compare(west, distant) > 0, "the nearby wrapped tile is retained too");
  assert.equal(policy.historySize(), 0, "move events never invent a visit or save coordinates");
  policy.setView(null);
  assert.ok(Number.isFinite(policy.compare(west, east)));
  policy.setView({ longitude: NaN, latitude: 0, zoom: 8 });
  assert.ok(Number.isFinite(policy.compare(west, east)));
});

test("equal reuse favours broad overview over distant expensive street detail with stable ties", () => {
  const policy = createEarthCachePolicy({ now: () => 1000 });
  assert.ok(policy.compare(entry(url(5, 3, 3)), entry(url(14, 3, 3))) > 0);
  assert.ok(policy.compare(entry("https://tiles.openfreemap.org/a", 1000, 100), entry("https://tiles.openfreemap.org/b", 1000, 10)) < 0);
});
