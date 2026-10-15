import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog, economyCatalogSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { constructionSpeedupPrice, constructionTimePearlPrice } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { durationPearlPrice, remainingTimePearlPrice } = await vite.ssrLoadModule("/features/economy/domain/time-price.ts");
const config = economyCatalog.constructionSpeedup;
const now = Date.parse("2026-10-14T00:00:00Z");
const generic = milliseconds => durationPearlPrice(milliseconds, config.secondsPerPearl, 50, config.priceStepPearls, config.pricingPoints);

test("premium curve has exact anchor prices, millisecond ceilings and continued pricing after one week", () => {
  const cases = [[-1, 0], [0, 0], [1, 2], [59_999, 2], [60_000, 2], [60_001, 4],
    [3_599_999, 40], [3_600_000, 40], [3_600_001, 42],
    [86_399_999, 520], [86_400_000, 520], [86_400_001, 522],
    [172_800_000, 768], [604_800_000, 2000], [604_800_001, 2002], [1_209_600_000, 3728]];
  for (const [milliseconds, rawPrice] of cases) {
    assert.equal(generic(milliseconds), rawPrice, `${milliseconds} milliseconds`);
    assert.equal(constructionTimePearlPrice(milliseconds / 1000), rawPrice);
    const job = { kind: "construction", finishesAt: new Date(now + milliseconds).toISOString() };
    assert.equal(constructionSpeedupPrice(job, now), rawPrice);
    assert.equal(remainingTimePearlPrice(job.finishesAt, now, config.secondsPerPearl, 50, config.priceStepPearls, config.pricingPoints), rawPrice);
  }
  for (const milliseconds of [NaN, Infinity, -Infinity]) assert.equal(generic(milliseconds), 0);
  assert.equal(remainingTimePearlPrice("invalid date", now, config.secondsPerPearl, 50, config.priceStepPearls, config.pricingPoints), 0);
});

test("the remaining quote never grows as a construction approaches readiness and every debit is a whole visible pearl", () => {
  const job = { kind: "construction", finishesAt: new Date(now + 2 * 86_400_000).toISOString() };
  let previous = constructionSpeedupPrice(job, now);
  for (let elapsed = 0; elapsed <= 2 * 86_400_000; elapsed += 97_000) {
    const price = constructionSpeedupPrice(job, now + elapsed);
    assert.ok(Number.isSafeInteger(price) && price >= 0);
    assert.equal(price % 2, 0);
    assert.ok(price <= previous, `Elapsed ${elapsed}: remaining quote cannot increase`);
    previous = price;
  }
  assert.equal(constructionSpeedupPrice(job, Date.parse(job.finishesAt)), 0);
});

test("an explicitly supplied historical linear policy retains its old quantum and cannot be replaced by the current curve", () => {
  const legacy = { secondsPerPearl: 15000, priceStepPearls: 2, pricingPoints: [] };
  for (const [seconds, price] of [[0, 0], [0.001, 2], [600, 2], [600.001, 4], [3600, 12], [86400, 288]]) {
    assert.equal(constructionTimePearlPrice(seconds, legacy), price);
  }
  assert.equal(constructionTimePearlPrice(86400), 520);
  assert.equal(constructionTimePearlPrice(86400, legacy), 288);
});

test("catalog rejects ambiguous price segments and fractional visible anchor costs while accepting an explicit legacy fallback", () => {
  const invalidPoints = [
    [config.pricingPoints[0]],
    [...config.pricingPoints].reverse(),
    [config.pricingPoints[0], config.pricingPoints[0], ...config.pricingPoints.slice(1)],
    config.pricingPoints.map((point, index) => index === 2 ? { ...point, pearls: 20 } : point),
    config.pricingPoints.map((point, index) => index === 0 ? { ...point, pearls: 3 } : point),
  ];
  for (const pricingPoints of invalidPoints) {
    assert.equal(economyCatalogSchema.safeParse({ ...economyCatalog, constructionSpeedup: { ...config, pricingPoints } }).success, false);
  }
  assert.equal(economyCatalogSchema.safeParse({ ...economyCatalog, constructionSpeedup: { ...config, pricingPoints: [] } }).success, true);
});
