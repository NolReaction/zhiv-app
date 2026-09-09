import { atlasSprite, loadHabitatImage } from "./assets";
let cached: Promise<HTMLCanvasElement[]> | null = null;
export function loadWorkshopArt() {
  return cached ??= loadHabitatImage("/world/workshop-levels-v2.webp")
    .then(image => [0, 716, 1432].map(x => atlasSprite(image, { x, y: 0, width: 716, height: 724 })))
    .catch(error => { cached = null; throw error; });
}
