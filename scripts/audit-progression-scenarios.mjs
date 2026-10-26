import assert from "node:assert/strict";
import { progressionSourceDigests } from "./lib/progression-report-integrity.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProgressionRules, simulateProgression, summarizeProgression } from "./simulate-economy-progression.mjs";

export const progressionCases = [
  { label: "once-20m-strict", visitsPerDay: 1, regularActiveMinutes: 20, firstVisitMinutes: 20, maxDays: 240 },
  { label: "once-20m", visitsPerDay: 1, regularActiveMinutes: 20, maxDays: 240 },
  { label: "free-15m", regularActiveMinutes: 15, firstVisitMinutes: 45 },
  { label: "free-20m-seed1", regularActiveMinutes: 20, seed: 1 },
  { label: "free-20m-seed7", regularActiveMinutes: 20, seed: 7 },
  { label: "free-20m-seed42", regularActiveMinutes: 20, seed: 42 },
  { label: "free-30m", regularActiveMinutes: 30 },
  { label: "hardcore-60m", regularActiveMinutes: 60 },
  { label: "active-4h", visitsPerDay: 1, regularActiveMinutes: 240, firstVisitMinutes: 240 },
  { label: "active-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480 },
  { label: "active-16h", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960 },
  { label: "production-max-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, completionGoal: "all-production" },
  { label: "recipes-max-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, completionGoal: "all-recipes" },
  { label: "balanced-30m-month", regularActiveMinutes: 30, socialMode: "balanced", completionGoal: "observation", maxDays: 30 },
  { label: "reputation-8h-month", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, socialMode: "reputation", completionGoal: "observation", maxDays: 30 },
  { label: "full-max-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, socialMode: "reputation", completionGoal: "full", maxDays: 240 },
  { label: "full-max-16h", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, socialMode: "reputation", completionGoal: "full", maxDays: 240 },
  { label: "full-max-8h-seed7", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, socialMode: "reputation", completionGoal: "full", maxDays: 240, seed: 7 },
  { label: "full-max-16h-seed7", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, socialMode: "reputation", completionGoal: "full", maxDays: 240, seed: 7 },
  { label: "full-max-8h-seed42", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, socialMode: "reputation", completionGoal: "full", maxDays: 240, seed: 42 },
  { label: "full-max-16h-seed42", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, socialMode: "reputation", completionGoal: "full", maxDays: 240, seed: 42 },
  { label: "external-slots-speedups-30m", regularActiveMinutes: 30, externalSlotBudget: 3500, speedupPolicy: "earned" },
  { label: "external-slots-speedups-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, externalSlotBudget: 3500, speedupPolicy: "earned" },
  { label: "external-slots-speedups-16h", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, externalSlotBudget: 3500, speedupPolicy: "earned" },
  { label: "free-30m-seed7", regularActiveMinutes: 30, seed: 7 },
  { label: "free-30m-seed42", regularActiveMinutes: 30, seed: 42 },
  { label: "no-supplies-30m", regularActiveMinutes: 30, buySupplies: false },
  { label: "external-slots-20m-seed1", regularActiveMinutes: 20, externalSlotBudget: 3500, seed: 1 },
  { label: "external-slots-20m-seed7", regularActiveMinutes: 20, externalSlotBudget: 3500, seed: 7 },
  { label: "external-slots-20m-seed42", regularActiveMinutes: 20, externalSlotBudget: 3500, seed: 42 },
  { label: "external-slots-30m", regularActiveMinutes: 30, externalSlotBudget: 3500 },
  { label: "manual-1s", regularActiveMinutes: 20, manualSeconds: 1 },
  { label: "manual-4s", regularActiveMinutes: 20, manualSeconds: 4 },
  { label: "second-slots-only", regularActiveMinutes: 20, slotPolicy: "second-only" },
  { label: "without-meals", regularActiveMinutes: 20, useMeals: false },
  ...[1, 7, 42].flatMap(seed => [
    { label: `earned-speedups-30m-seed${seed}`, regularActiveMinutes: 30, speedupPolicy: "earned", seed },
    { label: `earned-speedups-8h-seed${seed}`, visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, speedupPolicy: "earned", seed },
    { label: `earned-speedups-16h-seed${seed}`, visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, speedupPolicy: "earned", seed },
  ]),
  { label: "full-relics-30m", regularActiveMinutes: 30, socialMode: "reputation", slotPolicy: "second-only", relicPolicy: "earned", completionGoal: "full", maxDays: 365 },
  { label: "full-relics-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, socialMode: "reputation", slotPolicy: "second-only", relicPolicy: "earned", completionGoal: "full", maxDays: 240 },
  { label: "full-relics-16h", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, socialMode: "reputation", slotPolicy: "second-only", relicPolicy: "earned", completionGoal: "full", maxDays: 240 },
  { label: "all-capacity-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, socialMode: "reputation", completionGoal: "all-capacity", maxDays: 365 },
  { label: "free-30m-owner2", regularActiveMinutes: 30, ownerPublicId: "0000-0000-0002" },
  { label: "free-30m-owner3", regularActiveMinutes: 30, ownerPublicId: "0000-0000-0003" },
  { label: "full-max-30m", regularActiveMinutes: 30, socialMode: "reputation", completionGoal: "full", maxDays: 365 },
  { label: "neighbor-30m", regularActiveMinutes: 30, neighborPolicy: "auto" },
  { label: "neighbor-8h", visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480, neighborPolicy: "auto" },
  { label: "neighbor-16h", visitsPerDay: 1, regularActiveMinutes: 960, firstVisitMinutes: 960, neighborPolicy: "auto" },
  { label: "full-max-24h", visitsPerDay: 1, regularActiveMinutes: 1440, firstVisitMinutes: 1440, socialMode: "reputation", completionGoal: "full", maxDays: 240 },
];

export function compactProgressionEvidence(summary) {
  const deliveries = summary.social.deliveries;
  const deliveryTotals = {};
  for (const row of deliveries) {
    const total = deliveryTotals[row.residentId] ??= { ordinary: 0, weeklyStages: 0, xp: 0, coins: 0, pearls: 0, spentItems: {} };
    total[row.weekly ? "weeklyStages" : "ordinary"]++;
    for (const field of ["xp","coins","pearls"]) total[field] += row[field];
    for (const [id,count] of Object.entries(row.items)) total.spentItems[id] = (total.spentItems[id] ?? 0) + count;
  }
  return { ...summary,
    conservation: { coins: true, pearls: true, everyItem: true, warehouseCapacity: true, actorAndSlotCapacity: true },
    social: { ...summary.social, deliveries: undefined, deliveryCount: deliveries.length, deliveryTotals,
      deliverySamples: deliveries.length <= 6 ? deliveries : [...deliveries.slice(0,3), ...deliveries.slice(-3)] },
  };
}

export async function runProgressionScenarios({ sourceRoot = fileURLToPath(new URL("..", import.meta.url)), cases = progressionCases, onResult } = {}) {
  const source = resolve(sourceRoot), policyRoot = fileURLToPath(new URL("..", import.meta.url));
  const sourceSha256 = await progressionSourceDigests(source, {policyRoot});
  const loaded = await loadProgressionRules(source), scenarios = [];
  const catalogBytes = await readFile(resolve(source, "apps/api/src/main/resources/world/economy-catalog.json"));
  const rewardsBytes = await readFile(resolve(source, "apps/api/src/main/resources/world/progression-rewards-catalog.json"));
  try {
    for (const options of cases) {
      const result = { label: options.label, ...compactProgressionEvidence(summarizeProgression(simulateProgression(loaded, options))) };
      scenarios.push(result); await onResult?.(result);
    }
    assert.deepEqual(await progressionSourceDigests(source, {policyRoot}), sourceSha256, "Economic source changed during the run; rerun before publishing evidence");
    return { schemaVersion: 2, policyVersion: "v15-unified-1", generatedAt: new Date().toISOString(), releaseValidated: false, sourceSha256, economyVersion: loaded.catalog.version,
      economySha256: createHash("sha256").update(catalogBytes).digest("hex"), rewardsSha256: createHash("sha256").update(rewardsBytes).digest("hex"),
      policy: { defaultVisitsPerDay: 3, defaultVisitIntervalHours: 8, firstVisitMinutes: 60, defaultManualSeconds: 2,
        schedules: "Visits are evenly spaced during each day. Once-a-day 4/8/16/24h cases use one contiguous session. Active duration includes waiting inside visits; first visit 60 minutes unless explicitly overridden.",
        completion: "Separate milestones: claimed home5; all production buildings/landmarks at the actual catalog maximum (warehouse excluded); all buildings including warehouse 10; every active recipe produced and claimed; every resident at maximum permanent rank; all-capacity additionally requires every production and market slot. Full does not silently imply all paid capacity or permanently active friendship bonuses. Observation cases stop at a declared 30-day horizon without claiming completion.",
        rewards: "Actual one-time welcome, eligible tutorial, seven home-tier gifts on canonical cooldown, new-profile achievement course with earned economy achievements. No external social/tap achievements; NPC sensitivity cases can claim first-sale achievements only after actual confirmed Berest transactions.",
        slots: "Buy all second slots before third slots; workshop, woodlot, garden, kiln, dryer priority. Each purchase uses the actual domain command, confirmed price and pearl debit. All-capacity buys market places after production places; it continues earning weekly rewards after ranks are complete.",
        externalSlots: "Alternative stress case adds 3500 stored = 1750 visible pearls explicitly from outside. This is not free progression or an enabled payment claim.",
        production: "Manually start one item per slot; prepare at most owned-slot capacity of current visible requirements. No automatic restart or future-order knowledge.",
        income: "Current visible ordinary orders, spare mining, basic fishing and actual NPCsales. Useful material expeditions use public guaranteed outputs; private finds are not inspected. Leaftail dated supplies may be bought with coins above the next known building or gear budget. Explicit relic-policy cases spend actually earned pearls on dated personal offers for a currently missing building relic, after home5; second-only policy preserves funds by foregoing third places. No invented market buyers or tap income. Explicit neighbor cases produce real goods, post lots at current safe quotes, observe automatic waits and per-player budgets, pay the ordinary fee and manually claim proceeds through the existing DEV transaction implementation. Global competition for the NPC budget is not modeled.",
        social: "Balanced and reputation modes execute actual funded requests and weekly contracts; stock is produced by the same account, never injected. Other modes record naturally earned reputation from income requests and eligible purchases.",
        speedups: "Explicit earned-speedups cases spend remaining legitimately earned pearls on construction speedups after prioritized slot purchases without external funding; they are legal free-play strategies. External 3500 raw pearls pays the full slot budget; future slot costs remain reserved and real payments remain disabled.",
        food: "Use owned optional meals after reserving visible order/build/recipe needs. Does not optimize a dedicated cooking strategy.",
        limits: "Deterministic strategy, not population forecast. Two seconds per command is an explicit attention assumption tested at one and four seconds. Synthetic owner IDs vary only personal stock; ordinary-order replacements are not used. Earliest source definitions are chosen locally; this is not an optimal speedrun." }, scenarios };
  } finally { await loaded.close(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const labels = process.env.SIM_CASES?.split(",");
  if (labels) for (const label of labels) assert(progressionCases.some(row => row.label === label), `Unknown scenario: ${label}`);
  const report = await runProgressionScenarios({ sourceRoot: process.env.ECONOMY_SOURCE_ROOT,
    cases: labels ? progressionCases.filter(row => labels.includes(row.label)) : progressionCases,
    onResult: result => { if (process.env.SIM_OUTPUT) process.stderr.write(`${result.label}: ${result.completed ? result.elapsedDays.toFixed(2) : "unfinished"} days; home5=${result.home5Days?.toFixed(2) ?? "unreached"}, ${result.commandCount} commands\n`); } });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.SIM_OUTPUT) await writeFile(resolve(process.env.SIM_OUTPUT), json); else process.stdout.write(json);
}
