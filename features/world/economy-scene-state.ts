import type { FixedWorldScene, PreviewLevels } from "./tiled/types";
import { initialPreviewLevels } from "./tiled/preview-state";

/** Server-owned exploration; the scene neither completes it nor awards its goods. */
export type EconomySceneJourney = { id: string; startedAt: string; finishesAt: string; label?: string };

export function economyJourneyAway(journey: EconomySceneJourney | null | undefined, now: number) {
  if (!journey || !Number.isFinite(now)) return false;
  const start = Date.parse(journey.startedAt), finish = Date.parse(journey.finishesAt);
  return Number.isFinite(start) && Number.isFinite(finish) && finish > start && now < finish;
}

/** Progression selects an authored level; future/unavailable art uses the nearest lower level. */
export function accountSceneLevels(scene: FixedWorldScene, houseLevel: number | undefined,
  preview?: { levels: PreviewLevels; previewBuildings?: boolean }): PreviewLevels {
  const authored = initialPreviewLevels(scene), levels = { ...authored };
  const home = scene.sites.find(site => site.id === "home");
  if (home && Number.isInteger(houseLevel) && houseLevel! > 0) {
    const available = home.states.map(state => state.level).sort((a, b) => a - b);
    levels.home = available.filter(level => level <= houseLevel!).at(-1) ?? available[0] ?? home.initialLevel;
  }
  if (preview?.previewBuildings || preview && Object.entries(preview.levels).some(([id, level]) => level !== authored[id])) {
    for (const site of scene.sites) {
      if (site.states.some(state => state.level === preview.levels[site.id])) levels[site.id] = preview.levels[site.id];
    }
  }
  return levels;
}
