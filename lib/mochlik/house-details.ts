import { atlasSprite, loadHabitatImage } from "./assets";
// Full aligned frames keep doors, roots and the lantern stable at every level.
export const HOUSE_ART = { x: 129, y: 18, width: 112, height: 112 };
export const BUSH_ART = { x: 23, y: 83, width: 58, height: 49 };
export const HOUSE_LAMP = { x: 195, y: 99, width: 4, height: 6 };
export function houseAtlasCell(level: number) {
  const index = Math.max(0, Math.min(4, level - 1));
  return { x: index % 3 * 512, y: Math.floor(index / 3) * 512, width: 512, height: 512 };
}
let cached: Promise<HTMLCanvasElement[]> | null = null;
export function loadHouseArt() {
  return cached ??= loadHabitatImage("/world/stump-homes-v3.webp")
    .then(image => [...Array.from({ length: 5 }, (_, index) => atlasSprite(image, houseAtlasCell(index + 1), false)),
      atlasSprite(image, { x: 1024, y: 512, width: 512, height: 512 })])
    .catch(error => { cached = null; throw error; });
}
