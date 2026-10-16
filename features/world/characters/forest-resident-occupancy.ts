import { builderMindFrame } from "@/features/world/characters/builder/builder-mind";
import { clearingActivityFrame, clearingResidentIntent } from "@/features/world/simulation/clearing-activity";
import type { ForestCookingFrame } from "@/features/world/activities/cooking/forest-cooking";
import type { ForestFishingFrame } from "@/features/world/activities/fishing/forest-fishing";
import type { ForestMiningFrame } from "@/features/world/activities/mining/forest-mining";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { pleskMindFrame } from "@/features/world/characters/plesk/plesk-mind";
import { residentRouteIntent, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { pleskTrailDistance } from "@/features/world/characters/plesk/plesk-resident";
import { residentFaunaEncounter } from "@/features/world/environment/wildlife/forest-fauna";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import { forestVillagerOccupants } from "@/features/world/characters/villagers/villager-mind";

type OccupancyOptions = {
  heroVisible: boolean; heroScale?: number; heroManual?: boolean;
  fishing?: ForestFishingFrame | null; mining?: ForestMiningFrame | null; cooking?: ForestCookingFrame | null;
};
const walking = new Set(["free-walk", "outbound", "return", "homebound", "home-return"]);

/** Transient ground reservations, detached from the shared simulation. Hidden
 * residents reserve nothing; fixed gestures retain their actual contact point.
 * Calling this for each mover includes feet already committed earlier in the
 * same owner tick, rather than letting two stale snapshots cross each other. */
export function forestResidentOccupants(state: ForestSessionState, scene: FixedWorldScene, options: OccupancyOptions): ResidentOccupant[] {
  const occupants: ResidentOccupant[] = [], body = clearingActivityFrame(state.clearing);
  const hero = options.mining ?? options.fishing ?? options.cooking ?? body;
  const opacity = options.mining?.opacity ?? (options.fishing || options.cooking ? 1 : body.opacity);
  if (options.heroVisible && opacity > .05) {
    const moving = !options.heroManual && walking.has(state.clearing.stage) && !options.cooking
      && (!options.fishing || options.fishing.action === "walk")
      && (!options.mining || !["entering", "exiting", "working"].includes(state.journeyTravel?.phase ?? ""));
    occupants.push({ id: "mochlik", position: { x: hero.x, y: hero.y }, size: state.clearing.size * (options.heroScale ?? 1),
      moving, intent: moving ? clearingResidentIntent(state.clearing, state.clearing.size * (options.heroScale ?? 1)) : undefined });
  }
  const plesk = pleskMindFrame(state.pleskMind, scene, false);
  if (plesk) {
    const mind = state.pleskMind!, trail = mind.stage.trail, encounter = state.fauna && residentFaunaEncounter(state.fauna, "plesk");
    const wildlife = encounter && !["interrupt", "release"].includes(encounter.phase) && !mind.noticePending && !mind.tradePending;
    const moving = mind.stage.action === "walk" && !wildlife;
    occupants.push({ id: "plesk", position: { x: plesk.x, y: plesk.y }, size: plesk.size, moving,
      intent: moving && trail ? residentRouteIntent(trail, mind.position, pleskTrailDistance(trail, mind.age),
        plesk.size, mind.stage.target.id === "plesk-yield" ? 0 : mind.intent === "trade" ? 2 : 1) : undefined });
  }
  const builder = builderMindFrame(state.builderMind, scene, false);
  if (builder && (builder.opacity ?? 1) > .05) {
    const mind = state.builderMind!, moving = mind.action === "walk";
    occupants.push({ id: "builder", position: { x: builder.x, y: builder.y }, size: builder.size, moving,
      intent: moving && mind.route ? residentRouteIntent(mind.route, mind.position, mind.distance, builder.size,
        mind.job || mind.socialVisit ? 2 : mind.target?.id === "builder-yield" ? 0 : 1) : undefined });
  }
  if (state.villagers) occupants.push(...forestVillagerOccupants(state.villagers));
  return occupants;
}
