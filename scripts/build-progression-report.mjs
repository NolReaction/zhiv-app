import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { progressionCatalogFingerprint, progressionSourceDigests } from "./lib/progression-report-integrity.mjs";
import { applyProgressionRerunReceipt, createProgressionRerunReceipt, progressionEvidencePath, progressionRerunReceiptPath } from "./lib/progression-rerun-receipt.mjs";

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
    for (const [currency, ledger, balance] of [["coins", row.coinLedger, row.coins], ["pearls", row.pearlLedger, row.pearls]]) {
      if (ledger?.initial == null) continue;
      const sum = entries => Object.values(entries).reduce((total, value) => total + finite(value, `${currency} ledger`), 0);
      assert.equal(balance, finite(ledger.initial, `${currency} initial`) + sum(ledger.credits) - sum(ledger.debits), `${row.label}: ${currency} ledger does not balance`);
    }
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
      ownerPublicId: row.ownerPublicId ?? "0000-0000-0001", neighborPolicy: row.neighborPolicy ?? "none",
      neighborSales: row.neighbor?.sales.length ?? 0, neighborProceeds: row.neighbor?.sales.reduce((sum, sale) => sum + sale.proceedsCoins, 0) ?? 0,
      relicPolicy: row.relicPolicy ?? "none", exchangePolicy: row.exchangePolicy ?? "duplicates",
      relicExchanges: row.relicExchanges?.length ?? 0, exchangeCoins: row.relicExchanges?.reduce((sum, exchange) => sum + exchange.paidCoins, 0) ?? 0,
      allProductionSlotsDays: milestone(row.allProductionSlotsDays, "production slots"), allCapacityDays: milestone(row.allCapacityDays, "all paid capacity"),
      productionSlots: row.productionSlots ?? {}, marketSlots: row.marketSlots ?? economy.market.baseSlots,
      coinsRemaining: finite(row.coins ?? 0, "remaining coins"),
      coinIncome: Object.fromEntries(Object.entries(row.coinLedger?.credits ?? {}).map(([key, value]) => [key, finite(value, `coin income ${key}`)])),
      coinSpending: Object.fromEntries(Object.entries(row.coinLedger?.debits ?? {}).map(([key, value]) => [key, finite(value, `coin spending ${key}`)])),
      calendarSnapshots: (row.calendarSnapshots ?? []).map(snapshot => ({ day: finite(snapshot.day, "snapshot day"),
        coins: finite(snapshot.coins, "snapshot coins"), pearls: finite(snapshot.pearls, "snapshot pearls") / 2,
        coinIncome: Object.values(snapshot.coinLedger.credits).reduce((sum, value) => sum + finite(value, "snapshot coin income"), 0),
        coinSpending: Object.values(snapshot.coinLedger.debits).reduce((sum, value) => sum + finite(value, "snapshot coin spending"), 0),
        pearlIncome: Object.values(snapshot.pearlLedger.credits).reduce((sum, value) => sum + finite(value, "snapshot pearl income"), 0) / 2,
        pearlSpending: Object.values(snapshot.pearlLedger.debits).reduce((sum, value) => sum + finite(value, "snapshot pearl spending"), 0) / 2,
      })),
      buildings: row.buildings ?? {},
      social: row.social ? { mode: row.social.mode, funded: row.social.funded === true, maximumXp: row.social.maximumXp,
        reputation: row.social.reputation, bonusPercent: row.social.bonusPercent, activityPercent: row.social.activityPercent ?? {}, rankBonusPercent: row.social.rankBonusPercent ?? {}, allMaximum: row.social.allMaximum === true,
        completedWeekly: row.social.completedWeekly, ordinaryOrdersCompleted: row.social.ordinaryOrdersCompleted ?? 0, acceptedWeeklyCount: row.social.acceptedWeeklies?.length ?? 0,
        expiredWeeklyCount: row.social.expiredWeeklies?.length ?? 0, deliveryCount: row.social.deliveryCount ?? row.social.deliveries?.length ?? 0 } : null,
      pearlIncome: Object.fromEntries(Object.entries(row.pearlLedger?.credits ?? {}).map(([key, value]) => [key, finite(value, `pearl income ${key}`) / 2])),
      pearlSpending: Object.fromEntries(Object.entries(row.pearlLedger?.debits ?? {}).map(([key, value]) => [key, finite(value, `pearl spending ${key}`) / 2])),
      pearlsRemaining: finite(row.pearls ?? 0, "remaining pearls") / 2,
    };
    assert(result.visitsPerDay > 0 && result.regularMinutes > 0 && result.manualSeconds > 0);
    assert(result.manualHours <= result.activeHours + 1 / 3600, "Manual time cannot exceed active time");
    for (const key of ["home5Days", "allProductionDays", "allBuildingsDays", "allRecipesDays", "reputationMaxDays", "allProductionSlotsDays", "allCapacityDays"])
      assert(result[key] === null || result[key] <= result.elapsedDays + 1 / 86400, `${key} is after the end of the run`);
    let previousSnapshotDay = 0;
    for (const snapshot of result.calendarSnapshots) {
      assert(snapshot.day > previousSnapshotDay && snapshot.day <= result.elapsedDays, "Calendar snapshots must be ordered and within the observed run");
      previousSnapshotDay = snapshot.day;
    }
    if (result.completed && ["full", "all-capacity"].includes(result.goal))
      assert(result.allBuildingsDays !== null && result.allRecipesDays !== null && result.reputationMaxDays !== null,
        "A completed full goal requires buildings, recipes and permanent ranks");
    if (result.completed && result.goal === "all-capacity") {
      const stations = [...new Set(economy.recipes.filter(recipe => !recipe.retired).map(recipe => recipe.buildingId))];
      const maximumSlots = Math.max(...economy.productionSlots.upgrades.map(offer => offer.slots));
      assert(result.allCapacityDays !== null && result.marketSlots === economy.market.maxListings
        && stations.every(id => result.productionSlots[id] === maximumSlots), "A completed capacity goal must own every production and market place");
    }
    return result;
  });
  return { schemaVersion: 1, status: "ready", releaseValidated: source.releaseValidated === true,
    generatedAt: source.generatedAt ?? null, economyVersion: source.economyVersion,
    policyVersion: source.policyVersion, catalogFingerprint: progressionCatalogFingerprint(economy, rewards),
    sourceSha256: source.sourceSha256, evidencePath: "docs/game/economy-v15-final-scenarios.json",
    policy: source.policy, scenarios };
}

export async function readResolvedProgressionEvidence({ sourcePath = progressionEvidencePath, repositoryRoot = root } = {}) {
  const bytes = await readFile(resolve(repositoryRoot, sourcePath));
  if (sourcePath === progressionEvidencePath) {
    let receipt;
    try { receipt = JSON.parse(await readFile(resolve(repositoryRoot, progressionRerunReceiptPath), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (receipt !== undefined) return applyProgressionRerunReceipt(bytes, receipt);
  }
  return JSON.parse(bytes.toString());
}

export async function buildProgressionReport({ sourcePath = progressionEvidencePath, check = false, repositoryRoot = root, adoptIdenticalRun } = {}) {
  assert(!(check && adoptIdenticalRun), "Cannot adopt a rerun during a read-only check");
  assert(!adoptIdenticalRun || sourcePath === progressionEvidencePath, "Only the canonical baseline may adopt an identical rerun");
  let receipt;
  if (adoptIdenticalRun) receipt = createProgressionRerunReceipt(await readFile(resolve(repositoryRoot, sourcePath)),
    await readFile(resolve(repositoryRoot, adoptIdenticalRun)));
  const source = receipt ? applyProgressionRerunReceipt(await readFile(resolve(repositoryRoot, sourcePath)), receipt)
    : await readResolvedProgressionEvidence({ sourcePath, repositoryRoot });
  const economyBytes = await readFile(resolve(repositoryRoot, "apps/api/src/main/resources/world/economy-catalog.json"));
  const rewardsBytes = await readFile(resolve(repositoryRoot, "apps/api/src/main/resources/world/progression-rewards-catalog.json"));
  for (const [name, bytes] of [["economySha256", economyBytes], ["rewardsSha256", rewardsBytes]])
    assert.equal(source[name], createHash("sha256").update(bytes).digest("hex"), `${name}: rerun after catalog changes`);
  assert.deepEqual(source.sourceSha256, await progressionSourceDigests(repositoryRoot), "Scenario source has changed: rerun before publishing evidence");
  const report = compactProgressionReport(source, JSON.parse(economyBytes), JSON.parse(rewardsBytes));
  const content = `${JSON.stringify(report, null, 2)}\n`, path = resolve(repositoryRoot, progressionReportPath);
  if (check) assert.equal(await readFile(path, "utf8"), content, "Public scenario report is stale: run node scripts/build-progression-report.mjs");
  else {
    // Do not persist a receipt until current-source, catalog and full projection checks pass.
    if (receipt) await writeFile(resolve(repositoryRoot, progressionRerunReceiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
    await writeFile(path, content);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const adoptIdenticalRun = process.argv.find(value => value.startsWith("--adopt-identical-run="))?.slice("--adopt-identical-run=".length);
  const report = await buildProgressionReport({ check: process.argv.includes("--check"), sourcePath: process.env.SIM_REPORT_SOURCE, adoptIdenticalRun });
  process.stdout.write(`Progression report: ${report.scenarios.length} scenarios, ${report.policyVersion}\n`);
}
