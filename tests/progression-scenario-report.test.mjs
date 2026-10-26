import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { buildProgressionReport, compactProgressionReport } from "../scripts/build-progression-report.mjs";
import { progressionCatalogFingerprint as generatorFingerprint } from "../scripts/lib/progression-report-integrity.mjs";
import { progressionCases } from "../scripts/audit-progression-scenarios.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { progressionCatalogFingerprint } = await vite.ssrLoadModule("/features/progression/scenario-fingerprint.ts");
const { progressionScenarioReportSchema, scenarioHighlights, scenarioReportState, scenarioCsvRows, scenarioSchedule } = await vite.ssrLoadModule("/features/progression/economy-scenarios.ts");
const { EconomyScenarioReport } = await vite.ssrLoadModule("/features/progression/economy-scenario-report.tsx");
const { default: economy } = await vite.ssrLoadModule("/apps/api/src/main/resources/world/economy-catalog.json");
const { default: rewards } = await vite.ssrLoadModule("/apps/api/src/main/resources/world/progression-rewards-catalog.json");
const row = { label: "fixture-free", completed: false, seed: 7, visitsPerDay: 1, regularMinutes: 480, firstMinutes: 480,
  manualSeconds: 2, slotPolicy: "all", externalSlotBudget: 0, completionGoal: "all-buildings", elapsedDays: 100,
  activeHours: 600, manualHours: 30, commandCount: 54000, home5Days: 8.5, allProductionDays: 22,
  allBuildingsDays: null, allRecipesDays: null, reputationMaxDays: null, buildings: { home: 5, warehouse: 8 },
  pearls: 10, pearlLedger: { credits: { gift: 200 }, debits: { slots: 190 } },
  social: { mode: "balanced", funded: true, maximumXp: 4200, reputation: { trader: 1100 }, bonusPercent: { trader: 4 },
    allMaximum: false, completedWeekly: 3, acceptedWeeklies: [{ id: "first" }], expiredWeeklies: [], deliveries: [{ items: { berries: 1 } }] } };
const source = { schemaVersion: 2, policyVersion: "test-unified", economyVersion: economy.version, releaseValidated: true,
  sourceSha256: {}, policy: { schedule: "deterministic" }, scenarios: [row] };
const report = () => compactProgressionReport(structuredClone(source), economy, rewards);
const html = value => renderToStaticMarkup(createElement(EconomyScenarioReport, { report: value }));

test("report fingerprints invalidate any catalog edit and match the generator including Unicode", () => {
  assert.equal(progressionCatalogFingerprint(economy, rewards), generatorFingerprint(economy, rewards));
  assert.equal(progressionCatalogFingerprint({ text: "🌲 Лес" }, { value: 2 }), generatorFingerprint({ text: "🌲 Лес" }, { value: 2 }));
  const changed = structuredClone(economy); changed.version++;
  assert.notEqual(progressionCatalogFingerprint(changed, rewards), generatorFingerprint(economy, rewards));
  assert.equal(scenarioReportState(report()), "validated");
  assert.equal(scenarioReportState(report(), progressionCatalogFingerprint(changed, rewards)), "stale");
});

test("publication separates milestones from final goal, preserves exact CSV and strips private large ledgers", () => {
  const value = report(), published = value.scenarios[0];
  assert.equal(published.completed, false); assert.equal(published.home5Days, 8.5); assert.equal(published.allBuildingsDays, null);
  assert.equal(published.pearlsRemaining, 5); assert.equal(published.pearlIncome.gift, 100); assert.equal(published.pearlSpending.slots, 95);
  assert.equal(published.social.funded, true); assert.equal(published.social.deliveryCount, 1); assert.equal(published.social.deliveries, undefined);
  assert.equal(published.coinLedger, undefined); assert.equal(scenarioCsvRows(value)[1][13], 8.5);
  assert.equal(scenarioCsvRows(value)[1][15], null); assert.equal(scenarioSchedule(published), "1 × 8 ч в день");
});

test("sparse ledger dictionaries parse while undefined and nonnumeric actual values are rejected", () => {
  const value = report();
  value.scenarios.push({ ...structuredClone(value.scenarios[0]), id: "other", pearlIncome: { weekly: 10 } });
  assert.equal(progressionScenarioReportSchema.parse(value).scenarios[1].pearlIncome.weekly, 10);
  for (const invalid of [undefined, "10", NaN, -1]) {
    const broken = structuredClone(value); broken.scenarios[0].pearlIncome.invalid = invalid;
    assert.equal(progressionScenarioReportSchema.safeParse(broken).success, false);
  }
});

test("stale and unfinished reports hide historical numeric results rather than implying valid forecasts", () => {
  const stale = report(); stale.catalogFingerprint = "old";
  const text = html(stale);
  assert.match(text, /Прежние сроки скрыты/); assert.doesNotMatch(text, /data-scenario="fixture-free"/);
  const pending = report(); pending.status = "pending";
  assert.match(html(pending), /Итоговые прогоны ещё не опубликованы/);
  const review = report(); review.releaseValidated = false;
  assert.equal(scenarioReportState(review), "review"); assert.match(html(review), /проверка выпуска ещё не подтверждена/);
});

test("report shows funded reputation and distinct observed duration without presenting censored goals as finished", () => {
  const text = html(report());
  assert.match(text, /Цель не достигнута/); assert.match(text, /8,5 дн\./); assert.match(text, /100 дн\./);
  assert.match(text, /Материалы получены в игре/); assert.match(text, /из них действия 30 ч/);
  assert.match(text, /scope="col">Все постройки/); assert.match(text, /tabindex="0" role="region"/);
  assert.match(text, /CSV прогонов/); assert.match(text, /Бюджет в сценариях/);
});

test("generator refuses mixed legacy schema, duplicate scenarios, impossible dates and attention budgets", () => {
  const build = patch => compactProgressionReport({ ...source, ...patch }, economy, rewards);
  assert.throws(() => build({ schemaVersion: 1 }), /unified scenario schema/);
  assert.throws(() => build({ scenarios: [row, row] }), /unique/);
  assert.throws(() => build({ scenarios: [{ ...row, home5Days: 101 }] }), /after the end/);
  assert.throws(() => build({ scenarios: [{ ...row, manualHours: 601 }] }), /Manual time/);
});

test("published branch results match the full evidence and current economy sources without stale snapshots", async () => {
  const published = await buildProgressionReport({ check: true });
  assert.equal(published.status, "ready");
  assert(published.scenarios.some(row => row.visitsPerDay === 1 && row.regularMinutes >= 480), "hours-long daily play is included");
  assert(published.scenarios.some(row => row.goal === "full" && row.completed && row.reputationMaxDays !== null), "full maximum is a completed funded playthrough");
  assert(published.scenarios.some(row => row.externalPearls > 0), "explicit external-slot sensitivity is included");
  assert(published.scenarios.every(row => row.social?.funded), "reputation never relies on granted ingredients");
  assert.deepEqual(published.scenarios.map(row => row.id).sort(), progressionCases.map(options => options.label).sort(), "the report includes every canonical run exactly once");
  for (const row of published.scenarios) {
    const options = progressionCases.find(value => value.label === row.id);
    assert(options, `${row.id} must be an executable canonical scenario`);
    const expected = {
      regularMinutes: options.regularActiveMinutes ?? 20, firstMinutes: options.firstVisitMinutes ?? 60,
      visitsPerDay: options.visitsPerDay ?? 3, seed: options.seed ?? 1, slotPolicy: options.slotPolicy ?? "earned",
      maxDays: options.maxDays ?? 160, manualSeconds: options.manualSeconds ?? 2,
      externalPearls: (options.externalSlotBudget ?? 0) / 2, goal: options.completionGoal ?? "home-5",
      socialMode: options.socialMode ?? "income", speedupPolicy: options.speedupPolicy ?? "none",
      ownerPublicId: options.ownerPublicId ?? "0000-0000-0001", neighborPolicy: options.neighborPolicy ?? "none", relicPolicy: options.relicPolicy ?? "none",
      useMeals: options.useMeals ?? true, buySupplies: options.buySupplies ?? true, opportunisticRoutes: options.opportunisticRoutes ?? true,
    };
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, row[key]])), expected, `${row.id} metadata must describe the actual runner options`);
  }
});

test("summary ranges never mix paid capacity, altered action speed or disabled-food controls", () => {
  const base = { ...report().scenarios[0], goal: "home-5", visitsPerDay: 3, regularMinutes: 30, completed: true,
    slotPolicy: "earned", socialMode: "income", home5Days: 31 };
  const summaries = scenarioHighlights({ ...report(), scenarios: [base, { ...base, seed: 42, home5Days: 33 },
    { ...base, externalPearls: 1750, home5Days: 4 }, { ...base, manualSeconds: 1, home5Days: 3 }, { ...base, useMeals: false, home5Days: 99 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(summaries)), [{ title: "Дом 5 · 3 × 30 минут", minimum: 31, maximum: 33, count: 2 }]);
});


test("capacity and renewable budgets remain visible separately from building and permanent-rank goals", () => {
  const value = compactProgressionReport({ ...source, scenarios: [{ ...row, completionGoal: "all-capacity",
    productionSlots: { garden: 2, woodlot: 3 }, marketSlots: 7, allProductionSlotsDays: null, allCapacityDays: null,
    relicPolicy: "earned", coins: 400, coinLedger: { credits: { orders: 1000 }, debits: { buildings: 700 } },
    calendarSnapshots: [{ day: 1, coins: 400, pearls: 50, coinLedger: { credits: { orders: 1000 }, debits: { buildings: 700 } },
      pearlLedger: { credits: { achievements: 200 }, debits: { slots: 150 } } }],
  }] }, economy, rewards);
  assert.equal(progressionScenarioReportSchema.safeParse(value).success, true);
  assert.equal(value.scenarios[0].calendarSnapshots[0].pearls, 25);
  assert.equal(value.scenarios[0].calendarSnapshots[0].pearlIncome, 100);
  assert.equal(value.scenarios[0].coinSpending.buildings, 700);
  assert.equal(value.scenarios[0].allCapacityDays, null);
  const text = html(value);
  assert.match(text, /Хозяйство, ранги и все места/);
  assert.match(text, /Торговые места/);
  assert.match(text, /Бюджет по календарным дням/);
  assert.match(text, /недельные поручения продолжают приносить жемчуг/);
});

test("free earned speedups have their own highlights and never inherit external-funded results", () => {
  const base = { ...report().scenarios[0], goal: "home-5", visitsPerDay: 1, regularMinutes: 960, completed: true,
    slotPolicy: "earned", socialMode: "income", speedupPolicy: "earned", home5Days: 7 };
  const highlights = scenarioHighlights({ ...report(), scenarios: [base, { ...base, seed: 42, home5Days: 8 },
    { ...base, externalPearls: 1750, home5Days: 2 }, { ...base, relicPolicy: "earned", home5Days: 1 },
    { ...base, ownerPublicId: "0000-0000-0002", home5Days: 3 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(highlights)), [{ title: "Дом 5 · 16 ч · бесплатные ускорения", minimum: 7, maximum: 8, count: 2 }]);
});
