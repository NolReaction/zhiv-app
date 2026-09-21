import forest from "./tiled/forest.generated.json";
import type { FixedWorldScene } from "./tiled/types";

/** Temporary presentation limits while the new forest receives its sites and routes.
 * Stored rewards, inventory and game progress remain independent of these switches. */
export const WORLD_PRESENTATION = {
  rebuilding: true,
  streakDecor: false,
} as const;

// Edit world/tiled/forest.tmj, then run world:export or world:watch.
// The circle, main world and preview all consume this same compiled scene.
export const TILED_WORLD = forest as FixedWorldScene;
if (!TILED_WORLD.actor) throw new Error("Forest needs a Tiled point with role=spawn and size");
export const NEW_MAP_BOUNDS = { width: TILED_WORLD.width, height: TILED_WORLD.height };
export const NEW_MAP_SIZE = TILED_WORLD.width;
export const NEW_MAP_FOCUS = TILED_WORLD.focus;
export const NEW_MAP_SPAWN = TILED_WORLD.actor.spawn;
export const NEW_MAP_PET_SIZE = TILED_WORLD.actor.size;
