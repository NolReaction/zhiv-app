import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { forestVillagerGait } from "../forest-villager-gait";
import type { WorldPoint } from "@/features/world/tiled/types";
import type { ForestVillagerAction } from "../forest-villager-types";

export const LOPUKH_SPRITE_SIZE = 48;
export const LOPUKH_SPRITE_CACHE_LIMIT = 192;
export type LopukhSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  head: WorldPoint;
  ears: readonly WorldPoint[];
  feet: readonly WorldPoint[];
  arms: readonly { hand: "left" | "right"; shoulder: WorldPoint; palm: WorldPoint }[];
  axe: { grip: WorldPoint; head: WorldPoint; butt: WorldPoint; blade: readonly WorldPoint[]; behindBody: boolean; visible: boolean };
  log?: { center: WorldPoint; leftGrip: WorldPoint; rightGrip: WorldPoint };
};

const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, LopukhSpriteRig>();
export const lopukhSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const palette = {
  outline: "#64432e", shadow: "#967044", fur: "#c59655", honey: "#ddb16b", light: "#edc987",
  cream: "#f1dbad", pale: "#ffebc5", blush: "#cc957c", innerEar: "#dfae91", eye: "#382e28",
  scarf: "#617453", scarfLight: "#88946a", bark: "#775134", barkLight: "#a87947",
  end: "#deb67c", ring: "#b88b55", steelDark: "#536963", steel: "#849993", steelLight: "#c1cec0", handle: "#b38955",
};
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];
const actions: readonly ForestVillagerAction[] = ["idle", "walk", "work", "carry", "unload", "inspect", "greet", "rest", "trade"];
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const mix = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** A honey-coloured rabbit with one folded ear. Every painted source pixel is
 * opaque and integer-aligned; world lighting and opacity belong to the painter. */
export function lopukhSprite(action: ForestVillagerAction, direction: PixelDirection, frame: number,
  phase = 0, still = false): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clock = still || !Number.isFinite(frame) ? 0 : ((Math.trunc(frame) % 32) + 32) % 32;
  const stride = action === "walk" || action === "carry" ? clock % 16 : 0;
  const stage = !still && ["work", "inspect", "greet", "trade", "unload"].includes(action)
    ? Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 16) : 0;
  const breathe = !still && ["idle", "rest"].includes(action) && clock >= 8 && clock < 20 ? 1 : 0;
  const blink = !still && action === "idle" && clock === 30;
  const earWiggle = !still && (action === "idle" && clock >= 24 && clock < 28
    || action === "greet" && stage >= 5 && stage <= 11
    || action === "walk" && stride % 8 >= 2 && stride % 8 <= 6) ? 1 : 0;
  const key = `${action}:${direction}:${stride}:${stage}:${breathe}:${Number(blink)}:${earWiggle}`;
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
  const polygon = (vertices: readonly WorldPoint[], color: string) => {
    const minY = Math.min(...vertices.map(vertex => vertex.y)), maxY = Math.max(...vertices.map(vertex => vertex.y));
    for (let y = minY; y <= maxY; y++) {
      const crossings: number[] = [];
      vertices.forEach((a, index) => {
        const b = vertices[(index + 1) % vertices.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) crossings.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
      });
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const left = Math.ceil(crossings[i]), right = Math.floor(crossings[i + 1]);
        if (right >= left) rect(left, y, right - left + 1, 1, color);
      }
    }
    vertices.forEach((a, index) => segment(a, vertices[(index + 1) % vertices.length], color, 1));
  };
  const gait = forestVillagerGait(stride), step = gait.step;
  const bob = action === "walk" || action === "carry" ? gait.bob : 0;
  const rise = bob - breathe + (action === "rest" ? 1 : 0), p = stage / 16;
  const gesture = (1 - Math.cos(p * Math.PI * 2)) / 2;
  const unloading = action === "unload";
  const lowered = unloading ? Math.round((1 - Math.cos(Math.min(1, p / .65) * Math.PI)) * 2) : 0;
  const crouch = Math.round(lowered / 2), upperRise = rise + crouch;
  const release = unloading ? (1 - Math.cos(Math.max(0, (p - .65) / .35) * Math.PI)) / 2 : 0;
  const head = point(side ? 27 : 24, 23 + upperRise);
  const feet = side ? [point(20 + step, 43 - Math.min(1, gait.leftLift)), point(30 - step, 43 - Math.min(1, gait.rightLift))]
    : [point(18, 43 - gait.leftLift), point(30, 43 - gait.rightLift)];
  const carry = action === "carry" || unloading;
  const shoulder = point(side ? 32 : back ? 31 : 16, 32 + upperRise);
  const farShoulder = point(side ? mirrored && !carry ? 32 : 24 : back ? 16 : 32, 32 + upperRise);
  const rest = point(side ? 35 : back ? 34 : 13, 36 + upperRise);
  const axeRest = point(rest.x + (side || back ? 1 : 0), rest.y - 2);
  const toolBehind = back || mirrored;
  let palm = point(axeRest.x, axeRest.y + gait.swing);
  let axeAngle = -Math.PI * .28;
  let farPalm = point(side ? mirrored && !carry ? 35 : 27 : back ? 15 : 34, 36 + rise - gait.swing);
  if (action === "work") {
    const lifted = point(side || back ? 38 : 12, 29 + rise);
    const struck = point(side || back ? 32 : 12, 34 + rise);
    const pose = (start: number, lift: number, strike: number) => p < .25 ? start + (lift - start) * p / .25
      : p < .5 ? lift + (strike - lift) * (p - .25) / .25
        : p < .75 ? strike + (start - strike) * (p - .5) / .25 : start;
    palm = point(pose(axeRest.x, lifted.x, struck.x), pose(axeRest.y, lifted.y, struck.y));
    axeAngle = pose(-.28, -.46, .1) * Math.PI;
  } else if (carry) {
    palm = mix(point(side ? 34 : back ? 32 : 16, 37 + rise + lowered), rest, release);
    farPalm = mix(point(side ? 23 : back ? 15 : 32, 37 + rise + lowered),
      point(side ? 27 : back ? 15 : 34, 36 + upperRise), release);
  } else if (action === "greet") {
    farPalm = mix(farPalm, point(side ? mirrored ? 38 : 25 : back ? 12 : 37, 28 + rise), gesture);
  } else if (action === "inspect" || action === "trade") {
    farPalm = mix(farPalm, point(side ? 29 : back ? 18 : 29, (action === "trade" ? 35 : 33) + rise), gesture);
  }
  const outward = side || back ? 1 : -1;
  const axis = { x: Math.cos(axeAngle) * outward, y: Math.sin(axeAngle) };
  const normal = { x: -axis.y * outward, y: axis.x * outward };
  const axeHead = point(palm.x + axis.x * 7, palm.y + axis.y * 7);
  const axePoint = (along: number, across: number) => point(axeHead.x + axis.x * along + normal.x * across,
    axeHead.y + axis.y * along + normal.y * across);
  const axeButt = point(palm.x - axis.x * 3, palm.y - axis.y * 3);
  const axeBlade = [[-1, -1], [1, -1], [3.5, 5], [-3.5, 5]].map(([along, across]) => axePoint(along, across));
  const drawAxe = () => {
    // One rigid hatchet rotates around the anatomical right paw. The eye sits
    // on the haft, while the steel wedge flares across it.
    segment(axeButt, axeHead, palette.outline, 3);
    segment(axeButt, axeHead, palette.handle, 2);
    polygon(axeBlade, palette.steelDark);
    polygon([[-1, 0], [1, 0], [2.5, 4], [-2.5, 4]].map(([along, across]) => axePoint(along, across)), palette.steel);
    segment(axePoint(-2.5, 4), axePoint(2.5, 4), palette.steelLight, 1);
    const eye = axePoint(0, 0); rect(eye.x, eye.y, 1, 1, palette.handle);
  };
  const drawPaw = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    segment(mix(from, to, .3), to, palette.shadow, 4);
    segment(mix(from, to, .4), to, near ? palette.honey : palette.fur, 2);
    oval(to.x, to.y, 2, 2, palette.shadow); oval(to.x, to.y - 1, 2, 1, near ? palette.light : palette.honey);
  };
  const logCenter = point(side ? 29 : 24, 36 + rise + lowered);
  const logLeftGrip = point(side ? 23 : back ? 15 : 32, logCenter.y + 1);
  const logRightGrip = point(side ? 34 : back ? 32 : 16, logCenter.y + 1);
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
  oval(side ? 25 : 24, 35 + upperRise, 10, 8 - crouch, palette.outline);
  oval(side ? 25 : 24, 34 + upperRise, 9, 8 - crouch, palette.fur);
  if (!back) { oval(side ? 28 : 24, 34 + upperRise, 7, 7 - crouch, palette.cream); oval(side ? 29 : 23, 32 + upperRise, 5, 5 - crouch, palette.pale); }
  else { oval(24, 37 + rise, 4, 4, palette.shadow); oval(24, 36 + rise, 3, 3, palette.cream); }
  // Ears have a narrow upright shaft, rounded tips and a deliberate folded end.
  const straightX = side ? 21 : back ? 31 : 17, foldedX = side ? 28 : back ? 17 : 30;
  const ear = (path: WorldPoint[], folded: boolean) => {
    for (let i = 1; i < path.length; i++) segment(path[i - 1], path[i], palette.outline, 7);
    for (let i = 1; i < path.length; i++) segment(path[i - 1], path[i], palette.honey, 5);
    if (!back) for (let i = 1; i < path.length; i++) segment(path[i - 1], path[i], palette.innerEar, 2);
    const tip = path.at(-1)!; rect(tip.x - 1, tip.y - (folded ? 0 : 1), 2, 2, palette.light);
  };
  const uprightTip = point(straightX - 1 - earWiggle, 6 + upperRise);
  const foldedTip = point(foldedX + (back ? -1 : 1) * (5 + earWiggle), 12 + upperRise + earWiggle);
  ear([point(straightX, 19 + upperRise), uprightTip], false);
  ear([point(foldedX, 19 + upperRise), point(foldedX, 9 + upperRise), point(foldedX + (back ? -4 : 4), 8 + upperRise),
    foldedTip], true);
  oval(head.x, head.y, side ? 10 : 11, 9, palette.outline);
  oval(head.x, head.y - 1, side ? 9 : 10, 8, palette.honey);
  oval(head.x - (side ? 2 : 2), head.y - 4, side ? 5 : 7, 4, palette.light);
  if (!back) {
    // Matching front cheeks and a centred nose/teeth keep his face straight.
    // The compact profile has one readable cheek instead of a long flat snout.
    if (side) {
      oval(head.x + 4, head.y + 4, 6, 4, palette.cream);
      oval(head.x + 5, head.y + 3, 4, 2, palette.pale);
    } else for (const offset of [-4, 4]) {
      oval(head.x + offset, head.y + 4, 5, 4, palette.cream);
      oval(head.x + offset, head.y + 3, 3, 2, palette.pale);
    }
    for (const eyeX of side ? [head.x + 3] : [head.x - 5, head.x + 4]) {
      rect(eyeX, head.y - 2, 2, blink || action === "rest" ? 1 : 3, palette.eye);
      if (!blink && action !== "rest") rect(eyeX, head.y - 2, 1, 1, palette.pale);
    }
    rect(head.x + (side ? 7 : -1), head.y + 2, 3, 1, palette.blush);
    rect(head.x + (side ? 8 : 0), head.y + 3, 1, 1, palette.blush);
    rect(head.x + (side ? 8 : 0), head.y + 4, 1, 2, palette.shadow);
    if (side) rect(head.x + 6, head.y + 6, 2, 1, palette.shadow);
    else {
      rect(head.x - 2, head.y + 6, 2, 1, palette.shadow);
      rect(head.x + 1, head.y + 6, 2, 1, palette.shadow);
      if (action !== "rest") rect(head.x - 1, head.y + 6, 3, 2, palette.pale);
    }
  }
  // Small leaf-coloured neckerchief; the cream chest remains clear below it.
  rect(side ? 26 : 18, 30 + upperRise, side ? 9 : 13, 2, palette.scarf);
  rect(side ? 29 : 22, 31 + upperRise, 4, 3, palette.scarfLight);
  rect(side ? 29 : 23, 34 + upperRise, 2, 1, palette.scarf);
  if (carry && !back) { drawLog(); drawPaw(farShoulder, farPalm, mirrored); drawPaw(shoulder, palm, !mirrored); }
  else if (!back) {
    if ((!side || mirrored) && action !== "greet") drawPaw(farShoulder, farPalm, mirrored);
    if (!toolBehind) { drawAxe(); drawPaw(shoulder, palm, true); }
  }
  const planted = feet.filter(foot => foot.y === 43).map(mirror);
  rigs.set(canvas, {
    contact: { bottom: 45, left: Math.min(...planted.map(foot => foot.x - 4)), right: Math.max(...planted.map(foot => foot.x + 5)) },
    head: mirror(head), ears: [uprightTip, foldedTip].map(mirror), feet: feet.map(mirror),
    arms: [{ hand: "left", shoulder: mirror(farShoulder), palm: mirror(farPalm) },
      { hand: "right", shoulder: mirror(shoulder), palm: mirror(palm) }],
    axe: { grip: mirror(palm), head: mirror(axeHead), butt: mirror(axeButt), blade: axeBlade.map(mirror), behindBody: toolBehind, visible: !carry },
    ...(carry ? { log: { center: mirror(logCenter), leftGrip: mirror(logLeftGrip), rightGrip: mirror(logRightGrip) } } : {}),
  });
  cache.set(key, canvas);
  if (cache.size > LOPUKH_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
