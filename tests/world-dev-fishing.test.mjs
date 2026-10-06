import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { economicMath } from "../scripts/lib/economy-math.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { fishingDiagnostics } = await vite.ssrLoadModule("/features/world/dev/fishing-diagnostics.ts");
const { WorldDevFishing, FishingDiagnosticReport } = await vite.ssrLoadModule("/features/world/dev/world-dev-fishing.tsx");
const spec = economyCatalog.fishing, math = economicMath(economyCatalog);
const select = (patch = {}) => ({ rodId: "reed_rod", hookId: "bare_hook", baitId: null, routeId: "shore", ...patch });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("DEV normalizes the server weights and preserves batch size for all 360 route and tackle choices", () => {
  for (const rod of spec.rods) for (const hook of spec.hooks) for (const baitId of [null, ...spec.baits.map(bait => bait.itemId)]) for (const routeId of spec.routeIds) {
    const report = fishingDiagnostics(select({ rodId: rod.id, hookId: hook.id, baitId, routeId }));
    const portfolio = math.catchPortfolio(rod.id, baitId, routeId, hook.id);
    assert.ok(report); near(report.rows.reduce((sum, row) => sum + row.expectedCount, 0), report.totalFish);
    near(report.rows.reduce((sum, row) => sum + row.probability, 0), 1);
    for (const row of report.rows) {
      assert.equal(row.probability, portfolio.probabilities[row.itemId]);
      near(row.expectedCount, portfolio.output[row.itemId]);
      assert.equal(row.probability, row.weight / row.totalWeight);
    }
  }
});

test("trip chances use six separate camp draws and include guaranteed ordinary fish", () => {
  const report = fishingDiagnostics(select({ rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "firefly_bait", routeId: "shore_camp" }));
  const shark = report.rows.find(row => row.itemId === "fish_shark"), ordinary = report.rows.find(row => row.itemId === "fish");
  assert.equal(report.draws, 6); assert.equal(report.totalFish, 24);
  assert.equal(shark.weight, 18); assert.equal(shark.totalWeight, 4572);
  near(shark.atLeastOne, 1 - (1 - 18 / 4572) ** 6);
  near(shark.expectedCount, 6 * 18 / 4572);
  assert.equal(ordinary.guaranteed, 18); assert.equal(ordinary.atLeastOne, 1);
  near(ordinary.expectedCount, 18 + ordinary.probability * 6);
  assert.deepEqual([shark.rodFactor, shark.hookFactor, shark.baitFactor], [400, 300, 150]);
});

test("DEV explains forbidden legendary fish, even when the hook is already legendary", () => {
  const report = fishingDiagnostics(select({ hookId: "leviathan_hook", baitId: "firefly_bait" }));
  const shark = report.rows.find(row => row.itemId === "fish_shark");
  assert.equal(shark.reason, "legendary_tackle"); assert.equal(shark.weight, 0);
  assert.equal(shark.expectedCount, 0); assert.ok(shark.atLeastOne === 0);
  const html = renderToStaticMarkup(createElement(FishingDiagnosticReport, { report }));
  assert.match(html, /Нужны легендарные удочка и крючок/);
  assert.match(html, /Точная доля: 0 \/ /);
  assert.equal((html.match(/data-dev-fish=/g) ?? []).length, spec.fish.length);
});

test("DEV lists unowned test gear without changing the account or hiding species", () => {
  const state = { catalog: economyCatalog, fishing: economyFishingSchema.parse(undefined) }, before = structuredClone(state);
  const html = renderToStaticMarkup(createElement(WorldDevFishing, { state }));
  assert.equal((html.match(/<select/g) ?? []).length, 4);
  for (const gear of [...spec.rods, ...spec.hooks]) assert.ok(html.includes(`value="${gear.id}"`));
  assert.match(html, /Теневая акула/); assert.match(html, /не меняет экипировку и запасы/);
  assert.doesNotMatch(html, /<button/);
  assert.deepEqual(state, before);
});

test("invalid selection or a non-fishing route cannot manufacture diagnostic odds", () => {
  assert.equal(fishingDiagnostics(select({ routeId: "deep_cave" })), null);
  assert.equal(fishingDiagnostics(select({ rodId: "missing" })), null);
  assert.equal(fishingDiagnostics(select({ baitId: "missing" })), null);
});
