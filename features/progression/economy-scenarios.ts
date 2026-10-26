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
  ownerPublicId: z.string().default("0000-0000-0001"), neighborPolicy: z.string().default("none"), neighborSales: count.default(0), neighborProceeds: nonnegative.default(0), relicPolicy: z.string().default("none"),
  exchangePolicy: z.string().default("duplicates"), relicExchanges: count.default(0), exchangeCoins: nonnegative.default(0),
  allProductionSlotsDays: milestone.default(null), allCapacityDays: milestone.default(null),
  productionSlots: z.record(z.string(), count).default({}), marketSlots: count.default(economy.market.baseSlots),
  coinsRemaining: nonnegative.default(0), coinIncome: quantities.default({}), coinSpending: quantities.default({}),
  calendarSnapshots: z.array(z.object({ day: nonnegative, coins: nonnegative, pearls: nonnegative,
    coinIncome: nonnegative, coinSpending: nonnegative, pearlIncome: nonnegative, pearlSpending: nonnegative }).strict()).default([]),
  buildings: z.record(z.string(), count),
  social: z.object({ mode: z.string(), funded: z.boolean(), maximumXp: count,
    reputation: z.record(z.string(), count), bonusPercent: quantities, activityPercent: quantities.default({}), rankBonusPercent: quantities.default({}), allMaximum: z.boolean(), completedWeekly: count,
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
  "home-5": "Дом 5", "all-production": "Все производства", "all-buildings": "Все постройки", "all-recipes": "Все рецепты", "max-reputation": "Репутация всех жителей", "reputation": "Репутация всех жителей", "observation": "Наблюдение за развитием", "full": "Хозяйство, рецепты и ранги", "all-capacity": "Хозяйство, рецепты, ранги и все места",
};
export const scenarioResidentNames: Record<string, string> = { builder: "Шишколап", lopukh: "Лопоух", kamneshmyg: "Камнешмыг", plesk: "Плёска", leaftail: "Листохвост" };
export function scenarioSchedule(row: Pick<ProgressionScenario, "visitsPerDay" | "regularMinutes">) {
  const duration = row.regularMinutes >= 60 && row.regularMinutes % 60 === 0 ? `${row.regularMinutes / 60} ч` : `${row.regularMinutes} мин`;
  return `${row.visitsPerDay} × ${duration} в день`;
}

/** Keep differently funded and differently prioritized strategies in separate cards. */
export function scenarioHighlights(report: ProgressionScenarioReport) {
  const comparable = report.scenarios.filter(row => row.externalPearls === 0 && row.manualSeconds === 2
    && row.useMeals && row.buySupplies && row.opportunisticRoutes
    && row.exchangePolicy === "duplicates" && row.neighborPolicy === "none" && row.ownerPublicId === "0000-0000-0001");
  const standard = comparable.filter(row => row.slotPolicy === "earned" && row.relicPolicy === "none");
  const definitions = [
    { title: "Дом 5 · 3 × 30 минут", goal: "home-5", visits: 3, minutes: 30, socialMode: "income", field: "home5Days" },
    { title: "Дом 5 · 8 часов в день", goal: "home-5", visits: 1, minutes: 480, socialMode: "income", field: "home5Days" },
    { title: "Все три цели · 8 часов", goal: "full", visits: 1, minutes: 480, socialMode: "reputation", field: "elapsedDays" },
    { title: "Все три цели · 16 часов", goal: "full", visits: 1, minutes: 960, socialMode: "reputation", field: "elapsedDays" },
  ] as const;
  const accelerated = [
    { title: "Дом 5 · 3 × 30 мин · бесплатные ускорения", goal: "home-5", visits: 3, minutes: 30, socialMode: "income", field: "home5Days" },
    { title: "Дом 5 · 8 ч · бесплатные ускорения", goal: "home-5", visits: 1, minutes: 480, socialMode: "income", field: "home5Days" },
    { title: "Дом 5 · 16 ч · бесплатные ускорения", goal: "home-5", visits: 1, minutes: 960, socialMode: "income", field: "home5Days" },
  ] as const;
  const benchmarks = [...definitions.map(row => ({ ...row, speedup: "none" })), ...accelerated.map(row => ({ ...row, speedup: "earned" }))].flatMap(definition => {
    const rows = standard.filter(row => row.speedupPolicy === definition.speedup && row.completed && row.goal === definition.goal && row.visitsPerDay === definition.visits
      && row.regularMinutes === definition.minutes && row.socialMode === definition.socialMode && row[definition.field] !== null);
    if (!rows.length) return [];
    const values = rows.map(row => row[definition.field]!);
    return [{ title: definition.title, minimum: Math.min(...values), maximum: Math.max(...values), count: rows.length }];
  });
  const alternatives = [
    { title: "Все три цели · 8 ч · покупка реликвий", minutes: 480, goal: "full", slotPolicy: "second-only", relicPolicy: "earned" },
    { title: "Все три цели · 16 ч · покупка реликвий", minutes: 960, goal: "full", slotPolicy: "second-only", relicPolicy: "earned" },
    { title: "Все три цели и все места · 8 часов", minutes: 480, goal: "all-capacity", slotPolicy: "earned", relicPolicy: "none" },
  ].flatMap(definition => {
    const rows = comparable.filter(row => row.completed && row.visitsPerDay === 1 && row.regularMinutes === definition.minutes
      && row.socialMode === "reputation" && row.speedupPolicy === "none" && row.goal === definition.goal
      && row.slotPolicy === definition.slotPolicy && row.relicPolicy === definition.relicPolicy);
    return rows.length ? [{ title: definition.title, minimum: Math.min(...rows.map(row => row.elapsedDays)),
      maximum: Math.max(...rows.map(row => row.elapsedDays)), count: rows.length }] : [];
  });
  return [...benchmarks, ...alternatives];
}

export function scenarioCsvRows(report: ProgressionScenarioReport): (string | number | null)[][] {
  return [
    ["policy", "catalog_version", "scenario", "goal", "completed", "seed", "visits_per_day", "minutes_per_visit", "first_visit_minutes", "seconds_per_action", "external_visible_pearls", "slot_policy", "observed_days", "home_5_days", "all_production_days", "all_buildings_days", "all_recipes_days", "max_reputation_days", "active_hours", "manual_hours", "commands", "use_meals", "buy_supplies", "useful_routes", "speedup_policy", "social_mode", "owner_public_id", "relic_policy", "all_production_slots_days", "all_capacity_days", "market_slots", "remaining_coins", "remaining_visible_pearls", "neighbor_policy", "neighbor_sales", "neighbor_proceeds", "relic_exchange_policy", "relic_exchanges", "relic_exchange_coins"],
    ...report.scenarios.map(row => [report.policyVersion, report.economyVersion, row.id, row.goal, row.completed ? 1 : 0, row.seed,
      row.visitsPerDay, row.regularMinutes, row.firstMinutes, row.manualSeconds, row.externalPearls, row.slotPolicy,
      row.elapsedDays, row.home5Days, row.allProductionDays, row.allBuildingsDays, row.allRecipesDays, row.reputationMaxDays,
      row.activeHours, row.manualHours, row.commandCount, row.useMeals ? 1 : 0, row.buySupplies ? 1 : 0, row.opportunisticRoutes ? 1 : 0, row.speedupPolicy, row.socialMode, row.ownerPublicId, row.relicPolicy, row.allProductionSlotsDays, row.allCapacityDays, row.marketSlots, row.coinsRemaining, row.pearlsRemaining, row.neighborPolicy, row.neighborSales, row.neighborProceeds, row.exchangePolicy, row.relicExchanges, row.exchangeCoins]),
  ];
}
