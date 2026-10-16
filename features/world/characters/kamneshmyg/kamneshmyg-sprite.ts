import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { ForestVillagerAction } from "@/features/world/characters/forest-villager-types";
import type { WorldPoint } from "@/features/world/tiled/types";

export const KAMNESHMYG_SPRITE_SIZE = 48;
export const KAMNESHMYG_SPRITE_CACHE_LIMIT = 160;
export type KamneshmygSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  head: WorldPoint;
  feet: readonly WorldPoint[];
  arms: readonly { hand: "left" | "right"; shoulder: WorldPoint; palm: WorldPoint }[];
  tool: { grip: WorldPoint; head: WorldPoint; tip: WorldPoint; behindBody: boolean; held: boolean };
};

const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, KamneshmygSpriteRig>();
export const kamneshmygSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const colors = {
  outline: "#35414b", furDark: "#4b5b69", fur: "#687e8b", furLight: "#8ca3aa", furPale: "#a6b8ba",
  creamShade: "#bcb9a5", cream: "#e0d8b7", pale: "#f4e9c8", nose: "#805f54", eye: "#29343a",
  helmetDark: "#8e7041", helmet: "#bd9c59", helmetLight: "#dfc17a", lampRim: "#786348", lamp: "#fff1b4",
  strap: "#72694d", strapLight: "#938763", wood: "#9e7b53", woodLight: "#c0a175",
  ironDark: "#4b6269", iron: "#8fa8ac", ironLight: "#c4d4ce", rock: "#86938f", rockLight: "#aebbb0",
};
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const mix = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const actions: readonly ForestVillagerAction[] = ["idle", "walk", "work", "carry", "inspect", "greet", "rest", "trade"];
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];

/** A round slate-furred miner. Every visible pixel is opaque and integral; the
 * lamp, stone and pickaxe are part of the same tiny source grid as the paws. */
export function kamneshmygSprite(action: ForestVillagerAction, direction: PixelDirection, frame: number,
  phase = 0, still = false): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clock = still || !Number.isFinite(frame) ? 0 : ((Math.trunc(frame) % 32) + 32) % 32;
  const index = action === "walk" || action === "carry" ? clock % 8 : 0;
  const stage = still ? 0 : ["work", "inspect", "greet", "trade"].includes(action)
    ? Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 16) : 0;
  const breathe = !still && (action === "idle" || action === "rest") && clock >= 8 && clock < 20 ? 1 : 0;
  const blink = action === "rest" || !still && action === "idle" && clock === 30;
  const key = `${action}:${direction}:${index}:${stage}:${breathe}:${Number(blink)}`;
  const found = cache.get(key);
  if (found) { cache.delete(key); cache.set(key, found); return found; }
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = KAMNESHMYG_SPRITE_SIZE;
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
  const segment = (from: WorldPoint, to: WorldPoint, color: string, width = 2) => {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let step = 0; step <= steps; step++) {
      const p = mix(from, to, step / steps); rect(p.x - 1, p.y - 1, width, width, color);
    }
  };
  const step = [0, 1, 2, 1, 0, -1, -2, -1][index];
  const bob = (action === "walk" || action === "carry") && [1, 2, 5, 6].includes(index) ? -1 : 0;
  const rise = bob - breathe, p = stage / 16, gesture = Math.sin(Math.PI * p);
  const head = point(side ? 28 : 24, 22 + rise + (action === "inspect" ? Math.round(gesture) : 0));
  const feet = side
    ? [point(17 + step, 43 - (step < 0 ? 1 : 0)), point(30 - step, 43 - (step > 0 ? 1 : 0))]
    : [point(17, 43 - (step < 0 ? 2 : 0)), point(30, 43 - (step > 0 ? 2 : 0))];
  const shoulder = point(side ? 32 : back ? 32 : 15, 32 + rise);
  const farShoulder = point(action === "work" ? side || back ? 25 : 29 : side ? 25 : back ? 15 : 32, 32 + rise);
  const restGrip = point(side ? 35 : back ? 35 : 12, 36 + rise);
  const restHead = point(side ? 40 : back ? 40 : 7, 39 + rise);
  let grip = point(restGrip.x, restGrip.y + Math.round(step / 2));
  let pickHead = point(restHead.x, restHead.y + Math.round(step / 2));
  let palm = grip, farPalm = point(side ? 29 : back ? 14 : 34, 36 + rise - Math.round(step / 2));
  const toolHeld = action !== "carry" && action !== "rest";
  const toolBehind = back || mirrored || !toolHeld;
  if (action === "work") {
    const readyGrip = point(side || back ? 35 : 17, 36 + rise);
    const readyHead = point(side || back ? 40 : 10, 39 + rise);
    const highGrip = point(side || back ? 35 : 17, 33 + rise);
    const highHead = point(side || back ? 40 : 10, 32 + rise);
    const tapGrip = point(side || back ? 35 : 17, 37 + rise);
    const tapHead = point(side || back ? 41 : 10, 38 + rise);
    const pose = (restPoint: WorldPoint, highPoint: WorldPoint, tapPoint: WorldPoint) =>
      p < .25 ? mix(restPoint, highPoint, p / .25) : p < .4375 ? mix(highPoint, tapPoint, (p - .25) / .1875)
        : p < .6875 ? mix(tapPoint, restPoint, (p - .4375) / .25) : restPoint;
    grip = pose(readyGrip, highGrip, tapGrip); pickHead = pose(readyHead, highHead, tapHead);
    // The second hand holds the butt of the shaft, beyond the dominant hand;
    // it never reaches across the entire belly to the metal head.
    palm = grip; farPalm = mix(pickHead, grip, 1.55);
  } else if (action === "carry") {
    // The tool is strapped to the back; both broad paws carry the actual stone.
    grip = point(side ? 15 : back ? 18 : 18, 31 + rise); pickHead = point(grip.x - 3, 25 + rise);
    palm = point(side ? 32 : back ? 31 : 16, 36 + rise);
    farPalm = point(side ? 37 : back ? 17 : 32, 36 + rise);
  } else if (action === "rest") {
    grip = point(side ? 15 : 18, 32 + rise); pickHead = point(grip.x - 3, 26 + rise);
    palm = point(side ? 32 : back ? 29 : 19, 38 + rise); farPalm = point(side ? 28 : back ? 19 : 29, 38 + rise);
  } else if (action === "greet") {
    farPalm = point(farPalm.x + Math.round(Math.sin(p * Math.PI * 3)), farPalm.y - Math.round(gesture * 7));
  } else if (action === "inspect" || action === "trade") {
    farPalm = mix(farPalm, point(side ? 34 : back ? 20 : 28, action === "trade" ? 34 + rise : 32 + rise), gesture);
  }
  const pickTip = point(pickHead.x + (side || back ? 4 : -4), pickHead.y + 2);
  const drawPickaxe = () => {
    const butt = action === "work" ? farPalm : grip;
    segment(butt, pickHead, colors.outline, 3); segment(butt, pickHead, colors.wood);
    segment(point(pickHead.x - 4, pickHead.y + 2), point(pickHead.x, pickHead.y - 1), colors.ironDark, 3);
    segment(point(pickHead.x, pickHead.y - 1), point(pickHead.x + 4, pickHead.y + 2), colors.ironDark, 3);
    segment(point(pickHead.x - 3, pickHead.y + 1), point(pickHead.x, pickHead.y - 1), colors.iron);
    segment(point(pickHead.x, pickHead.y - 1), point(pickHead.x + 3, pickHead.y + 1), colors.ironLight);
    rect(grip.x - 1, grip.y - 1, 2, 2, colors.woodLight);
  };
  const drawPaw = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    const elbow = mix(from, to, .4);
    segment(elbow, to, colors.outline, 4); segment(elbow, to, near ? colors.fur : colors.furDark, 3);
    oval(to.x, to.y, 3, 2, colors.outline); oval(to.x, to.y - 1, 2, 1, near ? colors.cream : colors.creamShade);
    rect(to.x - 1, to.y, 1, 1, colors.pale); rect(to.x + 1, to.y, 1, 1, colors.pale);
  };
  const drawStone = () => {
    const x = side ? 33 : 24;
    oval(x, 35 + rise, 7, 5, colors.outline); oval(x, 34 + rise, 6, 4, colors.rock);
    rect(x - 3, 31 + rise, 5, 2, colors.rockLight); rect(x + 3, 34 + rise, 2, 3, colors.furDark);
    rect(x - 1, 34 + rise, 2, 1, colors.creamShade);
  };
  for (const [index, foot] of feet.entries()) {
    oval(foot.x, foot.y, 5, 1, colors.outline);
    oval(foot.x, foot.y - 1, 4, 1, index === 0 && side ? colors.furDark : colors.fur);
    for (const x of [-2, 0, 2]) rect(foot.x + x, foot.y, 1, 1, colors.creamShade);
  }
  if (toolBehind) drawPickaxe();
  if (back) { if (action === "carry") drawStone(); drawPaw(farShoulder, farPalm, false); drawPaw(shoulder, palm, false); }
  oval(side ? 22 : 24, 30 + rise, side ? 13 : 15, 13, colors.outline);
  oval(side ? 22 : 24, 29 + rise, side ? 12 : 14, 13, colors.furDark);
  oval(side ? 24 : 23, 28 + rise, side ? 10 : 12, 12, colors.fur);
  oval(side ? 22 : 20, 25 + rise, 7, 7, colors.furLight);
  if (back) {
    // Warm worn helmet and a diagonal tool strap make the back readable.
    oval(side ? 25 : 24, 17 + rise, 11, 9, colors.fur);
    segment(point(16, 23 + rise), point(31, 39 + rise), colors.strap, 3);
    rect(28, 34 + rise, 5, 5, colors.strapLight);
    rect(20, 29 + rise, 2, 1, colors.furLight); rect(26, 26 + rise, 3, 1, colors.furLight);
  } else {
    oval(side ? 28 : 24, 33 + rise, side ? 8 : 10, 9, colors.creamShade);
    oval(side ? 29 : 23, 32 + rise, side ? 6 : 8, 8, colors.cream);
    oval(side ? 28 : 22, 30 + rise, 4, 5, colors.pale);
    for (const ear of side ? [point(21, 17 + rise)] : [point(13, 17 + rise), point(35, 17 + rise)]) {
      oval(ear.x, ear.y, 3, 4, colors.outline); oval(ear.x, ear.y, 2, 3, colors.furLight);
      rect(ear.x, ear.y, 1, 2, colors.creamShade);
    }
    oval(head.x, head.y, side ? 11 : 12, 10, colors.furDark);
    oval(head.x - 1, head.y - 1, side ? 10 : 11, 9, colors.fur);
    oval(head.x - 3, head.y - 3, 6, 5, colors.furLight);
    oval(head.x + (side ? 5 : 0), head.y + 4, side ? 8 : 9, 5, colors.creamShade);
    oval(head.x + (side ? 5 : -1), head.y + 3, side ? 7 : 8, 4, colors.cream);
    oval(head.x + (side ? 6 : -1), head.y + 2, side ? 5 : 6, 2, colors.pale);
    rect(head.x + (side ? 10 : -2), head.y + 3, side ? 3 : 4, 2, colors.nose);
    rect(head.x + (side ? 8 : 0), head.y + 6, 2, 1, colors.furDark);
    for (const eyeX of side ? [head.x + 3] : [head.x - 6, head.x + 5]) {
      rect(eyeX, head.y, 2, blink ? 1 : 3, colors.eye);
      if (!blink) rect(eyeX, head.y, 1, 1, colors.pale);
      rect(eyeX - 1, head.y - 2, 3, 1, colors.furDark);
    }
    rect(side ? 23 : 15, 38 + rise, side ? 12 : 19, 2, colors.strap);
    rect(side ? 30 : 23, 38 + rise, 3, 2, colors.helmetLight);
  }
  const helmetX = side ? 26 : 24;
  oval(helmetX, 14 + rise, side ? 11 : 13, 7, colors.helmetDark);
  oval(helmetX - 1, 13 + rise, side ? 10 : 12, 6, colors.helmet);
  oval(helmetX - 3, 11 + rise, side ? 6 : 8, 3, colors.helmetLight);
  rect(helmetX - (side ? 12 : 14), 17 + rise, side ? 25 : 29, 3, colors.helmetDark);
  rect(helmetX - (side ? 11 : 13), 17 + rise, side ? 23 : 27, 1, colors.helmetLight);
  if (back) {
    rect(22, 10 + rise, 4, 9, colors.strap); rect(23, 10 + rise, 1, 8, colors.strapLight);
  } else {
    const lampX = side ? 35 : 24;
    oval(lampX, 14 + rise, side ? 3 : 4, 4, colors.lampRim);
    oval(lampX, 14 + rise, side ? 2 : 3, 3, colors.helmetLight);
    oval(lampX, 14 + rise, side ? 1 : 2, 2, colors.lamp);
    rect(lampX, 13 + rise, 1, 1, colors.pale);
    if (action === "trade") {
      const x = farPalm.x, y = farPalm.y - 2;
      oval(x, y, 3, 2, colors.outline); oval(x, y - 1, 2, 1, colors.ironLight);
      rect(x, y - 2, 1, 1, colors.pale);
    }
    if (action === "carry") drawStone();
    drawPaw(farShoulder, farPalm, mirrored);
    if (!toolBehind) drawPickaxe();
    drawPaw(shoulder, palm, !mirrored);
  }
  const planted = feet.filter(foot => foot.y === 43).map(mirror);
  rigs.set(canvas, {
    contact: { bottom: 45, left: Math.min(...planted.map(foot => foot.x - 5)), right: Math.max(...planted.map(foot => foot.x + 6)) },
    head: mirror(head), feet: feet.map(mirror),
    arms: [{ hand: "left", shoulder: mirror(farShoulder), palm: mirror(farPalm) },
      { hand: "right", shoulder: mirror(shoulder), palm: mirror(palm) }],
    tool: { grip: mirror(grip), head: mirror(pickHead), tip: mirror(pickTip), behindBody: toolBehind, held: toolHeld },
  });
  cache.set(key, canvas);
  if (cache.size > KAMNESHMYG_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
