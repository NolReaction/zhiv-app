import { previewSiteVisual } from "./tiled/preview-state";
import { siteImagePoint } from "./tiled/site-image";
import type { FixedWorldScene, PreviewLevels, WorldLight, WorldPoint } from "./tiled/types";

export type ForestLightSource = WorldLight & {
  siteId?: string;
  /** Size of the painted glass in world units; the frame and mullions stay visible. */
  glass?: { width: number; height: number; rotation: number; contour?: WorldPoint[] };
  beamLength?: number;
};

type ArtworkLamp = {
  id: string; u: number; v: number; width: number; height: number;
  radius: number; intensity: number; color?: string; beam?: number;
  contour?: readonly (readonly [number, number])[];
};

// Normalized positions belong to these exact cutouts, never to a map location.
// Moving, resizing or rotating the active Tiled visual therefore moves its lamp too.
const artworkLamps: Record<string, readonly ArtworkLamp[]> = {
  "home-level-1.png": [{ id: "home-lantern", u: .529, v: .638, width: .035, height: .041, radius: .67, intensity: 1.1 }],
  "home-level-2.png": [{ id: "home-lantern", u: .534, v: .665, width: .034, height: .04, radius: .7, intensity: 1.1 }],
  "home-level-3.png": [{ id: "home-lantern", u: .537, v: .673, width: .034, height: .04, radius: .7, intensity: 1.1 }],
  "home-level-4.png": [{ id: "home-lantern", u: .546, v: .666, width: .034, height: .04, radius: .7, intensity: 1.1 }],
  "home-level-5.png": [{ id: "home-lantern", u: .56, v: .65, width: .034, height: .04, radius: .7, intensity: 1.1 }],
  "quarry-lvl-1.png": [{ id: "quarry-lantern", u: .617, v: .69, width: .022, height: .036, radius: .46, intensity: 1.18 }],
  "forest-workshop-level-2.png": [
    { id: "workshop-lantern", u: .518, v: .657, width: .023, height: .031, radius: .4, intensity: 1.15 },
    { id: "workshop-window", u: .233, v: .58, width: .04, height: .072, radius: .25, intensity: .58,
      contour: [[.214, .544], [.249, .552], [.249, .618], [.214, .604]] },
  ],
  "lighthouse-level-1.png": [{ id: "lighthouse-lens", u: .51, v: .326, width: .055, height: .065,
    radius: .85, intensity: 1.24, color: "#ffe5a6", beam: 3.3 }],
};

/** Decorative lights follow only known, visibly equipped artwork. Ruins stay dark. */
export function forestBuildingLights(scene: FixedWorldScene, levels: PreviewLevels = {}): ForestLightSource[] {
  const result: ForestLightSource[] = [];
  for (const site of scene.sites) {
    if (!site.states?.length) continue;
    const visual = previewSiteVisual(site, levels);
    if (!visual) continue;
    const lamps = artworkLamps[visual.image.split("?")[0].split("/").at(-1) ?? ""];
    if (!lamps) continue;
    const geometry = visual.geometry ?? site, placement = geometry.imagePlacement ?? geometry.bounds;
    for (const lamp of lamps) {
      result.push({ id: lamp.id, siteId: site.id, position: siteImagePoint(geometry, lamp.u, lamp.v),
        kind: "lantern", radius: placement.width * lamp.radius, intensity: lamp.intensity,
        color: lamp.color ?? "#ffd18b", flicker: lamp.beam ? 0 : .025,
        glass: { width: placement.width * lamp.width, height: placement.height * lamp.height,
          rotation: (geometry.imagePlacement?.rotation ?? 0) * Math.PI / 180,
          contour: lamp.contour?.map(([u, v]) => siteImagePoint(geometry, u, v)) },
        ...(lamp.beam ? { beamLength: placement.width * lamp.beam } : {}) });
    }
  }
  return result;
}
