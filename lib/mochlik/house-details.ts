import { atlasSprite, loadHabitatImage } from "./assets";
// Additions stay outside the doorway and the original dynamic lamp.
export function houseDetailPatches(level: number) {
  const patches = [
    { index: 0, x: 201, y: 72, w: 21, h: 22 },
    { index: 1, x: 178, y: 37, w: 17, h: 27 },
    { index: 2, x: 161, y: 71, w: 35, h: 14 },
    { index: 3, x: 220, y: 86, w: 18, h: 22 },
  ];
  return patches.slice(0, Math.max(0, Math.min(4, level - 1)));
}
export function houseAtlasCell(level: number) { const index = Math.max(0, Math.min(3, level - 2)); return { x: index % 2 * 627, y: Math.floor(index / 2) * 627 }; }
let cached: Promise<HTMLCanvasElement[]> | null = null;
export function loadHouseAccessories() {
  return cached ??= loadHabitatImage("/world/house-accessories-v2.webp")
    .then(image => Array.from({ length: 4 }, (_, index) => atlasSprite(image, { ...houseAtlasCell(index + 2), width: 627, height: 627 })))
    .catch(error => { cached = null; throw error; });
}
