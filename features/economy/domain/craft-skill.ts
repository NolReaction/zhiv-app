import { economyCatalog, type EconomyCatalog, type EconomyJob, type EconomyState } from "./model";
import type { CraftSkillId, CraftSkills } from "./craft-skill-model";

type SkillState = Pick<EconomyState, "progression">;
type Recipe = EconomyCatalog["recipes"][number];
const MAX_SECONDS = 31_536_000;
export function skillProgress(state: SkillState, skill: CraftSkillId, catalog = economyCatalog) {
  const levels = catalog.skills?.levels ?? [{ requiredSeconds: 0, cookingBonusBps: 0, travelSpeedBps: 0 }];
  const workSeconds = state.progression?.skills?.[skill === "cooking" ? "cookingSeconds" : "travelSeconds"] ?? 0;
  const index = Math.max(0, levels.findLastIndex(level => workSeconds >= level.requiredSeconds));
  const level = levels[index], next = levels[index + 1];
  return { level: index + 1, workSeconds, levelSeconds: level.requiredSeconds, nextLevelSeconds: next?.requiredSeconds ?? null,
    progress: next ? (workSeconds - level.requiredSeconds) / (next.requiredSeconds - level.requiredSeconds) : 1,
    bonusBps: skill === "cooking" ? level.cookingBonusBps : level.travelSpeedBps };
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
export function mergeCraftSkills(first?: CraftSkills, second?: CraftSkills): CraftSkills | undefined {
  if (!first && !second) return undefined;
  // A merge must not multiply the same career or replay a cooking-result banner.
  return { version: 1, cookingSeconds: Math.max(first?.cookingSeconds ?? 0, second?.cookingSeconds ?? 0),
    travelSeconds: Math.max(first?.travelSeconds ?? 0, second?.travelSeconds ?? 0) };
}
/** Called after a successful atomic claim. Buying, starting and cancelling never train a skill. */
export function awardCraftSkills(beforeJobs: readonly EconomyJob[], state: EconomyState, action: string, now: number) {
  if (!["claim_job", "claim_production", "claim_garden_collection"].includes(action)) return;
  const removed = beforeJobs.filter(job => !state.jobs.some(current => current.id === job.id));
  const skills: CraftSkills = { version: 1, cookingSeconds: 0, travelSeconds: 0, ...state.progression.skills };
  let trained = false;
  for (const job of removed) {
    const cooking = job.kind === "production" && job.targetId === "dryer";
    const travel = job.kind === "exploration" && job.actorId !== "miner" && !job.targetId.startsWith("quarry_");
    if (!cooking && !travel) continue;
    const recipe = cooking ? economyCatalog.recipes.find(recipe => recipe.id === job.recipeId) : null;
    const route = travel ? economyCatalog.explorations.find(route => route.id === job.targetId) : null;
    const legacyBatches = recipe ? Math.max(1, Math.min(...Object.entries(recipe.rewards).filter(([, amount]) => amount > 0)
      .map(([id, amount]) => Math.floor((job.rewards[id] ?? 0) / amount)))) : 1;
    const seconds = job.skillWorkSeconds ?? job.cooking?.workSeconds ?? (recipe ? recipe.seconds * legacyBatches : route?.seconds ?? 0);
    if (!seconds) continue;
    const key = cooking ? "cookingSeconds" : "travelSeconds";
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
