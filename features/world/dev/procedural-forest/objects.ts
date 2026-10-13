import { hash, sampleGround } from "./layout";

export type ForestObject = { id: string; x: number; y: number; scale: number; variant: number; kind: "tree" | "shrub" | "rock" | "ruins" | "bridge" | "jetty"; rotation?: number };
export type ObjectKind = ForestObject["kind"];
export type Bounds = { x: number; y: number; width: number; height: number };
export const INITIAL_WIDTH = 1600;
export const WORLD_HEIGHT = 1600;
export const MAX_WIDTH = 3200;
export const INITIAL_SEED = 7391;

/** Props use the same scene records as vegetation, with their original ground anchors. */
export function initialProps(): ForestObject[] {
  return [
    { id: "prop:ruins", kind: "ruins", x: 780, y: 420, scale: 1, variant: 0 },
    { id: "prop:jetty", kind: "jetty", x: 1330, y: 1070, scale: 1, variant: 0 },
    { id: "prop:bridge", kind: "bridge", x: 749, y: 1249, scale: 1, variant: 0 },
  ];
}

const radians = (degrees = 0) => degrees * Math.PI / 180;
const intrinsicAngle = (kind: ObjectKind) => kind === "jetty" ? .36 : kind === "bridge" ? .22 : 0;

/** Conservative local extents include painted shadows, for rotated culling and selection. */
function localBounds(object: ForestObject): Bounds {
  switch (object.kind) {
    case "tree": return { x: -80, y: -158, width: 179, height: 190 };
    case "shrub": return { x: -32, y: -45, width: 85, height: 61 };
    case "rock": return { x: -33, y: -36, width: 86, height: 52 };
    case "ruins": return { x: -75, y: -101, width: 198, height: 158 };
    case "bridge": return { x: -67, y: -46, width: 144, height: 101 };
    case "jetty": return { x: -9, y: -13, width: 145, height: 86 };
  }
}

export function objectBounds(object: ForestObject): Bounds {
  const local = localBounds(object), angle = radians(object.rotation) + intrinsicAngle(object.kind);
  const cosine = Math.cos(angle) * object.scale, sine = Math.sin(angle) * object.scale;
  const corners = [[local.x, local.y], [local.x + local.width, local.y],
    [local.x + local.width, local.y + local.height], [local.x, local.y + local.height]]
    .map(([x, y]) => ({ x: object.x + x * cosine - y * sine, y: object.y + x * sine + y * cosine }));
  const x = Math.min(...corners.map(point => point.x)), y = Math.min(...corners.map(point => point.y));
  return { x, y, width: Math.max(...corners.map(point => point.x)) - x, height: Math.max(...corners.map(point => point.y)) - y };
}

/** Authored props retain their original overlap depth even though their anchor differs. */
export function objectDepth(object: ForestObject): number {
  const offset = object.kind === "ruins" ? 20 : object.kind === "jetty" ? 70 : object.kind === "bridge" ? 31 : 0;
  return object.y + offset * object.scale * Math.cos(radians(object.rotation));
}

export function compareObjects(a: ForestObject, b: ForestObject): number {
  return objectDepth(a) - objectDepth(b) || a.x - b.x || a.id.localeCompare(b.id);
}

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
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x > width || y > WORLD_HEIGHT) return false;
  if (reservedForProp(x, y)) return false;
  const ground = sampleGround(x, y);
  return ground.water < -28 && ground.path < .2;
}

export function pickObject(objects: readonly ForestObject[], x: number, y: number): ForestObject | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const ordered = [...objects].sort(compareObjects);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const object = ordered[i];
    if (!Number.isFinite(object.scale) || object.scale <= 0) continue;
    const angle = radians(object.rotation) + intrinsicAngle(object.kind);
    const dx = (x - object.x) / object.scale, dy = (y - object.y) / object.scale;
    const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
    const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
    if (object.kind === "tree" || object.kind === "shrub" || object.kind === "rock") {
      const radiusX = object.kind === "tree" ? 66 : 30;
      const radiusY = object.kind === "tree" ? 81 : object.kind === "shrub" ? 27 : 21;
      const centerY = object.kind === "tree" ? -69 : object.kind === "shrub" ? -20 : -12;
      if ((localX / radiusX) ** 2 + ((localY - centerY) / radiusY) ** 2 < 1) return object;
    } else {
      const bounds = localBounds(object);
      // Keep a prop's full silhouette selectable, without extending to its cast shadow.
      const maxY = object.kind === "ruins" ? 37 : object.kind === "jetty" ? 55 : 29;
      if (localX >= bounds.x && localX <= bounds.x + bounds.width && localY >= bounds.y && localY <= maxY) return object;
    }
  }
}
