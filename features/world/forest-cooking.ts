import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";

export type CookingAction = "prepare" | "stir" | "taste" | "serve";
export const FOREST_COOKING_ACTION_SECONDS = Object.freeze({ prepare: 7, stir: 10, taste: 6, serve: 7 });
export const FOREST_COOKING_CYCLE_SECONDS = Object.values(FOREST_COOKING_ACTION_SECONDS).reduce((sum, value) => sum + value, 0);
export type CookingMotion = { action: CookingAction; phase: number; frame: number; steam: number };
export type ForestCookingFrame = WorldPoint & CookingMotion & { size: number; direction: PixelDirection };
const actions: readonly CookingAction[] = ["prepare", "stir", "taste", "serve"];

/** A rehearsal clock, not a recipe or an economic job. Scene time controls every
 * movement; sampling never consumes fish or produces meals. An individual stage
 * loops independently so its complete gesture can be inspected in DEV. */
export function forestCookingFrame(elapsed: number, still = false, preview?: CookingAction): CookingMotion {
  if (still) return { action: preview ?? "stir", phase: .5, frame: 0, steam: preview === "prepare" ? 0 : .35 };
  const time = Number.isFinite(elapsed) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, elapsed)) : 0;
  let age = time % (preview ? FOREST_COOKING_ACTION_SECONDS[preview] : FOREST_COOKING_CYCLE_SECONDS);
  let action: CookingAction = preview ?? "prepare";
  if (!preview) {
    for (const candidate of actions) {
      action = candidate;
      if (age < FOREST_COOKING_ACTION_SECONDS[candidate]) break;
      age -= FOREST_COOKING_ACTION_SECONDS[candidate];
    }
  }
  const phase = age / FOREST_COOKING_ACTION_SECONDS[action];
  return { action, phase, frame: Math.floor(age * 3) % 4,
    steam: action === "prepare" ? 0 : action === "stir" ? .3 + Math.sin(phase * Math.PI) * .5 : .5 };
}

/** Includes the actual feet, side pot, front board and the highest steam curl.
 * The same footprint should be passed to object/foliage occlusion. */
export function forestCookingBounds(frame: Pick<ForestCookingFrame, "x" | "y" | "size" | "direction">): WorldBounds {
  const side = frame.direction === "left" ? -1 : 1;
  return { x: frame.x - frame.size * (side < 0 ? .64 : .54), y: frame.y - frame.size * 1.05,
    width: frame.size * 1.18, height: frame.size * 1.18 };
}
