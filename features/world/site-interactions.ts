import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { previewPointInPolygon } from "./tiled/preview-state";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";

/** Only places with an implemented account action get a map shortcut. */
const places = { home: "house", workshop: "workshop", quarry: "quarry", woodlot: "woodlot" } as const;
export type BuildingPlace = typeof places[keyof typeof places];

export function sitePlace(siteId: string | null | undefined): BuildingPlace | null {
  return siteId && Object.hasOwn(places, siteId) ? places[siteId as keyof typeof places] : null;
}

export function interactiveSites(scene: FixedWorldScene) {
  return scene.sites.flatMap(site => {
    const place = sitePlace(site.id);
    return place ? [{ site, place }] : [];
  });
}

export type MapObjectPlace = BuildingPlace | "garden" | "campfire" | "bridge" | "lighthouse" | "plesk-shop" | "builder-home";
export type MapInteractiveObject = {
  id: string;
  place: MapObjectPlace;
  label: string;
  kind: "site" | "garden" | "campfire";
  anchor: WorldPoint;
  hitArea: readonly WorldPoint[];
};
const objectPlaces = { ...places, bridge: "bridge", lighthouse: "lighthouse", "plesk-shop": "plesk-shop", "builder-home": "builder-home" } as const;
const objectCache = new WeakMap<FixedWorldScene, readonly MapInteractiveObject[]>();

/** Existing world geometry supplies every shortcut, including planned landmarks. */
export function interactiveMapObjects(scene: FixedWorldScene, options: { showBuildings?: boolean } = {}): readonly MapInteractiveObject[] {
  let objects = objectCache.get(scene);
  if (!objects) {
    objects = [
      ...scene.sites.flatMap(site => Object.hasOwn(objectPlaces, site.id) ? [{
        id: site.id, place: objectPlaces[site.id as keyof typeof objectPlaces], label: site.label,
        kind: "site" as const, anchor: site.anchor, hitArea: site.hitArea,
      }] : []),
      ...(scene.bushes ?? []).filter(bush => forestBushArtworkAvailable(scene, bush)).map(bush => ({
        id: bush.id, place: "garden" as const, label: "Ягодный куст", kind: "garden" as const,
        anchor: bush.hide, hitArea: bush.points,
      })),
      ...(scene.campfires ?? []).map(fire => ({
        id: fire.id, place: "campfire" as const, label: "Костёр", kind: "campfire" as const, anchor: fire.position,
        // The authored footprint also bounds the visible logs and flame above it.
        hitArea: Array.from({ length: 12 }, (_, index) => {
          const angle = index / 12 * Math.PI * 2;
          return { x: fire.position.x + Math.cos(angle) * fire.radius * 1.8,
            y: fire.position.y - fire.radius * .8 + Math.sin(angle) * fire.radius * 2 };
        }),
      })),
    ];
    objectCache.set(scene, objects);
  }
  return options.showBuildings === false ? objects.filter(object => object.kind !== "site") : objects;
}

export function mapObjectAt(objects: readonly MapInteractiveObject[], point: WorldPoint): MapInteractiveObject | null {
  return [...objects].reverse().find(object => previewPointInPolygon(point, object.hitArea)) ?? null;
}
