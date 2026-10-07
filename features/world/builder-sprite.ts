import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { BuilderAction } from "./builder-types";
import type { WorldPoint } from "./tiled/types";

export const BUILDER_SPRITE_SIZE = 48;
export const BUILDER_SPRITE_CACHE_LIMIT = 128;
export type BuilderSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  head: WorldPoint;
  feet: readonly WorldPoint[];
  arms: readonly { hand: "left" | "right"; shoulder: WorldPoint; palm: WorldPoint }[];
  mallet: { grip: WorldPoint; head: WorldPoint; behindBody: boolean };
};
const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, BuilderSpriteRig>();
export const builderSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const colors = {
  outline: "#503a2d", deep: "#664731", spine: "#8b5b34", spineLight: "#ad7841", tip: "#c69858",
  fur: "#bd8a50", light: "#dca96b", cream: "#ecd5a4", pale: "#fae7bd", shade: "#c7a97b",
  eye: "#342b25", ear: "#be835f", belt: "#65705a", beltLight: "#899070", brass: "#cfb371",
  handle: "#9b764b", wood: "#c5a16d", woodLight: "#e0bf88",
};
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const mix = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];
const actions: readonly BuilderAction[] = ["idle", "walk", "work", "inspect", "finish", "greet"];

/** Pine-cone quills, short paws and a small wooden mallet are drawn entirely on
 * the same opaque source-pixel grid as the other forest residents. */
export function builderSprite(action: BuilderAction, direction: PixelDirection, frame: number,
  phase = 0, still = false): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clock = still ? 0 : Number.isFinite(frame) ? ((Math.trunc(frame) % 32) + 32) % 32 : 0;
  const index = action === "walk" ? clock % 8 : 0;
  const stage = still ? 0 : ["work", "inspect", "finish", "greet"].includes(action)
    ? Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 16) : 0;
  const breathe = !still && action === "idle" && clock >= 8 && clock < 20 ? 1 : 0;
  const blink = !still && action === "idle" && clock === 30;
  const key = `${action}:${direction}:${index}:${stage}:${breathe}:${Number(blink)}`;
  const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found; }
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = BUILDER_SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const mirrored = direction === "left", back = direction === "back", side = direction === "left" || direction === "right";
  const mirror = (p: WorldPoint) => point(mirrored ? 47 - p.x : p.x, p.y);
  const rect = (x: number, y: number, width: number, height: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(mirrored ? 48 - x - width : x, y, width, height);
  };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    for (let row = -ry; row <= ry; row++) {
      const extent = Math.floor(rx * Math.sqrt(Math.max(0, 1 - row * row / ((ry + .3) * (ry + .3)))));
      rect(x - extent, y + row, extent * 2 + 1, 1, color);
    }
  };
  const segment = (a: WorldPoint, b: WorldPoint, color: string, width = 2) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let step = 0; step <= steps; step++) {
      const p = mix(a, b, step / steps); rect(p.x - 1, p.y - 1, width, width, color);
    }
  };
  const step = action === "walk" ? [0, 1, 2, 1, 0, -1, -2, -1][index] : 0;
  const bob = action === "walk" && [1, 2, 5, 6].includes(index) ? -1 : 0;
  const rise = bob - breathe;
  const p = stage / 16;
  const gesture = Math.sin(p * Math.PI);
  const nod = action === "inspect" || action === "finish" ? Math.round(gesture) : 0;
  const head = point(side ? 29 : 24, 21 + rise + nod);
  const feet = side
    ? [point(19 + step, 43 - (step < 0 ? 1 : 0)), point(30 - step, 43 - (step > 0 ? 1 : 0))]
    : [point(18, 43 - (step < 0 ? 2 : 0)), point(30, 43 - (step > 0 ? 2 : 0))];
  // The same right paw keeps the mallet in every view: screen-left from the
  // front, screen-right from behind, near on a right profile and far on a left.
  // Keep the resting head down by the belt, away from the muzzle and eyes.
  const toolBehind = back || mirrored, outward = !side && !back ? -1 : 1;
  const shoulder = point(side ? 32 : back ? 31 : 16, 33 + rise);
  const farShoulder = point(side ? (mirrored ? 27 : 25) : back ? 16 : 31, 33 + rise);
  const rest = point(side ? 35 : back ? 27 : 14, 36 + rise);
  let palm = point(rest.x, rest.y + Math.round(step / 2));
  let farPalm = point(side ? (mirrored ? 29 : 27) : back ? 16 : 33, 36 + rise - Math.round(step / 2));
  const restHead = point(rest.x + outward, rest.y + 5);
  let malletHead = point(restHead.x, restHead.y + Math.round(step / 2));
  if (action === "work") {
    // One short lift, tap and return. Interpolate the head with the grip so the
    // handle never flips across the face between adjacent animation stages.
    const lifted = point(side ? 37 : back ? 35 : 11, 31 + rise);
    const struck = point(side ? 38 : back ? 37 : 10, 37 + rise);
    const liftedHead = point(lifted.x + outward * 4, lifted.y);
    const struckHead = point(struck.x + outward * 4, struck.y + 1);
    const pose = (restPoint: WorldPoint, highPoint: WorldPoint, tapPoint: WorldPoint) =>
      p < .25 ? mix(restPoint, highPoint, p / .25) : p < .4375 ? mix(highPoint, tapPoint, (p - .25) / .1875)
        : p < .6875 ? mix(tapPoint, restPoint, (p - .4375) / .25) : restPoint;
    palm = pose(rest, lifted, struck); malletHead = pose(restHead, liftedHead, struckHead);
    farPalm = point(side ? (mirrored ? 29 : 27) : back ? 19 : 30, 35 + rise);
  } else if (action === "greet") {
    farPalm = point(farPalm.x + (p > .2 && p < .75 ? 1 : 0), farPalm.y - Math.round(Math.sin(p * Math.PI) * 4));
  } else if (action === "inspect" || action === "finish") {
    // The free paw checks the pouch or rests on the chest for a satisfied nod.
    // The dominant paw keeps its mallet down; neither gesture crosses the face.
    const checked = action === "inspect"
      ? point(side ? (mirrored ? 27 : 28) : back ? 19 : 28, 37 + rise)
      : point(side ? (mirrored ? 29 : 28) : back ? 18 : 29, 33 + rise);
    farPalm = mix(farPalm, checked, gesture);
  }
  const drawMallet = () => {
    segment(palm, malletHead, colors.outline, 3); segment(palm, malletHead, colors.handle);
    rect(malletHead.x - 4, malletHead.y - 2, 8, 5, colors.outline);
    rect(malletHead.x - 3, malletHead.y - 1, 6, 3, colors.wood);
    rect(malletHead.x - 3, malletHead.y - 1, 6, 1, colors.woodLight);
    rect(malletHead.x + 2, malletHead.y, 1, 2, colors.handle);
  };
  const drawPaw = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    if (action === "work" && near) {
      // Only the exposed forearm is drawn; the shoulder remains in the fur.
      const elbow = mix(from, to, .5);
      segment(elbow, to, colors.spine, 3); segment(elbow, to, colors.fur);
    }
    oval(to.x, to.y, 2, 2, colors.spine);
    oval(to.x, to.y - 1, 1, 1, near ? colors.light : colors.fur);
  };
  const quill = (x: number, y: number, width: number, height: number, bright: boolean) => {
    // Broad overlapping pointed scales read as a pine cone, not long needles.
    for (let row = 0; row < height; row++) {
      const half = Math.max(0, Math.round(width * (row < height * .55 ? row / (height * .55) : (height - row) / (height * .45))));
      rect(x - half, y + row, half * 2 + 1, 1, colors.deep);
      if (half > 0 && row < height - 2) rect(x - half + 1, y + row, half * 2 - 1, 1, bright ? colors.spineLight : colors.spine);
      if (half > 1 && row < height * .55) rect(x - half + 1, y + row, 1, 1, colors.tip);
    }
  };
  for (const [index, foot] of feet.entries()) {
    oval(foot.x, foot.y, 4, 1, colors.outline);
    oval(foot.x, foot.y - 1, 3, 1, index === 0 && side ? colors.spine : colors.fur);
    rect(foot.x - 1, foot.y, 1, 1, colors.spine); rect(foot.x + 1, foot.y, 1, 1, colors.spine);
  }
  if (toolBehind) { drawMallet(); drawPaw(shoulder, palm, false); }
  if (back) drawPaw(farShoulder, farPalm, false);
  oval(side ? 20 : 24, 26 + rise, side ? 14 : 16, 17, colors.outline);
  oval(side ? 20 : 24, 25 + rise, side ? 13 : 15, 16, colors.spine);
  const rows = side ? [[12, 10, 3], [10, 17, 3], [9, 24, 3], [11, 31, 3]] : [[15, 9, 3], [10, 16, 4], [9, 23, 4], [11, 30, 4]];
  for (const [x, y, count] of rows) for (let i = 0; i < count; i++) quill(x + i * 8, y + rise + (i % 2), 4, 10, i % 2 === 0);
  if (!back) {
    oval(side ? 28 : 24, 33 + rise, side ? 9 : 10, 10, colors.fur);
    oval(side ? 29 : 24, 34 + rise, 7, 8, colors.shade);
    oval(side ? 30 : 23, 32 + rise, 6, 7, colors.cream);
    oval(side ? 31 : 22, 30 + rise, 4, 4, colors.pale);
    const ears = side ? [point(24, 14 + rise)] : [point(15, 15 + rise), point(33, 15 + rise)];
    for (const ear of ears) {
      oval(ear.x, ear.y, 3, 4, colors.spine); oval(ear.x, ear.y, 2, 3, colors.light);
      rect(ear.x - 1, ear.y, 2, 2, colors.ear);
    }
    oval(head.x, head.y, side ? 10 : 11, 9, colors.fur);
    oval(head.x + (side ? 2 : 0), head.y + 2, side ? 8 : 9, 7, colors.cream);
    oval(head.x + (side ? 3 : -1), head.y + 2, 6, 5, colors.pale);
    if (side) {
      oval(head.x + 8, head.y + 2, 4, 3, colors.cream);
      rect(head.x + 10, head.y + 1, 3, 2, colors.eye);
      rect(head.x + 8, head.y + 5, 2, 1, colors.spine);
    } else {
      rect(head.x - 1, head.y + 3, 3, 2, colors.eye);
      rect(head.x, head.y + 6, 2, 1, colors.spine);
    }
    for (const eyeX of side ? [head.x + 3] : [head.x - 5, head.x + 5]) {
      rect(eyeX, head.y, 2, blink ? 1 : 3, colors.eye);
      if (!blink) rect(eyeX, head.y, 1, 1, colors.pale);
    }
    // A narrow tool belt and one pouch leave the cream belly visible.
    rect(side ? 24 : 16, 36 + rise, side ? 11 : 17, 3, colors.belt);
    rect(side ? 24 : 16, 36 + rise, side ? 11 : 17, 1, colors.beltLight);
    rect(side ? 31 : 23, 36 + rise, 3, 3, colors.brass);
    rect(side ? 24 : 16, 37 + rise, 5, 5, colors.spine);
    rect(side ? 25 : 17, 37 + rise, 4, 3, colors.handle);
    drawPaw(farShoulder, farPalm, mirrored);
    if (!toolBehind) { drawMallet(); drawPaw(shoulder, palm, true); }
  }
  const planted = feet.filter(foot => foot.y === 43).map(mirror);
  rigs.set(canvas, {
    contact: { bottom: 45, left: Math.min(...planted.map(foot => foot.x - 4)), right: Math.max(...planted.map(foot => foot.x + 5)) },
    head: mirror(head), feet: feet.map(mirror),
    arms: [{ hand: "left", shoulder: mirror(farShoulder), palm: mirror(farPalm) },
      { hand: "right", shoulder: mirror(shoulder), palm: mirror(palm) }],
    mallet: { grip: mirror(palm), head: mirror(malletHead), behindBody: toolBehind },
  });
  cache.set(key, canvas);
  if (cache.size > BUILDER_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
