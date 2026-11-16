import { economyCatalog, type EconomyCatalog, type EconomyJob, type EconomyState } from "./model";
import { craftSkillIds, craftSkillsSchema, type CraftSkillId, type CraftSkills } from "./craft-skill-model";
export { craftSkillIds };
export type { CraftSkillId };
export const craftSkillNames: Record<CraftSkillId, string> = { cooking: "Кулинария", travel: "Путешествия", fishing: "Рыбалка", crafting: "Мастерская", smelting: "Обжиг", gathering: "Садоводство", forestry: "Лесные работы", mining: "Добыча", building: "Строительство" };

type SkillState = Pick<EconomyState, "progression"> & Partial<Pick<EconomyState, "buildings" | "workshopStarterClaimed">>;
export type BuildingSkillHistory = Pick<SkillState, "buildings" | "workshopStarterClaimed">;
type Recipe = EconomyCatalog["recipes"][number];
const MAX_SECONDS = 31_536_000;
/** New/reset careers are already current: later grants cannot manufacture old work. */
export const newCraftSkills = (): CraftSkills => craftSkillsSchema.parse({ buildingHistoryVersion: 1 });
/** A read-only estimate from owned levels; pending jobs and initial structures do not count. */
export function effectiveCraftSkills(state: SkillState, catalog = economyCatalog): CraftSkills {
  const saved = craftSkillsSchema.parse(state.progression?.skills ?? {});
  if (saved.buildingHistoryVersion === 1 || !state.buildings) return saved;
  const historical = catalog.buildings.reduce((sum, building) => sum + building.levels.reduce((work, level) => {
    if (level.level > (state.buildings?.[building.id] ?? 0)
      || level.level === 1 && (["home", "garden", "warehouse"].includes(building.id)
        || building.id === "workshop" && state.workshopStarterClaimed)) return work;
    return work + level.seconds;
  }, 0), 0);
  return { ...saved, buildingHistoryVersion: 1, buildingSeconds: Math.min(MAX_SECONDS, Math.max(saved.buildingSeconds, historical)) };
}
export function skillProgress(state: SkillState, skill: CraftSkillId, catalog = economyCatalog) {
  const levels = catalog.skills?.levels ?? [{ requiredSeconds: 0, cookingBonusBps: 0, travelSpeedBps: 0, workSpeedBps: 0 }];
  const workSeconds = skill === "building" ? effectiveCraftSkills(state, catalog).buildingSeconds : state.progression?.skills?.[`${skill}Seconds`] ?? 0;
  const divisor = skill === "building" ? catalog.skills?.buildingPracticeDivisor ?? 1 : 1;
  const threshold = (seconds: number) => Math.ceil(seconds / divisor);
  const index = Math.max(0, levels.findLastIndex(level => workSeconds >= threshold(level.requiredSeconds)));
  const level = levels[index], next = levels[index + 1];
  return { level: index + 1, workSeconds, levelSeconds: threshold(level.requiredSeconds), nextLevelSeconds: next ? threshold(next.requiredSeconds) : null,
    progress: next ? (workSeconds - threshold(level.requiredSeconds)) / (threshold(next.requiredSeconds) - threshold(level.requiredSeconds)) : 1,
    bonusBps: skill === "cooking" ? level.cookingBonusBps : skill === "travel" ? level.travelSpeedBps : level.workSpeedBps };
}
export function experimentSuccessBps(state: SkillState, recipe: Recipe, catalog = economyCatalog) {
  return recipe.experiment ? Math.min(9500, recipe.experiment.successBps + skillProgress(state, "cooking", catalog).bonusBps) : 10000;
}
export function experimentDiscovered(state: SkillState, recipe: Recipe) {
  return !recipe.experiment || (state.progression?.recipes?.[recipe.id] ?? 0) > 0;
}
export function experimentCanPractice(state: SkillState, recipe: Recipe, catalog = economyCatalog) {
  return !recipe.experiment || skillProgress(state, "cooking", catalog).level >= recipe.experiment.requiredCookingLevel;
}
export function skillForProduction(buildingId: string): CraftSkillId | undefined {
  return ({ dryer: "cooking", workshop: "crafting", kiln: "smelting", garden: "gathering", woodlot: "forestry" } as Record<string, CraftSkillId>)[buildingId];
}
export function skillForExploration(route: EconomyCatalog["explorations"][number], catalog = economyCatalog): CraftSkillId {
  return route.activity === "mining" || route.id.startsWith("quarry_") ? "mining" : catalog.fishing?.routeIds.includes(route.id) ? "fishing" : "travel";
}
/** Bonuses shorten work only. Inputs, yields, fish odds and practice stay unchanged. */
export function skillWorkDuration(state: SkillState, skill: CraftSkillId | undefined, seconds: number, catalog = economyCatalog) {
  const bonus = skill && skill !== "cooking" ? skillProgress(state, skill, catalog).bonusBps : 0;
  return Number((BigInt(Math.ceil(seconds)) * BigInt(10000) + BigInt(10000 + bonus) - BigInt(1)) / BigInt(10000 + bonus));
}
export function mergeCraftSkills(first?: CraftSkills, second?: CraftSkills): CraftSkills | undefined {
  if (!first && !second) return undefined;
  const merged = craftSkillsSchema.parse({ ...((!first || first.buildingHistoryVersion === 1) && (!second || second.buildingHistoryVersion === 1) ? { buildingHistoryVersion: 1 } : {}) });
  // A merge must not multiply the same career or replay a cooking-result banner.
  for (const skill of craftSkillIds) merged[`${skill}Seconds`] = Math.max(first?.[`${skill}Seconds`] ?? 0, second?.[`${skill}Seconds`] ?? 0);
  return merged;
}
/** Called after a successful atomic claim. Starting, purchases and cancellation never train. */
export function awardCraftSkills(beforeJobs: readonly EconomyJob[], state: EconomyState, action: string, now: number) {
  if (!["claim_job", "claim_production", "claim_garden_collection", "claim_mining_batch", "speedup_construction"].includes(action)) return;
  const skills = craftSkillsSchema.parse(state.progression.skills ?? {});
  let trained = false;
  for (const job of beforeJobs) {
    if (action === "speedup_construction" && job.kind !== "construction") continue;
    const remaining = state.jobs.find(current => current.id === job.id);
    const units = job.miningBatch ? (remaining?.miningBatch?.claimed ?? job.miningBatch.quantity) - job.miningBatch.claimed : remaining ? 0 : 1;
    if (units <= 0) continue;
    const recipe = job.kind === "production" ? economyCatalog.recipes.find(recipe => recipe.id === job.recipeId) : undefined;
    const route = job.kind === "exploration" ? economyCatalog.explorations.find(route => route.id === job.targetId) : undefined;
    const skill = job.kind === "construction" ? "building" : recipe ? skillForProduction(recipe.buildingId) : route ? skillForExploration(route) : undefined;
    if (!skill) continue;
    const legacyBatches = recipe ? Math.max(1, Math.min(...Object.entries(recipe.rewards).filter(([, amount]) => amount > 0)
      .map(([id, amount]) => Math.floor((job.rewards[id] ?? 0) / amount)))) : 1;
    const construction = job.kind === "construction" ? economyCatalog.buildings.find(building => building.id === job.targetId)?.levels.find(level => level.level === job.targetLevel) : undefined;
    // Old instant tutorial crops and earmarked free construction never buy practice.
    const legacyTutorial = recipe && Date.parse(job.finishesAt) - Date.parse(job.startedAt) < 1000 || construction && job.cost.coins === 0 && Object.keys(job.cost.items).length === 0;
    const seconds = (job.skillWorkSeconds ?? job.cooking?.workSeconds ?? (legacyTutorial ? 0 : recipe ? recipe.seconds * legacyBatches : route?.seconds ?? construction?.seconds ?? 0)) * units;
    if (!seconds) continue;
    const key = `${skill}Seconds` as const;
    skills[key] = Math.min(MAX_SECONDS, skills[key] + seconds); trained = true;
    if (job.cooking && typeof job.cooking.successful === "boolean" && job.recipeId)
      skills.lastCooking = { jobId: job.id, recipeId: job.recipeId, successful: job.cooking.successful, at: new Date(now).toISOString() };
  }
  if (trained) state.progression = { ...state.progression, skills };
}

export function prepareCookingAttempt(state: SkillState, recipe: Recipe, random: (maximum: number) => number) {
  if (!recipe.experiment) return undefined;
  const successChanceBps = experimentSuccessBps(state, recipe);
  const ticket = random(10000);
  if (!Number.isInteger(ticket) || ticket < 0 || ticket >= 10000) throw new Error("Invalid trusted cooking draw");
  return { successChanceBps, workSeconds: recipe.seconds, successful: ticket < successChanceBps };
}
