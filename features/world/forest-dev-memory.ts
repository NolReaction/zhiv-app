import type { WorldDevState } from "./dev/world-dev-store";
import type { PreviewLevels } from "./tiled/types";

/** Inspection and camera controls are safe; forced conditions/actions cannot become the player's memory. */
export function forestPersistenceOverridden(dev: WorldDevState | undefined, authoredLevels: PreviewLevels) {
  return Boolean(dev && (dev.weather !== "auto" || dev.timeOfDay !== "auto"
    || dev.butterflies !== "auto" || dev.fireflies !== "auto" || dev.birds !== "auto"
    || !dev.autoLife || dev.navigationMode !== "auto" || dev.reducedMotion !== "auto"
    || dev.pose !== "auto" || dev.heroScale !== 1 || !dev.showHero || !dev.showBuildings
    || dev.animation || dev.lifeEvent || dev.birdEvent > 0
    || Object.entries(dev.levels).some(([id, level]) => level !== authoredLevels[id])));
}
