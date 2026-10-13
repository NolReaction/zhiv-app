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
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingDiagnostics } = await vite.ssrLoadModule("/features/world/dev/fishing-diagnostics.ts");
const { WorldDevFishing, FishingDiagnosticReport } = await vite.ssrLoadModule("/features/world/dev/world-dev-fishing.tsx");
const spec = economyCatalog.fishing, math = economicMath(economyCatalog);
const select = (patch = {}) => ({ rodId: "reed_rod", hookId: "bare_hook", baitId: null, routeId: "shore", ...patch });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("DEV normalizes class and species probabilities for every route and tackle choice", () => {
  for (const rod of spec.rods) for (const hook of spec.hooks) for (const baitId of [null, ...spec.baits.map(bait => bait.itemId)]) for (const routeId of spec.routeIds) {
    const report = fishingDiagnostics(select({ rodId: rod.id, hookId: hook.id, baitId, routeId }));
    const portfolio = math.catchPortfolio(rod.id, baitId, routeId, hook.id);
    assert.ok(report); near(report.rows.reduce((sum, row) => sum + row.expectedCount, 0), report.totalFish);
    near(report.rows.reduce((sum, row) => sum + row.probability, 0), 1);
    near(report.classes.reduce((sum, group) => sum + group.probability, 0), 1);
    for (const group of report.classes) {
      near(group.probability, portfolio.classProbabilities[group.itemId]);
      near(group.expectedCount, portfolio.output[group.itemId]);
      assert.equal(group.probability, group.weight / group.totalWeight);
      near(report.rows.filter(row => row.rarity === group.rarity).reduce((sum, row) => sum + row.probability, 0), group.probability);
    }
    for (const row of report.rows) {
      near(row.probability, portfolio.probabilities[row.itemId]);
      near(row.expectedCount, report.draws * portfolio.probabilities[row.itemId]);
    }
  }
});

test("every camp fish gets a class draw and collection species are uniform within the class", () => {
  const report = fishingDiagnostics(select({ rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "star_bait", routeId: "shore_camp" }));
  const shark = report.rows.find(row => row.itemId === "fish_shark"), legendary = report.classes.find(group => group.rarity === "legendary");
  assert.equal(report.draws, 8); assert.equal(report.totalFish, 8);
  near(shark.atLeastOne, 1 - (1 - shark.probability) ** 8);
  near(shark.expectedCount, 8 * shark.probability);
  near(legendary.atLeastOne, 1 - (1 - legendary.probability) ** 8);
  for (const group of report.classes) {
    const rows = report.rows.filter(row => row.rarity === group.rarity && !row.reason);
    for (const row of rows) near(row.probability, group.probability / rows.length);
  }
  assert.equal(legendary.rodBasisPoints, spec.rods.find(rod => rod.id === "starfall_rod").classOddsBps.legendary);
  assert.deepEqual([legendary.hookFactor, legendary.baitFactor], [150, 150]);
  assert.equal(legendary.weight, Math.floor(legendary.rodBasisPoints * 1.5 * 1.5));
});

test("DEV explains forbidden legendary fish, even when the hook is already legendary", () => {
  const report = fishingDiagnostics(select({ hookId: "leviathan_hook", baitId: "star_bait" }));
  const shark = report.rows.find(row => row.itemId === "fish_shark");
  assert.equal(shark.reason, "legendary_tackle"); assert.equal(shark.probability, 0);
  assert.equal(shark.expectedCount, 0); assert.ok(shark.atLeastOne === 0);
  const html = renderToStaticMarkup(createElement(FishingDiagnosticReport, { report }));
  assert.match(html, /Нужна легендарная удочка/);
  assert.match(html, /Точная доля класса: 0 \/ /);
  assert.equal((html.match(/data-dev-fish=/g) ?? []).length, spec.fish.length);
  assert.equal((html.match(/data-dev-fish-class=/g) ?? []).length, spec.classes.length);
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


test("DEV reports rod base odds, allows legendary rods with plain hooks and explains zero-base classes", () => {
  const report = fishingDiagnostics(select({ rodId: "starfall_rod", hookId: "bare_hook", baitId: null }));
  const legendary = report.classes.find(group => group.rarity === "legendary");
  assert.ok(legendary.probability > 0);
  const html = renderToStaticMarkup(createElement(FishingDiagnosticReport, { report }));
  assert.match(html, /База удочки/);
  assert.match(html, /bps/);
  assert.doesNotMatch(html, /Нужен крючок|Нужны легендарные удочка и крючок/);
  const starter = fishingDiagnostics(select());
  const zero = starter.rows.filter(row => spec.rods.find(rod => rod.id === "reed_rod").classOddsBps[row.rarity] === 0);
  assert.ok(zero.length > 0);
  assert.ok(zero.every(row => row.probability === 0 && row.reason));
  assert.match(renderToStaticMarkup(createElement(FishingDiagnosticReport, { report: starter })), /Эта удочка не ловит этот класс/);
});
