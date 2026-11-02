import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { MapInteractiveObject } from "@/features/world/scene/site-interactions";
import { fishingBoatRoute } from "./fishing-boat-navigation";
const cache = new WeakMap<FixedWorldScene, MapInteractiveObject | null>();
/** A mooring stays tappable while the boat is away, so an open trip is easy to resume. */
export function fishingBoatMapObject(scene: FixedWorldScene): MapInteractiveObject | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const route = fishingBoatRoute(scene);
  const object: MapInteractiveObject | null = route ? { id: "fishing-boat", place: "fishing-boat", label: "Рыбацкая лодка", kind: "ship",
    anchor: { x: route.dock.x, y: route.dock.y - 16 }, hitArea: [
      { x: route.land.x - 12, y: route.land.y - 12 }, { x: route.dock.x + 29, y: route.dock.y - 22 },
      { x: route.dock.x + 29, y: route.dock.y + 15 }, { x: route.dock.x - 29, y: route.dock.y + 15 },
    ] } : null;
  cache.set(scene, object); return object;
}
