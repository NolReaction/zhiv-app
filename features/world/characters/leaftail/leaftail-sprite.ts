import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { ForestVillagerAction } from "@/features/world/characters/forest-villager-types";
import { forestVillagerGait } from "../forest-villager-gait";
import type { WorldPoint } from "@/features/world/tiled/types";

export const LEAFTAIL_SPRITE_SIZE = 48;
export const LEAFTAIL_SPRITE_CACHE_LIMIT = 192;
export type LeaftailSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  head: WorldPoint; feet: readonly WorldPoint[]; tail: WorldPoint;
  arms: readonly { hand: "left" | "right"; shoulder: WorldPoint; palm: WorldPoint }[];
  tool: { grip: WorldPoint; bundle: WorldPoint; coin: WorldPoint; behindBody: boolean };
};
const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, LeaftailSpriteRig>();
export const leaftailSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const colors = {
  outline: "#69402d", deep: "#8b492c", fur: "#c77139", light: "#e4954d", glow: "#efb166",
  cream: "#f0dcac", pale: "#fff0ca", shade: "#d4b57e", eye: "#352e24", ear: "#bc7153",
  tail: "#d89b40", tailLight: "#edba5d", tailVein: "#b77b36", tailShade: "#ba7834",
  scarf: "#6c8051", scarfLight: "#94a36b", cloth: "#b4a279", clothLight: "#d7c593",
  cord: "#786746", coin: "#eac169", coinShade: "#b68b3f",
};
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const mix = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const actions: readonly ForestVillagerAction[] = ["idle", "walk", "work", "carry", "inspect", "greet", "rest", "trade"];
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];

/** A broad golden leaf-tail, russet ears and a little tied parcel distinguish
 * the trader on the same opaque source-pixel grid as Mochlik and Pleska. */
export function leaftailSprite(action: ForestVillagerAction, direction: PixelDirection, frame: number,
  phase = 0, still = false): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clock = still ? 0 : Number.isFinite(frame) ? ((Math.trunc(frame) % 32) + 32) % 32 : 0;
  const index = action === "walk" ? clock % 16 : 0;
  const staged = ["work", "trade", "inspect", "greet"].includes(action);
  const stage = still || !staged ? 0 : Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 16);
  const breath = !still && action === "idle" && clock >= 9 && clock < 21 ? 1 : 0;
  const blink = !still && action === "idle" && clock === 30;
  const key = `${action}:${direction}:${index}:${stage}:${breath}:${Number(blink)}`;
  const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found; }
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = LEAFTAIL_SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const mirrored = direction === "left", side = direction === "left" || direction === "right", back = direction === "back";
  const mirror = (p: WorldPoint) => point(mirrored ? 47 - p.x : p.x, p.y);
  const rect = (x: number, y: number, width: number, height: number, color: string) => {
    ctx.fillStyle = color; ctx.fillRect(mirrored ? 48 - x - width : x, y, width, height);
  };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    for (let row = -ry; row <= ry; row++) {
      const half = Math.floor(rx * Math.sqrt(Math.max(0, 1 - row * row / ((ry + .3) * (ry + .3)))));
      rect(x - half, y + row, half * 2 + 1, 1, color);
    }
  };
  const polygon = (vertices: readonly WorldPoint[], color: string) => {
    const low = Math.min(...vertices.map(p => p.y)), high = Math.max(...vertices.map(p => p.y));
    for (let y = low; y < high; y++) {
      const crossings: number[] = [];
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const left = Math.ceil(crossings[i]), right = Math.floor(crossings[i + 1]);
        if (right >= left) rect(left, y, right - left + 1, 1, color);
      }
    }
  };
  const segment = (a: WorldPoint, b: WorldPoint, color: string, width = 2) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let step = 0; step <= steps; step++) { const p = mix(a, b, step / steps); rect(p.x, p.y, width, width, color); }
  };
  const gait = forestVillagerGait(index), stride = gait.step;
  const rise = (action === "walk" ? gait.bob : 0) - breath;
  const resting = action === "rest", progress = stage / 16;
  // Each deliberate action performs one gesture and settles before its end.
  const gesture = progress < .2 ? (1 - Math.cos(Math.PI * progress / .2)) / 2 : progress < .5 ? 1
    : progress < .8 ? (1 + Math.cos(Math.PI * (progress - .5) / .3)) / 2 : 0;
  const nod = action === "inspect" || action === "trade" ? Math.round(gesture) : 0;
  const head = point(side ? 29 : 27, 20 + rise + nod + (resting ? 2 : 0));
  const feet = side
    ? [point(23 + stride, 43 - Math.min(1, gait.leftLift)), point(33 - stride, 43 - Math.min(1, gait.rightLift))]
    : [point(21, 43 - gait.leftLift), point(33, 43 - gait.rightLift)];
  const shoulder = point(side ? 33 : back ? 34 : 20, 32 + rise);
  const farShoulder = point(side ? 26 : back ? 20 : 34, 32 + rise);
  const restPalm = point(side ? 36 : back ? 36 : 18, 36 + rise);
  let palm = point(restPalm.x, restPalm.y + gait.swing);
  let farPalm = point(side ? 27 : back ? 18 : 36, 36 + rise - gait.swing);
  if (action === "trade") palm = mix(restPalm, point(side ? 38 : back ? 37 : 16, 33 + rise), gesture);
  if (action === "work") {
    palm = mix(restPalm, point(side ? 35 : back ? 35 : 19, 35 + rise), gesture);
    farPalm = mix(farPalm, point(side ? 30 : back ? 23 : 30, 37 + rise), gesture);
  } else if (action === "inspect") farPalm = mix(farPalm, point(side ? 29 : back ? 23 : 30, 37 + rise), gesture);
  else if (action === "greet") farPalm = mix(farPalm, point(side ? 28 : back ? 16 : 38, 31 + rise), gesture);
  else if (action === "carry") { palm = point(side ? 34 : back ? 33 : 22, 36 + rise); farPalm = point(side ? 28 : back ? 24 : 30, 37 + rise); }
  else if (resting) { palm.y += 1; farPalm.y += 1; }
  const bundle = point(palm.x + (side || back ? 1 : -1), palm.y + 3);
  const coin = point(palm.x + (side ? 4 : back ? 2 : -2), palm.y - 1);
  const toolBehind = back || mirrored;
  const tailShift = action === "walk" ? gait.swing : 0;
  const tail = point(14 + tailShift, 24);
  const leaf = (coordinates: readonly [number, number][]) => coordinates.map(([x, y]) => point(x + tailShift, y));
  polygon(leaf([[19,41],[11,38],[6,33],[3,24],[4,16],[8,10],[15,3],[20,8],[24,16],[24,25],[21,34]]), colors.outline);
  polygon(leaf([[18,39],[12,36],[8,31],[5,24],[6,17],[10,11],[15,6],[18,10],[22,17],[22,25],[19,33]]), colors.tail);
  polygon(leaf([[15,7],[18,11],[20,17],[19,26],[16,32],[11,33],[8,27],[8,20],[11,13]]), colors.tailLight);
  polygon(leaf([[20,18],[22,19],[21,28],[18,35],[14,36],[17,29]]), colors.tailShade);
  segment(point(18 + tailShift, 38), point(14 + tailShift, 12), colors.tailVein, 1);
  for (const y of [19, 25, 31]) {
    const x = 15 + tailShift;
    segment(point(x, y + 2), point(x - 5, y - 2), colors.tailVein, 1);
    segment(point(x + 1, y + 3), point(x + 5, y - 1), colors.tailVein, 1);
  }
  const drawArm = (from: WorldPoint, to: WorldPoint) => {
    segment(point(from.x - 1, from.y - 1), point(to.x - 1, to.y - 1), colors.outline, 3);
    segment(from, to, colors.fur, 2); oval(to.x, to.y, 2, 2, colors.light);
  };
  const drawParcel = () => {
    oval(bundle.x, bundle.y, 5, 4, colors.outline); oval(bundle.x, bundle.y, 4, 3, colors.cloth);
    rect(bundle.x - 2, bundle.y - 2, 3, 3, colors.clothLight);
    rect(bundle.x - 4, bundle.y, 9, 1, colors.cord); rect(bundle.x, bundle.y - 3, 1, 7, colors.cord);
    rect(bundle.x - 2, bundle.y - 4, 2, 2, colors.clothLight); rect(bundle.x + 1, bundle.y - 4, 2, 2, colors.clothLight);
    if (action === "trade" && stage >= 3 && stage <= 9) {
      oval(coin.x, coin.y, 2, 2, colors.coinShade); oval(coin.x, coin.y, 1, 1, colors.coin); rect(coin.x, coin.y - 1, 1, 2, colors.pale);
    }
  };
  if (toolBehind) { drawArm(shoulder, palm); drawParcel(); }
  drawArm(farShoulder, farPalm);
  for (const foot of feet) { oval(foot.x, foot.y, 4, 1, colors.outline); rect(foot.x - 3, foot.y - 1, 6, 1, colors.deep); }
  oval(side ? 28 : 27, 34 + rise, side ? 8 : 9, 8, colors.outline);
  oval(side ? 28 : 27, 33 + rise, side ? 7 : 8, 8, colors.fur);
  if (!back) { oval(side ? 31 : 27, 34 + rise, side ? 4 : 6, 6, colors.cream); rect(side ? 30 : 25, 30 + rise, 3, 5, colors.pale); }
  // Two pointed ears and rounded cheeks preserve a compact forest silhouette.
  polygon([point(head.x - 9, head.y - 5), point(head.x - 9, head.y - 14), point(head.x - 3, head.y - 9)], colors.outline);
  polygon([point(head.x + 3, head.y - 9), point(head.x + 8, head.y - 14), point(head.x + 10, head.y - 4)], colors.outline);
  polygon([point(head.x - 8, head.y - 6), point(head.x - 8, head.y - 11), point(head.x - 4, head.y - 8)], colors.light);
  polygon([point(head.x + 4, head.y - 8), point(head.x + 7, head.y - 11), point(head.x + 8, head.y - 5)], colors.ear);
  oval(head.x, head.y, side ? 9 : 11, 10, colors.outline);
  oval(head.x, head.y - 1, side ? 8 : 10, 9, colors.fur);
  oval(head.x - 2, head.y - 4, side ? 5 : 7, 4, colors.light);
  if (!back) {
    // Keep the russet brow between the eyes and two little cream cheeks.
    // A single high oval used to put both eyes inside a flat white band.
    if (side) {
      oval(head.x + 4, head.y + 5, 6, 4, colors.cream);
      oval(head.x + 5, head.y + 5, 3, 2, colors.pale);
    } else {
      for (const offset of [-4, 4]) {
        oval(head.x + offset, head.y + 5, 5, 3, colors.cream);
        oval(head.x + offset, head.y + 4, 3, 2, colors.pale);
      }
    }
    const eyes = side ? [head.x + 3] : [head.x - 5, head.x + 5];
    for (const x of eyes) {
      rect(x, head.y - 2, 2, blink || resting ? 1 : 3, colors.eye);
      if (!blink && !resting) rect(x, head.y - 2, 1, 1, colors.pale);
    }
    rect(head.x + (side ? 8 : -1), head.y + 3, side ? 2 : 3, 2, colors.eye);
    rect(head.x + (side ? 8 : 0), head.y + 5, 1, 2, colors.deep);
    if (side) rect(head.x + 6, head.y + 7, 2, 1, colors.outline);
    else {
      rect(head.x - 2, head.y + 7, 2, 1, colors.deep);
      rect(head.x + 1, head.y + 7, 2, 1, colors.deep);
      rect(head.x - 6, head.y + 5, 1, 1, colors.shade);
      rect(head.x + 6, head.y + 5, 1, 1, colors.shade);
    }
  } else {
    oval(head.x, head.y - 3, 6, 5, colors.light);
    rect(head.x - 1, head.y + 2, 3, 4, colors.glow);
  }
  rect(side ? 23 : 19, 29 + rise, side ? 12 : 17, 3, colors.scarf);
  rect(side ? 25 : 22, 29 + rise, side ? 8 : 11, 1, colors.scarfLight);
  if (!back) { polygon([point(32,31 + rise), point(35,31 + rise), point(34,36 + rise), point(31,35 + rise)], colors.scarf); }
  // A satchel flap stays low on his flank; the cream muzzle remains clear.
  oval(side ? 23 : back ? 20 : 34, 38 + rise, 3, 3, colors.outline);
  oval(side ? 23 : back ? 20 : 34, 37 + rise, 2, 2, colors.scarf);
  rect(side ? 23 : back ? 20 : 34, 37 + rise, 1, 1, colors.coin);
  if (!toolBehind) { drawParcel(); drawArm(shoulder, palm); }
  drawArm(farShoulder, farPalm);
  const planted = feet.filter(foot => foot.y === 43).map(mirror);
  rigs.set(canvas, { contact: { bottom: 45, left: Math.min(...planted.map(foot => foot.x - 4)), right: Math.max(...planted.map(foot => foot.x + 5)) },
    head: mirror(head), feet: feet.map(mirror), tail: mirror(tail),
    arms: [{ hand: "right", shoulder: mirror(shoulder), palm: mirror(palm) }, { hand: "left", shoulder: mirror(farShoulder), palm: mirror(farPalm) }],
    tool: { grip: mirror(palm), bundle: mirror(bundle), coin: mirror(coin), behindBody: toolBehind } });
  cache.set(key, canvas); if (cache.size > LEAFTAIL_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
