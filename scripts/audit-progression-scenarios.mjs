import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProgressionRules, simulateProgression, summarizeProgression } from "./simulate-economy-progression.mjs";

export const progressionCases = [
  { label: "free-15m", regularActiveMinutes: 15, firstVisitMinutes: 45 },
  { label: "free-20m-seed1", regularActiveMinutes: 20, seed: 1 },
  { label: "free-20m-seed7", regularActiveMinutes: 20, seed: 7 },
  { label: "free-20m-seed42", regularActiveMinutes: 20, seed: 42 },
  { label: "free-30m", regularActiveMinutes: 30 },
  { label: "hardcore-60m", regularActiveMinutes: 60 },
  { label: "external-slots-20m-seed1", regularActiveMinutes: 20, externalSlotBudget: 3500, seed: 1 },
  { label: "external-slots-20m-seed7", regularActiveMinutes: 20, externalSlotBudget: 3500, seed: 7 },
  { label: "external-slots-20m-seed42", regularActiveMinutes: 20, externalSlotBudget: 3500, seed: 42 },
  { label: "external-slots-30m", regularActiveMinutes: 30, externalSlotBudget: 3500 },
  { label: "manual-1s", regularActiveMinutes: 20, manualSeconds: 1 },
  { label: "manual-4s", regularActiveMinutes: 20, manualSeconds: 4 },
  { label: "second-slots-only", regularActiveMinutes: 20, slotPolicy: "second-only" },
  { label: "without-meals", regularActiveMinutes: 20, useMeals: false },
];
export async function runProgressionScenarios({ sourceRoot = fileURLToPath(new URL("..", import.meta.url)), cases = progressionCases, onResult } = {}) {
  const source = resolve(sourceRoot), loaded = await loadProgressionRules(source), scenarios = [];
  const catalogBytes = await readFile(resolve(source, "apps/api/src/main/resources/world/economy-catalog.json"));
  const rewardsBytes = await readFile(resolve(source, "apps/api/src/main/resources/world/progression-rewards-catalog.json"));
  try {
    for (const options of cases) {
      const result = { label: options.label, ...summarizeProgression(simulateProgression(loaded, options)) };
      scenarios.push(result); await onResult?.(result);
    }
    return { schemaVersion: 1, economyVersion: loaded.catalog.version,
      economySha256: createHash("sha256").update(catalogBytes).digest("hex"), rewardsSha256: createHash("sha256").update(rewardsBytes).digest("hex"),
      policy: { visitsPerDay: 3, visitIntervalHours: 8, firstVisitMinutes: 60, defaultManualSeconds: 2,
        completion: "Home at catalog maximum, claimed: same condition as WorldHomeFinale",
        rewards: "Actual one-time welcome, eligible tutorial, seven home-tier gifts on canonical cooldown, earned economy achievements. No external social/tap/market achievements.",
        slots: "Buy all second slots before third slots; workshop, woodlot, garden, kiln, dryer priority. Each purchase uses actual domain command and pearl debit.",
        externalSlots: "Alternative stress case adds 3500 stored = 1750 visible pearls explicitly from outside. This is not free progression or an enabled payment claim.",
        production: "Manually start one item per slot; prepare at most owned-slot capacity of current visible requirements. No automatic restart or future-order knowledge.",
        income: "Current visible ordinary orders, spare single-item mining, and basic fishing sold via actual NPC commands. No invented market buyers or tap income.",
        food: "Use owned optional meals after reserving visible order/build/recipe needs. Does not optimize a dedicated cooking strategy.",
        limits: "Deterministic strategy, not population forecast. Two seconds per command is an explicit attention assumption tested at one and four seconds. Earliest source definitions are chosen locally; this is not an optimal speedrun." }, scenarios };
  } finally { await loaded.close(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const labels = process.env.SIM_CASES?.split(",");
  const report = await runProgressionScenarios({ sourceRoot: process.env.ECONOMY_SOURCE_ROOT,
    cases: labels ? progressionCases.filter(row => labels.includes(row.label)) : progressionCases,
    onResult: result => { if (process.env.SIM_OUTPUT) process.stderr.write(`${result.label}: ${result.completed ? result.home5Days.toFixed(2) : "unfinished"} days, ${result.commandCount} commands\n`); } });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.SIM_OUTPUT) await writeFile(resolve(process.env.SIM_OUTPUT), json); else process.stdout.write(json);
}
