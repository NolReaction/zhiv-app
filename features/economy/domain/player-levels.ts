import catalog from "@/apps/api/src/main/resources/world/player-progression-catalog.json";

export const playerProgressionCatalog = catalog;
export const PLAYER_ICON_LEVELS = [1, 10, 20, 30, 40, 50, 60, 70, 80, 90] as const;
export function getPlayerIconStage(level: number): number {
  return Math.max(0, PLAYER_ICON_LEVELS.findLastIndex(start => level >= start));
}
export const PLAYER_LEVELS = Array.from({ length: catalog.maxLevel }, (_, index) => ({
  level: index + 1, title: catalog.levelTitles[getPlayerIconStage(index + 1)],
  minimumXp: catalog.levelXpFactor * index * index,
  nextMinimumXp: index + 1 < catalog.maxLevel ? catalog.levelXpFactor * (index + 1) ** 2 : null,
  rewardPearls: catalog.levelRewards.find(reward => reward.level === index + 1)?.rewardPearls ?? 0,
}));
export function getPlayerLevel(xp = 0) {
  const value = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  return PLAYER_LEVELS[Math.min(catalog.maxLevel - 1, Math.floor(Math.sqrt(value / catalog.levelXpFactor)))];
}
export function getPlayerLevelProgress(xp = 0) {
  const current = getPlayerLevel(xp), currentXp = Number.isFinite(xp) ? Math.max(0, Math.floor(xp)) : 0;
  const requiredXp = current.nextMinimumXp === null ? 0 : current.nextMinimumXp - current.minimumXp;
  const levelXp = current.nextMinimumXp === null ? 0 : currentXp - current.minimumXp;
  return { ...current, currentXp, levelXp, requiredXp, remaining: Math.max(0, requiredXp - levelXp),
    ratio: requiredXp === 0 ? 1 : Math.min(1, levelXp / requiredXp) };
}
