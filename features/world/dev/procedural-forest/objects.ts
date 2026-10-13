import { hash, sampleGround } from "./layout";

export type ForestObject = { id: string; x: number; y: number; scale: number; variant: number; kind: "tree" | "shrub" | "rock" };
export type Bounds = { x: number; y: number; width: number; height: number };
export const INITIAL_WIDTH = 1600;
export const WORLD_HEIGHT = 1600;
export const MAX_WIDTH = 3200;
export const INITIAL_SEED = 7391;

function reservedForProp(x: number, y: number): boolean {
  return (Math.abs(x - 780) < 100 && Math.abs(y - 420) < 100)
    || (x > 1300 && x < 1480 && y > 1020 && y < 1170)
    || (x > 675 && x < 830 && y > 1200 && y < 1300);
}

/** Grid IDs and absolute coordinates deliberately never depend on world size. */
export function forestObjects(seed: number, bounds: Bounds): ForestObject[] {
  const result: ForestObject[] = [];
  const cell = 62;
  for (let gy = Math.floor((bounds.y - 190) / cell); gy <= Math.ceil((bounds.y + bounds.height + 190) / cell); gy++) {
    for (let gx = Math.floor((bounds.x - 190) / cell); gx <= Math.ceil((bounds.x + bounds.width + 190) / cell); gx++) {
      const x = (gx + .18 + hash(gx, gy, seed) * .64) * cell;
      const y = (gy + .18 + hash(gx, gy, seed + 1) * .64) * cell;
      const ground = sampleGround(x, y);
      if (ground.water > -24 || ground.path > .12) continue;
      // Keep the authored ruin, quay and central buildable meadow readable.
      if (reservedForProp(x, y)) continue;
      const choice = hash(gx, gy, seed + 2);
      const treeProbability = .94 * (1 - ground.clearing);
      const kind = choice < treeProbability ? "tree" : choice > .955 ? "rock" : choice > .81 ? "shrub" : null;
      if (!kind) continue;
      result.push({ id: `${gx}:${gy}`, x, y, scale: .7 + hash(gx, gy, seed + 3) * .42,
        variant: Math.floor(hash(gx, gy, seed + 4) * 24), kind });
    }
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function canPlant(x: number, y: number, width: number): boolean {
  if (x < 0 || y < 0 || x > width || y > WORLD_HEIGHT) return false;
  if (reservedForProp(x, y)) return false;
  const ground = sampleGround(x, y);
  return ground.water < -28 && ground.path < .2;
}

export function pickObject(objects: readonly ForestObject[], x: number, y: number): ForestObject | undefined {
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i];
    const height = object.kind === "tree" ? 125 : 35;
    if (((x - object.x) / (object.scale * (object.kind === "tree" ? 63 : 28))) ** 2
      + ((y - object.y + height * object.scale * .55) / (height * object.scale * .65)) ** 2 < 1) return object;
  }
}
