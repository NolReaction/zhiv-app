import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { clearingActivityFrame } from "@/features/world/simulation/clearing-activity";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export const MINING_PORTAL_SECONDS = 1.8;
export type ForestMiningFrame = WorldPoint & {
  size: number; direction: PixelDirection; frame: number; pose: "walk" | "idle";
  opacity: number; scale: number; working: boolean; doorway: WorldPoint; workCue: WorldPoint; elapsed: number;
};
const mix = (a: WorldPoint, b: WorldPoint, t: number): WorldPoint => ({ x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t });
const smooth = (t: number) => t*t*(3-2*t);

/** The authored doorway is inside collision. Only the visible portal crossing
 * moves there; the shared navigation feet remain on the safe quarry marker. */
export function forestJourneyMiningFrame(state: ForestSessionState, scene: FixedWorldScene, still = false): ForestMiningFrame | null {
  const travel = state.journeyTravel, mine = travel?.mining;
  if (!travel || !mine || travel.scene !== scene || !mine.prepared) return null;
  const body = clearingActivityFrame(state.clearing, { still });
  const base = { ...state.clearing.position, size: state.clearing.size, direction: body.direction,
    pose: body.pose === "walk" ? "walk" as const : "idle" as const, frame: body.frame,
    opacity: body.opacity, scale: 1, working: travel.phase === "working", doorway: mine.doorway, workCue:mine.workCue, elapsed: state.director.elapsed };
  if (travel.phase === "working") return { ...base, opacity: 0 };
  if (travel.phase !== "entering" && travel.phase !== "exiting") return body.residing || body.bush?.occupied ? null : base;
  const progress = Math.max(0, Math.min(1, (state.director.elapsed-mine.phaseAt)/MINING_PORTAL_SECONDS));
  const t = travel.phase === "entering" ? progress : 1-progress;
  const point = t < .42 ? mix(travel.shore, mine.entry, t/.42) : mix(mine.entry, mine.doorway, (t-.42)/.58);
  const inside = smooth(Math.max(0, (t-.42)/.58));
  return { ...base, ...point, pose: "walk", frame: still ? 0 : Math.floor(state.director.elapsed*7)%4,
    direction: travel.phase === "entering" ? "back" : "front", opacity: 1-inside, scale: 1-inside*.32 };
}
