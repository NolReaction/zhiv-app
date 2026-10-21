import type { FixedWorldScene, PreviewLevels } from "@/features/world/tiled/types";
import { initialPreviewLevels } from "@/features/world/tiled/preview-state";

/** Server-owned exploration; the scene neither completes it nor awards its goods. */
export type EconomySceneJourney = { id: string; startedAt: string; finishesAt: string; label?: string; routeId?: string;
  rewards?: Readonly<Record<string, number>>;
  fishing?: { rodId: string; fishId: string; catchRevealed?: boolean | null } };

/** A home-circle status can show work without making the character leave home. */
export type EconomySceneActivity = EconomySceneJourney & {
  kind: "exploration" | "production"; itemId?: string;
  collection?: { kind: "berry_harvest"; seconds: number; startedAt: string | null; finishesAt: string | null } | null;
};

/** Confirmed account levels, separate from cosmetic memory and legacy WorldState. */
export type EconomySceneBuildings = Readonly<Record<string, number>>;

export function economyJourneyAway(journey: EconomySceneJourney | null | undefined, now: number) {
  if (!journey || !Number.isFinite(now)) return false;
  const start = Date.parse(journey.startedAt), finish = Date.parse(journey.finishesAt);
  return Number.isFinite(start) && Number.isFinite(finish) && finish > start && now < finish;
}

/** Progression selects an authored level; future/unavailable art uses the nearest lower level. */
export function accountSceneLevels(scene: FixedWorldScene, houseLevel: number | undefined,
  preview?: { levels: PreviewLevels; previewBuildings?: boolean }, buildings?: EconomySceneBuildings | null,
  presentation?: { merchantArrived?: boolean }): PreviewLevels {
  const authored = initialPreviewLevels(scene), levels = { ...authored };
  for (const site of scene.sites) {
    // The authored rabbit home hosts the saved woodlot station. Its second
    // exterior starts at station tier 3; neither artwork nor account keys change.
    const station = site.id === "lopukh-home" ? buildings?.woodlot : undefined;
    // The market has no independent construction or saved level: only a claimed
    // bridge opens it. A ready construction job still leaves buildings.bridge 0.
    const bridge = buildings?.bridge, home = buildings?.home;
    const confirmed = site.id === "lopukh-home"
      ? Number.isInteger(station) && station! >= 1 ? station! >= 3 ? 2 : 1 : 0
      : site.id === "market" ? buildings ? Number.isInteger(bridge) && bridge! >= 1 ? 1 : 0 : undefined
      // Unlocking house 3 starts the introduction; the abandoned tent remains
      // until the merchant has actually finished arriving for this account.
      : site.id === "leaftail-caravan" ? buildings ? Number.isInteger(home) && home! >= 3 && presentation?.merchantArrived ? 1 : 0 : undefined
      : buildings?.[site.id];
    const level = Number.isInteger(confirmed) && confirmed! >= 0 ? confirmed
      : site.id === "home" && Number.isInteger(houseLevel) && houseLevel! > 0 ? houseLevel : undefined;
    if (level === undefined) continue;
    const available = site.states.map(state => state.level).sort((a, b) => a - b);
    levels[site.id] = site.id === "lopukh-home" && level === 0 ? 0
      : available.filter(candidate => candidate <= level).at(-1) ?? available[0] ?? site.initialLevel;
  }
  if (preview?.previewBuildings || preview && Object.entries(preview.levels).some(([id, level]) => level !== authored[id])) {
    for (const site of scene.sites) {
      if (site.states.some(state => state.level === preview.levels[site.id])) levels[site.id] = preview.levels[site.id];
    }
  }
  return levels;
}
