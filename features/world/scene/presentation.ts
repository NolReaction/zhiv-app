import forest from "@/features/world/tiled/forest.generated.json";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import { acceptWorldLightingRefresh } from "./lighting-refresh";

// eslint-disable-next-line @next/next/no-assign-module-variable -- Type webpack's existing HMR module; this declaration assigns nothing.
declare const module: { hot?: { accept(dependency: string, apply: () => void): void; invalidate(): void } };

/** Temporary presentation limits while the new forest receives its sites and routes.
 * These switches select the Tiled presentation and hide legacy artwork; the new
 * economy is available independently. Stored rewards and progress are preserved. */
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

// Studio already applies and acknowledges its draft. Let webpack update only the
// shared lighting data, without replacing the game, editor or presence sessions.
// Other Tiled edits still use the ordinary refresh path and rebuild navigation.
if (process.env.NODE_ENV === "development" && typeof module !== "undefined" && module.hot) {
  module.hot.accept("@/features/world/tiled/forest.generated.json", () => {
    if (!acceptWorldLightingRefresh(TILED_WORLD, forest as FixedWorldScene)) module.hot?.invalidate();
  });
}
