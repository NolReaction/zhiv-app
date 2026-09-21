/** Temporary presentation limits while the new forest receives its sites and routes.
 * Stored rewards, inventory and game progress remain independent of these switches. */
export const WORLD_PRESENTATION = {
  rebuilding: true,
  streakDecor: false,
} as const;

// Logical map coordinates stay independent of the 2560px source artwork.
export const NEW_MAP_SIZE = 1254;
export const NEW_MAP_FOCUS = { x: 455, y: 480, width: 350, height: 350 } as const;
export const NEW_MAP_SPAWN = { x: 630, y: 660 } as const;
