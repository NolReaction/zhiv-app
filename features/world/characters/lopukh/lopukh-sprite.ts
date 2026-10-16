import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { WorldPoint } from "@/features/world/tiled/types";
import type { ForestVillagerAction } from "../forest-villager-types";

export const LOPUKH_SPRITE_SIZE = 48;
export const LOPUKH_SPRITE_CACHE_LIMIT = 192;
export type LopukhSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  head: WorldPoint;
  feet: readonly WorldPoint[];
  arms: readonly { hand: "left" | "right"; shoulder: WorldPoint; palm: WorldPoint }[];
  axe: { grip: WorldPoint; head: WorldPoint; behindBody: boolean; visible: boolean };
  log?: { center: WorldPoint; leftGrip: WorldPoint; rightGrip: WorldPoint };
};

const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, LopukhSpriteRig>();
export const lopukhSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const palette = {
  outline: "#64432e", shadow: "#967044", fur: "#c59655", honey: "#ddb16b", light: "#edc987",
  cream: "#f1dbad", pale: "#ffebc5", blush: "#cc957c", innerEar: "#dfae91", eye: "#382e28",
  scarf: "#617453", scarfLight: "#88946a", bark: "#775134", barkLight: "#a87947",
  end: "#deb67c", ring: "#b88b55", steel: "#849993", steelLight: "#c1cec0", handle: "#b38955",
};
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];
const actions: readonly ForestVillagerAction[] = ["idle", "walk", "work", "carry", "inspect", "greet", "rest", "trade"];
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const mix = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** A honey-coloured rabbit with one folded ear. Every painted source pixel is
 * opaque and integer-aligned; world lighting and opacity belong to the painter. */
export function lopukhSprite(action: ForestVillagerAction, direction: PixelDirection, frame: number,
  phase = 0, still = false): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clock = still || !Number.isFinite(frame) ? 0 : ((Math.trunc(frame) % 32) + 32) % 32;
  const stride = action === "walk" || action === "carry" ? clock % 8 : 0;
  const stage = !still && ["work", "inspect", "greet", "trade"].includes(action)
    ? Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 16) : 0;
  const breathe = !still && ["idle", "rest"].includes(action) && clock >= 8 && clock < 20 ? 1 : 0;
  const blink = !still && action === "idle" && clock === 30;
  const key = `${action}:${direction}:${stride}:${stage}:${breathe}:${Number(blink)}`;
  const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found; }
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = LOPUKH_SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const mirrored = direction === "left", back = direction === "back", side = mirrored || direction === "right";
  const mirror = (p: WorldPoint) => point(mirrored ? 47 - p.x : p.x, p.y);
  const rect = (x: number, y: number, width: number, height: number, color: string) => {
    ctx.fillStyle = color; ctx.fillRect(mirrored ? 48 - x - width : x, y, width, height);
  };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    for (let row = -ry; row <= ry; row++) {
      const extent = Math.floor(rx * Math.sqrt(Math.max(0, 1 - row * row / ((ry + .3) * (ry + .3)))));
      rect(x - extent, y + row, extent * 2 + 1, 1, color);
    }
  };
  const segment = (a: WorldPoint, b: WorldPoint, color: string, width = 3) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1), half = Math.floor(width / 2);
    for (let i = 0; i <= steps; i++) {
      const at = mix(a, b, i / steps); rect(at.x - half, at.y - half, width, width, color);
    }
  };
  const step = [0, 1, 2, 1, 0, -1, -2, -1][stride];
  const bob = (action === "walk" || action === "carry") && [1, 2, 5, 6].includes(stride) ? -1 : 0;
  const rise = bob - breathe + (action === "rest" ? 1 : 0), p = stage / 16;
  const gesture = Math.sin(p * Math.PI);
  const head = point(side ? 27 : 24, 23 + rise + (action === "inspect" ? Math.round(gesture) : 0));
  const feet = side ? [point(20 + step, 43 - (step < 0 ? 1 : 0)), point(30 - step, 43 - (step > 0 ? 1 : 0))]
    : [point(18, 43 - (step < 0 ? 2 : 0)), point(30, 43 - (step > 0 ? 2 : 0))];
  const shoulder = point(side ? 32 : back ? 31 : 16, 32 + rise);
  const farShoulder = point(side ? mirrored && action !== "carry" ? 32 : 24 : back ? 16 : 32, 32 + rise);
  const rest = point(side ? 35 : back ? 34 : 13, 36 + rise);
  const restHead = point(side ? 38 : back ? 35 : 12, 41 + rise);
  const toolBehind = back || mirrored, carry = action === "carry";
  let palm = point(rest.x, rest.y + Math.round(step / 2));
  let axeHead = point(restHead.x, restHead.y + Math.round(step / 2));
  let farPalm = point(side ? mirrored && !carry ? 35 : 27 : back ? 15 : 34, 36 + rise - Math.round(step / 2));
  if (action === "work") {
    const lifted = point(side ? 37 : back ? 37 : 11, 32 + rise);
    const liftedHead = point(side ? 42 : back ? 41 : 6, 34 + rise);
    const struck = point(side ? 37 : back ? 37 : 11, 37 + rise);
    const struckHead = point(side ? 42 : back ? 41 : 6, 40 + rise);
    const pose = (start: WorldPoint, lift: WorldPoint, strike: WorldPoint) => p < .25 ? mix(start, lift, p / .25)
      : p < .4375 ? mix(lift, strike, (p - .25) / .1875) : p < .75 ? mix(strike, start, (p - .4375) / .3125) : start;
    palm = pose(rest, lifted, struck); axeHead = pose(restHead, liftedHead, struckHead);
  } else if (carry) {
    palm = point(side ? 34 : back ? 32 : 16, 37 + rise);
    farPalm = point(side ? 23 : back ? 15 : 32, 37 + rise);
  } else if (action === "greet") {
    farPalm = mix(farPalm, point(side ? mirrored ? 38 : 25 : back ? 12 : 37, 28 + rise), gesture);
  } else if (action === "inspect" || action === "trade") {
    farPalm = mix(farPalm, point(side ? 29 : back ? 18 : 29, (action === "trade" ? 35 : 33) + rise), gesture);
  }
  const drawAxe = () => {
    segment(palm, axeHead, palette.outline, 3); segment(palm, axeHead, palette.handle, 1);
    const outward = side || back ? 1 : -1;
    rect(axeHead.x - 1, axeHead.y - 2, 3, 5, palette.outline);
    rect(axeHead.x + (outward > 0 ? 1 : -4), axeHead.y - 3, 4, 6, palette.outline);
    rect(axeHead.x + (outward > 0 ? 1 : -3), axeHead.y - 2, 3, 4, palette.steel);
    rect(axeHead.x + (outward > 0 ? 3 : -3), axeHead.y - 2, 1, 4, palette.steelLight);
  };
  const drawPaw = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    segment(mix(from, to, .3), to, palette.shadow, 4);
    segment(mix(from, to, .4), to, near ? palette.honey : palette.fur, 2);
    oval(to.x, to.y, 2, 2, palette.shadow); oval(to.x, to.y - 1, 2, 1, near ? palette.light : palette.honey);
  };
  const logCenter = point(side ? 29 : 24, 36 + rise);
  const drawLog = () => {
    rect(logCenter.x - 12, logCenter.y - 3, 24, 8, palette.outline);
    rect(logCenter.x - 11, logCenter.y - 2, 22, 6, palette.bark);
    rect(logCenter.x - 10, logCenter.y - 2, 19, 1, palette.barkLight);
    rect(logCenter.x - 8, logCenter.y + 1, 12, 1, palette.outline);
    oval(logCenter.x + 11, logCenter.y, 3, 4, palette.outline);
    oval(logCenter.x + 11, logCenter.y, 2, 3, palette.end);
    rect(logCenter.x + 10, logCenter.y - 1, 2, 3, palette.ring);
    rect(logCenter.x + 11, logCenter.y, 1, 1, palette.end);
  };
  for (const [index, foot] of feet.entries()) {
    oval(foot.x, foot.y, 4, 1, palette.outline);
    oval(foot.x, foot.y - 1, 4, 1, index === 0 && side ? palette.fur : palette.honey);
    rect(foot.x + 1, foot.y, 1, 1, palette.shadow);
  }
  if (!carry && toolBehind) { drawAxe(); drawPaw(shoulder, palm, false); }
  if (carry && back) { drawLog(); drawPaw(shoulder, palm, false); drawPaw(farShoulder, farPalm, false); }
  else drawPaw(farShoulder, farPalm, false);
  // A little round tail distinguishes the profile even when the axe is hidden.
  if (side) { oval(13, 36 + rise, 4, 4, palette.shadow); oval(12, 35 + rise, 3, 3, palette.cream); }
  oval(side ? 25 : 24, 35 + rise, 10, 8, palette.outline);
  oval(side ? 25 : 24, 34 + rise, 9, 8, palette.fur);
  if (!back) { oval(side ? 28 : 24, 34 + rise, 7, 7, palette.cream); oval(side ? 29 : 23, 32 + rise, 5, 5, palette.pale); }
  else { oval(24, 37 + rise, 4, 4, palette.shadow); oval(24, 36 + rise, 3, 3, palette.cream); }
  // Ears have a narrow upright shaft, rounded tips and a deliberate folded end.
  const straightX = side ? 21 : back ? 31 : 17, foldedX = side ? 28 : back ? 17 : 30;
  const ear = (path: WorldPoint[], folded: boolean) => {
    for (let i = 1; i < path.length; i++) segment(path[i - 1], path[i], palette.outline, 7);
    for (let i = 1; i < path.length; i++) segment(path[i - 1], path[i], palette.honey, 5);
    if (!back) for (let i = 1; i < path.length; i++) segment(path[i - 1], path[i], palette.innerEar, 2);
    const tip = path.at(-1)!; rect(tip.x - 1, tip.y - (folded ? 0 : 1), 2, 2, palette.light);
  };
  ear([point(straightX, 19 + rise), point(straightX - 1, 6 + rise)], false);
  ear([point(foldedX, 19 + rise), point(foldedX, 9 + rise), point(foldedX + (back ? -4 : 4), 8 + rise),
    point(foldedX + (back ? -5 : 5), 12 + rise)], true);
  oval(head.x, head.y, side ? 10 : 11, 9, palette.outline);
  oval(head.x, head.y - 1, side ? 9 : 10, 8, palette.honey);
  oval(head.x - (side ? 2 : 2), head.y - 4, side ? 5 : 7, 4, palette.light);
  if (!back) {
    const muzzleX = head.x + (side ? 5 : 0);
    oval(muzzleX, head.y + 4, side ? 7 : 9, 5, palette.cream);
    oval(muzzleX - (side ? -1 : 3), head.y + 3, side ? 4 : 5, 3, palette.pale);
    if (!side) oval(head.x + 4, head.y + 3, 4, 3, palette.pale);
    for (const eyeX of side ? [head.x + 3] : [head.x - 5, head.x + 4]) {
      rect(eyeX, head.y - 1, 2, blink || action === "rest" ? 1 : 3, palette.eye);
      if (!blink && action !== "rest") rect(eyeX, head.y - 1, 1, 1, palette.pale);
    }
    rect(muzzleX + (side ? 3 : -1), head.y + 2, 3, 2, palette.blush);
    rect(muzzleX + (side ? 3 : 0), head.y + 4, 1, 2, palette.shadow);
    rect(muzzleX + (side ? 1 : -2), head.y + 6, side ? 2 : 5, 1, palette.shadow);
    if (!side && action !== "rest") rect(muzzleX, head.y + 6, 2, 2, palette.pale);
  }
  // Small leaf-coloured neckerchief; the cream chest remains clear below it.
  rect(side ? 26 : 18, 30 + rise, side ? 9 : 13, 2, palette.scarf);
  rect(side ? 29 : 22, 31 + rise, 4, 3, palette.scarfLight);
  rect(side ? 29 : 23, 34 + rise, 2, 1, palette.scarf);
  if (carry && !back) { drawLog(); drawPaw(farShoulder, farPalm, mirrored); drawPaw(shoulder, palm, !mirrored); }
  else if (!back) {
    if (!side || mirrored) drawPaw(farShoulder, farPalm, mirrored);
    if (!toolBehind) { drawAxe(); drawPaw(shoulder, palm, true); }
  }
  const planted = feet.filter(foot => foot.y === 43).map(mirror);
  rigs.set(canvas, {
    contact: { bottom: 45, left: Math.min(...planted.map(foot => foot.x - 4)), right: Math.max(...planted.map(foot => foot.x + 5)) },
    head: mirror(head), feet: feet.map(mirror),
    arms: [{ hand: "left", shoulder: mirror(farShoulder), palm: mirror(farPalm) },
      { hand: "right", shoulder: mirror(shoulder), palm: mirror(palm) }],
    axe: { grip: mirror(palm), head: mirror(axeHead), behindBody: toolBehind, visible: !carry },
    ...(carry ? { log: { center: mirror(logCenter), leftGrip: mirror(farPalm), rightGrip: mirror(palm) } } : {}),
  });
  cache.set(key, canvas);
  if (cache.size > LOPUKH_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
