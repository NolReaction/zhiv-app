import catalog from "@/apps/api/src/main/resources/world/player-progression-catalog.json";
import { economyCatalog, type EconomyCommand, type EconomyJob, type EconomyProgression, type EconomyState } from "./model";
import { ECONOMY_MAX_PEARLS, PEARL_DISPLAY_DIVISOR } from "./money";
import { emptyPlayerProgression, type PlayerProgression } from "./player-progression-model";

import { getPlayerLevel } from "./player-levels";
export { playerProgressionCatalog, PLAYER_ICON_LEVELS, PLAYER_LEVELS, getPlayerIconStage, getPlayerLevel, getPlayerLevelProgress } from "./player-levels";

export function getPlayerProgression(progression?: Pick<EconomyProgression, "player">): PlayerProgression {
  return progression?.player ?? emptyPlayerProgression();
}
function seasonId(now: number): string { return new Date(now).toISOString().slice(0, 7); }
export function getCooperationSeason(progression: Pick<EconomyProgression, "player"> | undefined, now = Date.now()) {
  const date = new Date(now), id = seasonId(now), saved = getPlayerProgression(progression).season;
  const current = saved.id === id ? saved : { id, points: 0, awardedMilestones: [] };
  return { id, title: catalog.season.titles[date.getUTCMonth()], points: current.points,
    endsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
    milestones: catalog.season.milestones.map(item => ({ ...item, awarded: current.awardedMilestones.includes(item.points) })) };
}
const MAX = 1_000_000_000_000;
const add = (a: number, b: number) => Math.min(MAX, a + Math.max(0, b));
/** Captured before mutation; only fields needed to establish a genuine completed action. */
export function capturePlayerProgression(state: EconomyState) {
  return structuredClone({ jobs: state.jobs, buildings: state.buildings, progression: state.progression, ship: state.ship });
}
type AwardBefore = ReturnType<typeof capturePlayerProgression>;
function productionQuantity(job: EconomyJob): number {
  const recipe = economyCatalog.recipes.find(item => item.id === job.recipeId);
  if (!recipe) return 0;
  return Math.max(0, Math.min(...Object.entries(recipe.rewards).filter(([, amount]) => amount > 0)
    .map(([id, amount]) => Math.floor((job.rewards[id] ?? 0) / amount))));
}
/** Called only after a successful server/local transition; requests and market turnover cannot mint XP. */
export function awardPlayerProgression(before: AwardBefore, state: EconomyState, command: EconomyCommand, now: number): void {
  const saved = getPlayerProgression(state.progression), player = structuredClone(saved);
  const id = seasonId(now);
  if (player.season.id !== id) player.season = { id, points: 0, awardedMilestones: [] };
  let xp = 0, seconds = 0, points = 0;
  let source: NonNullable<PlayerProgression["lastAward"]>["source"] = "production";
  const claims = ["claim_job", "claim_production", "claim_garden_collection"].includes(command.action);
  const firstRecipes = new Set<string>();
  if (claims) for (const job of before.jobs) {
    const removed = !state.jobs.some(item => item.id === job.id);
    if (job.kind === "construction" && removed && (state.buildings[job.targetId] ?? 0) > (before.buildings[job.targetId] ?? 0)) {
      xp += catalog.constructionXpPerLevel * (job.targetLevel ?? 1); source = "construction";
    } else if (job.kind === "production" && removed) {
      const recipe = economyCatalog.recipes.find(item => item.id === job.recipeId);
      if (!recipe) continue;
      seconds += recipe.seconds * productionQuantity(job);
      if (!(before.progression.recipes[recipe.id] > 0)) firstRecipes.add(recipe.id);
      source = "production";
    } else if (job.kind === "exploration") {
      const route = economyCatalog.explorations.find(item => item.id === job.targetId);
      const completed = Math.max(0, (state.progression.routes[job.targetId] ?? 0) - (before.progression.routes[job.targetId] ?? 0));
      if (!route || completed === 0) continue;
      seconds += route.seconds * completed;
      if (!(before.progression.routes[route.id] > 0)) xp += catalog.firstExplorationXp;
      source = "exploration";
    }
  }
  xp += firstRecipes.size * catalog.firstRecipeXp;
  if (command.action === "complete_resident_order") {
    const weekly = command.targetId.startsWith("weekly1_");
    xp += weekly ? catalog.weeklyStageXp : command.targetId.startsWith("stage") ? catalog.stageOrderXp : catalog.orderXp;
    points += weekly ? catalog.season.weeklyStagePoints : catalog.season.orderPoints; source = "order";
  }
  if (["load_ship_cargo", "complete_ship_order", "claim_ship_voyage"].includes(command.action)) {
    const oldVoyage = before.ship?.voyage, currentVoyage = state.ship?.voyage;
    const completedVoyages = Math.max(0, (state.ship?.completedVoyages ?? 0) - (before.ship?.completedVoyages ?? 0));
    const cargo = oldVoyage?.orders.filter(order => !order.deliveredAt &&
      (completedVoyages > 0 || currentVoyage?.orders.some(next => next.id === order.id && next.deliveredAt))).length ?? 0;
    xp += cargo * catalog.shipCargoXp + completedVoyages * catalog.shipVoyageXp;
    points += cargo * catalog.season.shipCargoPoints + completedVoyages * catalog.season.shipVoyagePoints;
    source = "ship";
  }
  const previousWork = player.workSeconds;
  player.workSeconds = add(previousWork, seconds);
  xp += Math.floor(player.workSeconds / catalog.workSecondsPerXp) - Math.floor(previousWork / catalog.workSecondsPerXp);
  player.xp = add(player.xp, xp);
  if (xp > 0) player.lastAward = { xp, source, at: new Date(now).toISOString() };
  player.season.points = add(player.season.points, points);
  for (const reward of catalog.levelRewards) if (getPlayerLevel(player.xp).level >= reward.level && !player.awardedLevels.includes(reward.level)) {
    player.awardedLevels.push(reward.level); player.pendingPearls = add(player.pendingPearls, reward.rewardPearls * PEARL_DISPLAY_DIVISOR);
  }
  for (const reward of catalog.season.milestones) if (player.season.points >= reward.points && !player.season.awardedMilestones.includes(reward.points)) {
    player.season.awardedMilestones.push(reward.points); player.pendingPearls = add(player.pendingPearls, reward.rewardPearls * PEARL_DISPLAY_DIVISOR);
    player.badges = [...new Set([...player.badges, `${id}:${reward.badge}`])].slice(-1200);
  }
  const delivered = Math.min(player.pendingPearls, Math.max(0, ECONOMY_MAX_PEARLS - state.wallet.pearls));
  if (delivered > 0) { state.wallet.pearls += delivered; player.pendingPearls -= delivered; }
  // Inspection-like successful commands do not materialize an empty progress record.
  if (xp > 0 || points > 0 || delivered > 0 || state.progression.player)
    state.progression = { ...state.progression, player };
}
/** Account merge keeps the strongest career, unions paid rewards and never pays again. */
export function mergePlayerProgression(first?: PlayerProgression, second?: PlayerProgression): PlayerProgression | undefined {
  if (!first && !second) return undefined;
  const a = first ?? emptyPlayerProgression(), b = second ?? emptyPlayerProgression();
  const selected = a.xp >= b.xp ? a : b, season = a.season.id > b.season.id ? a.season : a.season.id < b.season.id ? b.season : {
    id: a.season.id, points: Math.max(a.season.points, b.season.points),
    awardedMilestones: [...new Set([...a.season.awardedMilestones, ...b.season.awardedMilestones])].sort((x, y) => x - y),
  };
  return { ...structuredClone(selected), workSeconds: Math.max(a.workSeconds, b.workSeconds),
    awardedLevels: [...new Set([...a.awardedLevels, ...b.awardedLevels])].sort((x, y) => x - y),
    badges: [...new Set([...a.badges, ...b.badges])].sort().slice(-1200), pendingPearls: add(a.pendingPearls, b.pendingPearls), season: structuredClone(season) };
}
