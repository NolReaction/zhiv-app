import { builderMindFrame } from "./builder-mind";
import { clearingActivityFrame } from "./clearing-activity";
import type { ForestCookingFrame } from "./forest-cooking";
import type { ForestFishingFrame } from "./forest-fishing";
import type { ForestMiningFrame } from "./forest-mining";
import type { ForestSessionState } from "./forest-session";
import { pleskMindFrame } from "./plesk-mind";
import type { ResidentOccupant } from "./resident-traffic";
import type { FixedWorldScene } from "./tiled/types";

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
    occupants.push({ id: "mochlik", position: { x: hero.x, y: hero.y }, size: state.clearing.size * (options.heroScale ?? 1),
      moving: !options.heroManual && walking.has(state.clearing.stage) && !options.cooking
        && (!options.fishing || options.fishing.action === "walk")
        && (!options.mining || !["entering", "exiting", "working"].includes(state.journeyTravel?.phase ?? "")) });
  }
  const plesk = pleskMindFrame(state.pleskMind, scene, false);
  if (plesk) occupants.push({ id: "plesk", position: { x: plesk.x, y: plesk.y }, size: plesk.size, moving: state.pleskMind?.stage.action === "walk" });
  const builder = builderMindFrame(state.builderMind, scene, false);
  if (builder && (builder.opacity ?? 1) > .05) occupants.push({ id: "builder", position: { x: builder.x, y: builder.y }, size: builder.size, moving: state.builderMind?.action === "walk" });
  return occupants;
}
