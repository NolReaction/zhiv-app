import { z } from "zod";
import economy from "@/apps/api/src/main/resources/world/economy-catalog.json";
import rewards from "@/apps/api/src/main/resources/world/progression-rewards-catalog.json";
import reportJson from "./data/progression-scenarios.json";
import { progressionCatalogFingerprint } from "./scenario-fingerprint";

const nonnegative = z.number().finite().nonnegative();
const count = nonnegative.int().safe();
const quantities = z.record(z.string(), nonnegative);
const milestone = nonnegative.nullable();
const scenarioSchema = z.object({
  id: z.string(), completed: z.boolean(), goal: z.string(), seed: count,
  visitsPerDay: count.positive(), regularMinutes: nonnegative.positive(), firstMinutes: nonnegative.positive(),
  manualSeconds: nonnegative.positive(), slotPolicy: z.string(), externalPearls: nonnegative,
  useMeals: z.boolean(), buySupplies: z.boolean(), opportunisticRoutes: z.boolean(), speedupPolicy: z.string(), socialMode: z.string(), maxDays: milestone,
  elapsedDays: nonnegative, activeHours: nonnegative, manualHours: nonnegative, commandCount: count,
  home5Days: milestone, allProductionDays: milestone, allBuildingsDays: milestone, allRecipesDays: milestone, reputationMaxDays: milestone,
  buildings: z.record(z.string(), count),
  social: z.object({ mode: z.string(), funded: z.boolean(), maximumXp: count,
    reputation: z.record(z.string(), count), bonusPercent: quantities, allMaximum: z.boolean(), completedWeekly: count,
    ordinaryOrdersCompleted: count, acceptedWeeklyCount: count, expiredWeeklyCount: count, deliveryCount: count }).strict().nullable(),
  pearlIncome: quantities, pearlSpending: quantities, pearlsRemaining: nonnegative,
}).strict();
export const progressionScenarioReportSchema = z.object({
  schemaVersion: count, status: z.enum(["pending", "ready"]), releaseValidated: z.boolean(), generatedAt: z.string().nullable(),
  economyVersion: count, policyVersion: z.string(), catalogFingerprint: z.string(), sourceSha256: z.record(z.string(), z.string()),
  evidencePath: z.string(), policy: z.record(z.string(), z.unknown()), scenarios: z.array(scenarioSchema),
}).strict();
export type ProgressionScenario = z.infer<typeof scenarioSchema>;
export type ProgressionScenarioReport = z.infer<typeof progressionScenarioReportSchema>;
// JSON unions infer absent ledger keys as optional undefined. Validate the actual
// sparse dictionaries instead of asserting that every inferred value is numeric.
export const progressionScenarioReport = progressionScenarioReportSchema.parse(reportJson);

export function scenarioReportState(report: ProgressionScenarioReport, currentFingerprint = progressionCatalogFingerprint(economy, rewards)) {
  if (report.status !== "ready" || report.scenarios.length === 0) return "pending";
  if (report.schemaVersion !== 1 || !report.policyVersion || report.catalogFingerprint !== currentFingerprint) return "stale";
  return report.releaseValidated ? "validated" : "review";
}

export const scenarioGoalNames: Record<string, string> = {
  "home-5": "Дом 5", "all-production": "Все производства", "all-buildings": "Все постройки", "all-recipes": "Все рецепты", "max-reputation": "Репутация всех жителей", "reputation": "Репутация всех жителей", "observation": "Наблюдение за развитием", "full": "Хозяйство, рецепты и репутация",
};
export const scenarioResidentNames: Record<string, string> = { builder: "Шишколап", lopukh: "Лопоух", kamneshmyg: "Камнешмыг", plesk: "Плёска", leaftail: "Листохвост" };
export function scenarioSchedule(row: Pick<ProgressionScenario, "visitsPerDay" | "regularMinutes">) {
  const duration = row.regularMinutes >= 60 && row.regularMinutes % 60 === 0 ? `${row.regularMinutes / 60} ч` : `${row.regularMinutes} мин`;
  return `${row.visitsPerDay} × ${duration} в день`;
}

/** Compare only the declared standard policy; sensitivity variants stay in the table. */
export function scenarioHighlights(report: ProgressionScenarioReport) {
  const standard = report.scenarios.filter(row => row.externalPearls === 0 && row.manualSeconds === 2
    && row.slotPolicy === "earned" && row.useMeals && row.buySupplies && row.opportunisticRoutes && row.speedupPolicy === "none");
  const definitions = [
    { title: "Дом 5 · 3 × 30 минут", goal: "home-5", visits: 3, minutes: 30, socialMode: "income", field: "home5Days" },
    { title: "Дом 5 · 8 часов в день", goal: "home-5", visits: 1, minutes: 480, socialMode: "income", field: "home5Days" },
    { title: "Все три цели · 8 часов", goal: "full", visits: 1, minutes: 480, socialMode: "reputation", field: "elapsedDays" },
    { title: "Все три цели · 16 часов", goal: "full", visits: 1, minutes: 960, socialMode: "reputation", field: "elapsedDays" },
  ] as const;
  return definitions.flatMap(definition => {
    const rows = standard.filter(row => row.completed && row.goal === definition.goal && row.visitsPerDay === definition.visits
      && row.regularMinutes === definition.minutes && row.socialMode === definition.socialMode && row[definition.field] !== null);
    if (!rows.length) return [];
    const values = rows.map(row => row[definition.field]!);
    return [{ title: definition.title, minimum: Math.min(...values), maximum: Math.max(...values), count: rows.length }];
  });
}

export function scenarioCsvRows(report: ProgressionScenarioReport): (string | number | null)[][] {
  return [
    ["policy", "catalog_version", "scenario", "goal", "completed", "seed", "visits_per_day", "minutes_per_visit", "first_visit_minutes", "seconds_per_action", "external_visible_pearls", "slot_policy", "observed_days", "home_5_days", "all_production_days", "all_buildings_days", "all_recipes_days", "max_reputation_days", "active_hours", "manual_hours", "commands", "use_meals", "buy_supplies", "useful_routes", "speedup_policy", "social_mode"],
    ...report.scenarios.map(row => [report.policyVersion, report.economyVersion, row.id, row.goal, row.completed ? 1 : 0, row.seed,
      row.visitsPerDay, row.regularMinutes, row.firstMinutes, row.manualSeconds, row.externalPearls, row.slotPolicy,
      row.elapsedDays, row.home5Days, row.allProductionDays, row.allBuildingsDays, row.allRecipesDays, row.reputationMaxDays,
      row.activeHours, row.manualHours, row.commandCount, row.useMeals ? 1 : 0, row.buySupplies ? 1 : 0, row.opportunisticRoutes ? 1 : 0, row.speedupPolicy, row.socialMode]),
  ];
}
