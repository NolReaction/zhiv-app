import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { progressionCatalogFingerprint, progressionSourceDigests } from "./lib/progression-report-integrity.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const progressionReportPath = "features/progression/data/progression-scenarios.json";
const finite = (value, label) => {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0, `Invalid ${label}`);
  return value;
};
const milestone = (value, label) => value === null || value === undefined ? null : finite(value, label);

/** Small public projection. Never include item ledgers, account data or synthetic results. */
export function compactProgressionReport(source, economy, rewards) {
  assert.equal(source.schemaVersion, 2, "Only the unified scenario schema may be published");
  assert.equal(typeof source.policyVersion, "string");
  assert(source.policyVersion.length > 0 && source.scenarios.length > 0, "No final scenarios supplied");
  const labels = new Set();
  const scenarios = source.scenarios.map(row => {
    assert(typeof row.label === "string" && !labels.has(row.label), "Scenario labels must be unique"); labels.add(row.label);
    assert.equal(typeof row.completed, "boolean");
    const result = {
      id: row.label, completed: row.completed, goal: row.completionGoal ?? "home-5",
      seed: finite(row.seed, "seed"), visitsPerDay: finite(row.visitsPerDay, "visits/day"),
      regularMinutes: finite(row.regularMinutes, "visit minutes"), firstMinutes: finite(row.firstMinutes, "first visit minutes"),
      manualSeconds: finite(row.manualSeconds, "seconds/action"), slotPolicy: row.slotPolicy ?? "earned",
      useMeals: row.useMeals !== false, buySupplies: row.buySupplies !== false, opportunisticRoutes: row.opportunisticRoutes !== false,
      speedupPolicy: row.speedupPolicy ?? "none", socialMode: row.socialMode ?? "income", maxDays: row.maxDays ?? null,
      externalPearls: finite(row.externalSlotBudget ?? 0, "external pearls") / 2,
      elapsedDays: finite(row.elapsedDays, "elapsed days"), activeHours: finite(row.activeHours, "active hours"),
      manualHours: finite(row.manualHours, "manual hours"), commandCount: finite(row.commandCount, "commands"),
      home5Days: milestone(row.home5Days, "home 5"), allProductionDays: milestone(row.allProductionDays, "production maximum"),
      allBuildingsDays: milestone(row.allBuildingsDays, "building maximum"), allRecipesDays: milestone(row.allRecipesDays, "all recipes"),
      reputationMaxDays: milestone(row.reputationMaxDays, "reputation maximum"),
      buildings: row.buildings ?? {},
      social: row.social ? { mode: row.social.mode, funded: row.social.funded === true, maximumXp: row.social.maximumXp,
        reputation: row.social.reputation, bonusPercent: row.social.bonusPercent, allMaximum: row.social.allMaximum === true,
        completedWeekly: row.social.completedWeekly, ordinaryOrdersCompleted: row.social.ordinaryOrdersCompleted ?? 0, acceptedWeeklyCount: row.social.acceptedWeeklies?.length ?? 0,
        expiredWeeklyCount: row.social.expiredWeeklies?.length ?? 0, deliveryCount: row.social.deliveryCount ?? row.social.deliveries?.length ?? 0 } : null,
      pearlIncome: Object.fromEntries(Object.entries(row.pearlLedger?.credits ?? {}).map(([key, value]) => [key, finite(value, `pearl income ${key}`) / 2])),
      pearlSpending: Object.fromEntries(Object.entries(row.pearlLedger?.debits ?? {}).map(([key, value]) => [key, finite(value, `pearl spending ${key}`) / 2])),
      pearlsRemaining: finite(row.pearls ?? 0, "remaining pearls") / 2,
    };
    assert(result.visitsPerDay > 0 && result.regularMinutes > 0 && result.manualSeconds > 0);
    assert(result.manualHours <= result.activeHours + 1 / 3600, "Manual time cannot exceed active time");
    for (const key of ["home5Days", "allProductionDays", "allBuildingsDays", "allRecipesDays", "reputationMaxDays"])
      assert(result[key] === null || result[key] <= result.elapsedDays + 1 / 86400, `${key} is after the end of the run`);
    return result;
  });
  return { schemaVersion: 1, status: "ready", releaseValidated: source.releaseValidated === true,
    generatedAt: source.generatedAt ?? null, economyVersion: source.economyVersion,
    policyVersion: source.policyVersion, catalogFingerprint: progressionCatalogFingerprint(economy, rewards),
    sourceSha256: source.sourceSha256, evidencePath: "docs/game/economy-v14-final-scenarios.json",
    policy: source.policy, scenarios };
}

export async function buildProgressionReport({ sourcePath = "docs/game/economy-v14-final-scenarios.json", check = false, repositoryRoot = root } = {}) {
  const source = JSON.parse(await readFile(resolve(repositoryRoot, sourcePath), "utf8"));
  const economyBytes = await readFile(resolve(repositoryRoot, "apps/api/src/main/resources/world/economy-catalog.json"));
  const rewardsBytes = await readFile(resolve(repositoryRoot, "apps/api/src/main/resources/world/progression-rewards-catalog.json"));
  for (const [name, bytes] of [["economySha256", economyBytes], ["rewardsSha256", rewardsBytes]])
    assert.equal(source[name], createHash("sha256").update(bytes).digest("hex"), `${name}: rerun after catalog changes`);
  assert.deepEqual(source.sourceSha256, await progressionSourceDigests(repositoryRoot), "Scenario source has changed: rerun before publishing evidence");
  const report = compactProgressionReport(source, JSON.parse(economyBytes), JSON.parse(rewardsBytes));
  const content = `${JSON.stringify(report, null, 2)}\n`, path = resolve(repositoryRoot, progressionReportPath);
  if (check) assert.equal(await readFile(path, "utf8"), content, "Public scenario report is stale: run node scripts/build-progression-report.mjs");
  else await writeFile(path, content);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = await buildProgressionReport({ check: process.argv.includes("--check"), sourcePath: process.env.SIM_REPORT_SOURCE });
  process.stdout.write(`Progression report: ${report.scenarios.length} scenarios, ${report.policyVersion}\n`);
}
