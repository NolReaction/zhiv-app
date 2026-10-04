import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { FishingAction, FishingMotion } from "./fishing-props";
import type { WorldPoint } from "./tiled/types";

/** The resident is built from the same opaque integer-pixel primitives as
 * Mochlik. Joints, contact and prop anchors are recorded before rasterization;
 * neither movement nor grounding needs a GPU readback. */
export type PleskSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  grip: WorldPoint; heldFish: WorldPoint; basket: WorldPoint;
  head: WorldPoint; tail: WorldPoint; feet: readonly WorldPoint[];
  palms: readonly { position: WorldPoint; near: boolean }[];
  flower: WorldPoint;
};
export const PLESK_SPRITE_SIZE = 48;
export const PLESK_SPRITE_CACHE_LIMIT = 256;
const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, PleskSpriteRig>();
export const pleskSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const c = {
  outline: "#3c5258", dark: "#536f78", fur: "#74949c", light: "#9ab7bb", shine: "#b8cecd",
  cream: "#eee2c4", pale: "#fff0d0", shade: "#c8bba0", ear: "#c7b5ad", nose: "#765746", eye: "#2b3a42",
  blush: "#d6b6ab", petal: "#efb5bb", petalLight: "#ffe1d7", petalShade: "#bd858f", pollen: "#e9c371", leaf: "#779882",
};
const actions: readonly FishingAction[] = ["walk", "idle", "cast", "fish", "bite", "reel", "catch", "pack", "trade", "rest", "greet"];
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const lerp = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** Eight walking poses; finite phase buckets for deliberate actions. The cache
 * stores raster poses, never the unbounded world clock or actor coordinates. */
export function pleskSprite(action: FishingAction, direction: PixelDirection, frame: number,
  phase = 0, still = false, motion?: FishingMotion): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clockFrame = still ? 0 : Number.isFinite(frame) ? ((Math.trunc(frame) % 32) + 32) % 32 : 0;
  const index = clockFrame % 8;
  const progress = Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 12);
  const variation = still || !["check", "nibble", "struggle", "escape"].includes(motion?.variation ?? "") ? "calm" : motion!.variation!;
  const staged = ["cast", "bite", "reel", "catch", "pack", "greet"].includes(action) || variation !== "calm";
  const stage = still ? 6 : staged ? progress : 0;
  const blink = !still && clockFrame === 30 && !["cast", "bite", "reel", "catch"].includes(action);
  const closedEyes = blink || action === "rest" && (still || clockFrame >= 4);
  const key = `${action}:${direction}:${index}:${stage}:${closedEyes}:${variation}`;
  const saved = cache.get(key);
  if (saved) { cache.delete(key); cache.set(key, saved); return saved; }

  const canvas = document.createElement("canvas"); canvas.width = canvas.height = PLESK_SPRITE_SIZE;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2D canvas unavailable");
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
  const oval = (x: number, y: number, rx: number, ry: number, color: string) => {
    x = Math.round(x); y = Math.round(y); rx = Math.max(1, Math.round(rx)); ry = Math.max(1, Math.round(ry));
    for (let row = -ry; row <= ry; row++) {
      const half = Math.floor(rx * Math.sqrt(Math.max(0, 1 - row * row / (ry * ry))));
      rect(x - half, y + row, half * 2 + 1, 1, color);
    }
  };
  const segment = (a: WorldPoint, b: WorldPoint, radius: number, color: string) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let step = 0; step <= steps; step++) {
      const at = lerp(a, b, step / steps); oval(at.x, at.y, radius, radius, color);
    }
  };
  // Left mirrors the skeleton, not the flower: the little lily remains on her
  // anatomical left ear, with a partly hidden far-side view when she turns left.
  const sideView = direction === "left" || direction === "right";
  const back = direction === "back";
  const mirror = (p: WorldPoint) => point(direction === "left" ? 48 - p.x : p.x, p.y);
  if (direction === "left") { ctx.translate(48, 0); ctx.scale(-1, 1); }

  const walking = action === "walk", resting = action === "rest";
  const step = walking ? [0, 1, 2, 1, 0, -1, -2, -1][index] : 0;
  const rise = walking ? [0, 0, -1, -1, 0, 0, -1, -1][index] : 0;
  const phasePart = stage / 12;
  const pulling = action === "bite" || action === "reel";
  const lean = variation === "struggle" ? -3 + (index > 3 ? 1 : 0) : variation === "escape" ? phasePart > .5 ? 1 : -2
    : variation === "check" ? 1 : action === "cast" ? Math.round(-2 + phasePart * 4)
    : pulling ? -Math.round(phasePart * 2) : action === "pack" ? Math.round(Math.sin(phasePart * Math.PI) * 3) : 0;
  const crouch = resting ? 5 : action === "pack" ? Math.round(Math.sin(phasePart * Math.PI) * 3)
    : pulling && index % 4 > 1 ? 1 : 0;
  const breath = !still && !walking && (action === "idle" || action === "fish") && index > 4 ? -1 : 0;
  const body = point(24 + (sideView ? lean : 0), 33 + rise + Math.min(2, crouch) + breath);
  const head = point((sideView ? 26 : 24) + (sideView ? lean : 0), 18 + rise + crouch + breath
    + (variation === "check" ? 1 : variation === "nibble" ? -1 : 0)
    + (action === "greet" && phasePart > .35 && phasePart < .7 ? 1 : 0));
  const tail = point(back ? 24 + (walking ? step : index === 4 ? 1 : 0) : sideView ? 9 - step : 9 + (index > 3 ? 1 : 0),
    back ? 38 : resting ? 39 : 37 + (walking ? Math.abs(step) - 1 : 0));
  const feet = sideView
    ? [point(19 + step + (walking && index === 4 ? 1 : 0), 42 - (walking && step < 0 ? 1 : 0)),
      point(29 - step - (walking && index === 4 ? 1 : 0), 42 - (walking && step > 0 ? 1 : 0))]
    : [point(18, 42 - (walking && step < 0 ? 2 : 0)), point(30, 42 - (walking && step > 0 ? 2 : 0))];
  const shoulder = point(sideView ? 29 + lean : 30, 30 + rise + Math.min(crouch, 3));
  const farShoulder = point(sideView ? 24 + lean : 17, 31 + rise + Math.min(crouch, 3));
  let grip = point(36, 34 + rise + Math.min(crouch, 3));
  let otherHand = point(sideView ? 29 : 16, 35 + rise + crouch);
  if (action === "cast") {
    grip = lerp(point(33, 29), point(39, 32), phasePart);
    otherHand = point(grip.x - 4, grip.y + 3);
  } else if (action === "fish" || pulling) {
    grip = point(37 - (pulling ? Math.round(phasePart * 2) : 0),
      33 + rise + Math.min(crouch, 2) - (pulling ? Math.round(phasePart * 2) : 0));
    otherHand = point(grip.x - 4 + (action === "reel" ? [0, 1, 1, 0, 0, -1, -1, 0][index] : 0),
      grip.y + 3 + (action === "reel" ? [0, -1, -1, 0, 0, 1, 1, 0][index] : 0));
  } else if (action === "catch") {
    grip = point(37, 30 - Math.round(Math.sin(phasePart * Math.PI) * 2));
    otherHand = point(sideView ? 37 : 14, 36);
  } else if (action === "pack") {
    grip = lerp(point(36, 28), point(40, 39), Math.min(1, phasePart / .7));
    otherHand = point(sideView ? 29 : 19, 35 + crouch);
  } else if (action === "trade") {
    grip = point(35 + (index > 3 ? 1 : 0), 32 + (index > 3 ? -1 : 1));
    otherHand = point(16, 35);
  } else if (action === "greet") {
    grip = point(40 + [0, 0, 1, 1, 0, 0, -1, -1][index], 19 + (phasePart > .8 ? 5 : 0));
    otherHand = point(sideView ? 37 : 15, 36);
  } else if (resting) {
    grip = point(31, 38); otherHand = point(sideView ? 24 : 18, 38);
  } else if (walking) {
    grip = point(36, 34 + Math.round(step / 2)); otherHand = point(sideView ? 21 - step : 16, 35 - step);
  }
  if (action === "fish" || pulling) {
    if (variation === "check") { grip.y -= index > 3 ? 3 : 1; otherHand.y -= index > 3 ? 3 : 1; }
    if (variation === "nibble") { grip.y -= index % 4 < 2 ? 1 : 0; otherHand.y -= index % 4 < 2 ? 1 : 0; }
    if (variation === "struggle") { grip.x -= 2; grip.y -= 2; otherHand.x -= 2; otherHand.y -= 1; }
    if (variation === "escape") { grip.y += Math.round(phasePart * 3); otherHand.y += Math.round(phasePart * 2); }
  }
  const basket = ["walk", "idle", "greet"].includes(action) ? point(otherHand.x, otherHand.y + 5) : point(43, 41);
  const drawTail = () => {
    oval(tail.x, tail.y, back ? 6 : 8, back ? 6 : 4, c.outline);
    oval(tail.x, tail.y - 1, back ? 5 : 7, back ? 5 : 3, c.dark);
    oval(tail.x - 1, tail.y - 2, back ? 3 : 5, 2, c.fur);
    rect(tail.x - 3, tail.y - 3, 4, 1, c.light);
  };
  const drawArm = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    const elbow = point((from.x + to.x) / 2 + (to.y < from.y - 5 ? 2 : -1), Math.max(from.y, to.y) + 2);
    segment(from, elbow, 2, c.outline); segment(elbow, to, 2, c.outline);
    segment(from, elbow, 1, near ? c.fur : c.dark); segment(elbow, to, 1, near ? c.fur : c.dark);
    oval(to.x, to.y, 2, 2, near ? c.light : c.fur);
    rect(to.x, to.y - 1, 2, 1, near ? c.shine : c.light);
  };
  if (!back) drawTail();
  if (sideView) drawArm(farShoulder, otherHand, false);
  const bodyCompression = Math.min(2, crouch);
  oval(body.x, body.y, resting ? 13 : 11, resting ? 9 : 11 - bodyCompression, c.outline);
  oval(body.x, body.y - 1, resting ? 12 : 10, resting ? 8 : 10 - bodyCompression, c.dark);
  oval(body.x - 1, body.y - 3, resting ? 11 : 9, resting ? 7 : 9 - bodyCompression, c.fur);
  oval(body.x - 3, body.y - 6, 5, 4, c.light);
  if (!back) {
    oval(body.x + (sideView ? 4 : 0), body.y, sideView ? 6 : 8, resting ? 7 : 9, c.shade);
    oval(body.x + (sideView ? 4 : 0), body.y - 2, sideView ? 5 : 7, resting ? 6 : 8, c.cream);
    oval(body.x + (sideView ? 4 : -1), body.y - 5, 4, 4, c.pale);
  }
  for (const [index, foot] of feet.entries()) {
    oval(foot.x, foot.y, 5, 2, c.outline); oval(foot.x, foot.y - 1, 4, 2, index === 0 && sideView ? c.dark : c.fur);
    rect(foot.x - 2, foot.y - 2, 4, 1, c.light);
    rect(foot.x + 1, foot.y, 1, 1, c.dark);
  }
  if (back) drawTail();
  // Round ears distinguish the otter from Mochlik even at world-map scale.
  const ears = sideView ? [point(head.x - 7, head.y - 8), point(head.x + 6, head.y - 9)]
    : [point(head.x - 10, head.y - 8), point(head.x + 10, head.y - 8)];
  for (const ear of ears) {
    oval(ear.x, ear.y, 4, 4, c.outline); oval(ear.x, ear.y - 1, 3, 3, c.fur);
    oval(ear.x, ear.y, 2, 2, back ? c.dark : c.ear);
  }
  const flower = sideView ? point(direction === "left" ? head.x + 6 : head.x - 7, head.y - 10)
    : point(head.x + (back ? -10 : 10), head.y - 10);
  const drawFlower = () => {
    oval(flower.x - 2, flower.y + 2, 3, 1, c.leaf);
    for (const petal of [point(-2, -1), point(1, -2), point(3, 0), point(1, 2), point(-2, 2)]) {
      oval(flower.x + petal.x, flower.y + petal.y, 2, 2, c.petalShade);
      oval(flower.x + petal.x, flower.y + petal.y - 1, 1, 1, c.petal);
      rect(flower.x + petal.x, flower.y + petal.y - 2, 1, 1, c.petalLight);
    }
    oval(flower.x, flower.y, 1, 1, c.pollen); rect(flower.x, flower.y - 1, 1, 1, c.pale);
  };
  // A far-ear blossom is partially hidden by the head, not pasted onto the
  // opposite ear when the sprite faces left.
  if (direction === "left") drawFlower();
  oval(head.x, head.y, 12, 10, c.outline);
  oval(head.x, head.y - 1, 11, 9, c.fur);
  oval(head.x - 2, head.y - 4, 8, 5, c.light);
  rect(head.x - 5, head.y - 8, 5, 1, c.shine);
  if (!back) {
    const muzzleX = head.x + (sideView ? 4 : 0), muzzleY = head.y + 4;
    // Cream cheeks sit within the round skull; the nose no longer projects as
    // a long beak. A two-pixel chin joins the muzzle and the chest bib.
    oval(muzzleX, muzzleY + 1, sideView ? 6 : 9, 4, c.shade);
    oval(muzzleX, muzzleY, sideView ? 6 : 9, 4, c.cream);
    oval(muzzleX - 2, muzzleY - 1, sideView ? 4 : 6, 3, c.pale);
    const eyes = sideView ? [head.x + 4] : [head.x - 5, head.x + 5];
    for (const eyeX of eyes) {
      if (closedEyes) rect(eyeX - 1, head.y, 3, 1, c.eye);
      else {
        oval(eyeX, head.y - 1, 2, 3, c.eye);
        rect(eyeX, head.y - 3, 1, 2, c.pale);
        rect(eyeX - 1, head.y + 1, 1, 1, c.dark);
      }
    }
    const noseX = muzzleX + (sideView ? 2 : 0);
    rect(noseX - 1, muzzleY - 1, 3, 1, c.nose); rect(noseX, muzzleY, 1, 1, c.nose);
    rect(noseX, muzzleY + 2, 2, 1, c.nose);
    if (sideView) {
      oval(muzzleX - 4, muzzleY, 2, 1, c.blush);
      rect(muzzleX - 5, muzzleY + 2, 2, 1, c.shade);
      rect(muzzleX - 4, muzzleY + 3, 2, 1, c.shade);
    } else {
      for (const sign of [-1, 1]) {
        oval(muzzleX + sign * 6, muzzleY, 2, 1, c.blush);
        rect(muzzleX + (sign < 0 ? -10 : 8), muzzleY + 2, 3, 1, c.shade);
        rect(muzzleX + (sign < 0 ? -9 : 7), muzzleY + 3, 3, 1, c.shade);
      }
    }
  } else {
    oval(head.x, head.y + 4, 8, 4, c.fur);
    rect(head.x - 3, head.y + 6, 5, 1, c.dark);
  }
  if (direction !== "left") drawFlower();
  if (!sideView) drawArm(farShoulder, otherHand, false);
  drawArm(shoulder, grip, true);

  const mappedFeet = feet.map(mirror), bottom = Math.max(...mappedFeet.map(foot => foot.y + 3));
  const planted = mappedFeet.filter(foot => foot.y + 3 === bottom);
  rigs.set(canvas, { contact: { bottom, left: Math.min(...planted.map(foot => foot.x - 4)), right: Math.max(...planted.map(foot => foot.x + 5)) },
    grip: mirror(action === "catch" || action === "greet" ? otherHand : grip), heldFish: mirror(point(grip.x, grip.y - 1)), basket: mirror(basket),
    head: mirror(head), tail: mirror(tail), feet: mappedFeet, flower: mirror(flower),
    palms: [{ position: mirror(otherHand), near: false }, { position: mirror(grip), near: true }] });
  cache.set(key, canvas);
  if (cache.size > PLESK_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
