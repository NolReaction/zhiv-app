import type { FixedWorldScene } from "./tiled/types";

/** Only places with an implemented account action get a map shortcut. */
const places = { home: "house", workshop: "workshop", quarry: "quarry" } as const;
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
