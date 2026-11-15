import { previewSiteVisual } from "@/features/world/tiled/preview-state";
import { siteImagePoint } from "@/features/world/tiled/site-image";
import type { FixedWorldScene, PreviewLevels, WorldLight, WorldPoint } from "@/features/world/tiled/types";

export type ForestLightSource = WorldLight & {
  siteId?: string;
  /** Size of the painted glass in world units; the frame and mullions stay visible. */
  glass?: { width: number; height: number; rotation: number; contour?: WorldPoint[] };
  beamLength?: number;
  /** Ground-plane origin follows the same active artwork transform as its lens. */
  beamGround?: WorldPoint;
};

type ArtworkLamp = {
  id: string; u: number; v: number; width: number; height: number;
  radius: number; intensity: number; color?: string; beam?: number;
  contour?: readonly (readonly [number, number])[];
};

// Coordinates are relative to the top-left of the birch house SVG viewBox (19 30 239 149).
// The authored dormer window and chimney are drawn from the active Tiled geometry.
const homeLantern: ArtworkLamp = {
  id: "home-lantern", u: 104 / 239, v: 105.8 / 149, width: 9 / 239, height: 10 / 149,
  radius: .7, intensity: 1.1,
  contour: [[99.65 / 239, 100.3 / 149], [108.47 / 239, 103.7 / 149], [107.93 / 239, 107.1 / 149],
    [106.11 / 239, 109 / 149], [104.2 / 239, 110 / 149], [101.56 / 239, 106.85 / 149], [100.28 / 239, 104.38 / 149]],
};
const homeSideWindow: ArtworkLamp = {
  id: "home-side-window", u: 148.5 / 239, v: 98.3 / 149, width: 6 / 239, height: 12.1 / 149,
  radius: .15, intensity: .42,
  contour: [[145.5 / 239, 96 / 149], [151.5 / 239, 92.2 / 149], [151.5 / 239, 100.5 / 149], [145.5 / 239, 104.3 / 149]],
};
const homePantryWindow: ArtworkLamp = {
  id: "home-pantry-window", u: 35.05 / 239, v: 77 / 149, width: 5.5 / 239, height: 6.6 / 149,
  radius: .13, intensity: .4,
  contour: [[32.3 / 239, 73.7 / 149], [37.8 / 239, 75.8 / 149], [37.8 / 239, 80.3 / 149], [32.3 / 239, 78.2 / 149]],
};
const homeLamps = [homeLantern, homeSideWindow];

// The five workshop cutouts share the same 480 × 360 artboard. Coordinates below
// are taken from the painted glass, forge opening and central dormer pane.
const workshopWindow: ArtworkLamp = {
  id: "workshop-window", u: 284.5 / 480, v: 223 / 360, width: 13 / 480, height: 16 / 360, radius: .22, intensity: .5,
  contour: [[278 / 480, 217 / 360], [291 / 480, 214.5 / 360], [291 / 480, 229 / 360], [278 / 480, 231.5 / 360]],
};
const workshopLantern: ArtworkLamp = {
  id: "workshop-lantern", u: 257 / 480, v: 255 / 360, width: 6 / 480, height: 7 / 360, radius: .31, intensity: 1.1,
};
const workshopForge: ArtworkLamp = {
  id: "workshop-forge", u: 92 / 480, v: 252 / 360, width: 18 / 480, height: 13 / 360, radius: .23, intensity: .7, color: "#ffac57",
};
const workshopLoft: ArtworkLamp = {
  id: "workshop-loft-window", u: 170.5 / 480, v: 151 / 360, width: 8 / 480, height: 21 / 360, radius: .12, intensity: .45,
  contour: [[167 / 480, 142 / 360], [171 / 480, 140 / 360], [174 / 480, 145 / 360],
    [174 / 480, 163 / 360], [167 / 480, 161 / 360]],
};
const workshopWithLoft = [workshopWindow, workshopLantern, workshopForge, workshopLoft];

// Normalized positions belong to these exact cutouts, never to a map location.
// Moving, resizing or rotating the active Tiled visual therefore moves its lamp too.
const artworkLamps: Record<string, readonly ArtworkLamp[]> = {
  "home-vector-1.webp": homeLamps,
  "home-vector-2.webp": homeLamps,
  "home-vector-3.webp": homeLamps,
  "home-vector-4.webp": [...homeLamps, homePantryWindow],
  // The extended eave covers the side window on the open veranda.
  "home-vector-5.webp": [homeLantern, homePantryWindow],
  "quarry-lvl-1.png": [{ id: "quarry-lantern", u: .895, v: .549, width: .035, height: .041, radius: .46, intensity: 1.18 }],
  "quarry-lvl-2.png": [{ id: "quarry-lantern", u: .895, v: .548, width: .035, height: .041, radius: .46, intensity: 1.18 }],
  "quarry-lvl-3.png": [{ id: "quarry-lantern", u: .895, v: .546, width: .035, height: .041, radius: .46, intensity: 1.18 }],
  "quarry-lvl-4.png": [{ id: "quarry-lantern", u: .896, v: .543, width: .035, height: .041, radius: .46, intensity: 1.18 }],
  "quarry-lvl-5.png": [{ id: "quarry-lantern", u: .898, v: .543, width: .035, height: .041, radius: .46, intensity: 1.18 }],
  "forest-workshop-vector-1.webp": [workshopWindow],
  "forest-workshop-vector-2.webp": [workshopWindow, workshopLantern],
  "forest-workshop-vector-3.webp": [workshopWindow, workshopLantern, workshopForge],
  "forest-workshop-vector-4.webp": workshopWithLoft,
  "forest-workshop-vector-5.webp": workshopWithLoft,
  "market-lvl-1.png": [
    { id: "market-lantern-west", u: .449, v: .255, width: .018, height: .028,
      radius: .4, intensity: 1.08, color: "#ffd395" },
    { id: "market-lantern-east", u: .633, v: .377, width: .012, height: .022,
      radius: .34, intensity: .96, color: "#ffc982" },
  ],
  "pleska-market.png": [{ id: "plesk-shop-lantern", u: .481, v: .679, width: .025, height: .03,
    radius: .57, intensity: 1.08, color: "#ffe0a2" }],
  "lighthouse-level-1.png": [{ id: "lighthouse-lens", u: .51, v: .326, width: .055, height: .065,
    radius: .85, intensity: 1.24, color: "#ffe5a6", beam: 4.1 }],
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
        ...(lamp.beam ? { beamLength: placement.width * lamp.beam,
          beamGround: siteImagePoint(geometry, lamp.u, .91) } : {}) });
    }
  }
  return result;
}
