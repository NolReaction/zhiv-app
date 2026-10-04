import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { FishingAction } from "./fishing-props";
import type { WorldPoint } from "./tiled/types";

/** The resident is built from the same opaque integer-pixel primitives as
 * Mochlik. Joints, contact and prop anchors are recorded before rasterization;
 * neither movement nor grounding needs a GPU readback. */
export type PleskSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  grip: WorldPoint; heldFish: WorldPoint; basket: WorldPoint;
  head: WorldPoint; tail: WorldPoint; feet: readonly WorldPoint[];
};
export const PLESK_SPRITE_SIZE = 48;
export const PLESK_SPRITE_CACHE_LIMIT = 256;
const cache = new Map<string, HTMLCanvasElement>();
const rigs = new WeakMap<HTMLCanvasElement, PleskSpriteRig>();
export const pleskSpriteRig = (sprite: HTMLCanvasElement) => rigs.get(sprite);
const c = {
  outline: "#344950", dark: "#48656c", fur: "#64878c", light: "#86a5a5", shine: "#a2bbba",
  cream: "#e7dbb7", pale: "#f6e9c7", shade: "#c0b38e", ear: "#b9b0a0", nose: "#624837", eye: "#25373c",
};
const actions: readonly FishingAction[] = ["walk", "idle", "cast", "fish", "bite", "reel", "catch", "pack", "trade", "rest", "greet"];
const directions: readonly PixelDirection[] = ["front", "back", "left", "right"];
const point = (x: number, y: number): WorldPoint => ({ x: Math.round(x), y: Math.round(y) });
const lerp = (a: WorldPoint, b: WorldPoint, t: number) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** Eight walking poses; finite phase buckets for deliberate actions. The cache
 * stores raster poses, never the unbounded world clock or actor coordinates. */
export function pleskSprite(action: FishingAction, direction: PixelDirection, frame: number,
  phase = 0, still = false): HTMLCanvasElement {
  action = actions.includes(action) ? action : "idle";
  direction = directions.includes(direction) ? direction : "front";
  const clockFrame = still ? 0 : Number.isFinite(frame) ? ((Math.trunc(frame) % 32) + 32) % 32 : 0;
  const index = clockFrame % 8;
  const progress = Math.round(Math.max(0, Math.min(1, Number.isFinite(phase) ? phase : 0)) * 12);
  const staged = ["cast", "bite", "reel", "catch", "pack", "greet"].includes(action);
  const stage = still ? 6 : staged ? progress : 0;
  const blink = !still && clockFrame === 30 && !["cast", "bite", "reel", "catch"].includes(action);
  const closedEyes = blink || action === "rest" && (still || clockFrame >= 4);
  const key = `${action}:${direction}:${index}:${stage}:${closedEyes}`;
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
  // Left is mirrored through source coordinates, including the prop anchors.
  // Front/back have their own muzzle, shoulder and tail depth, not a flipped face.
  const sideView = direction === "left" || direction === "right";
  const back = direction === "back";
  const mirror = (p: WorldPoint) => point(direction === "left" ? 48 - p.x : p.x, p.y);
  if (direction === "left") { ctx.translate(48, 0); ctx.scale(-1, 1); }

  const walking = action === "walk", resting = action === "rest";
  const step = walking ? [0, 1, 2, 1, 0, -1, -2, -1][index] : 0;
  const rise = walking ? [0, 0, -1, -1, 0, 0, -1, -1][index] : 0;
  const phasePart = stage / 12;
  const pulling = action === "bite" || action === "reel";
  const lean = action === "cast" ? Math.round(-2 + phasePart * 4)
    : pulling ? -Math.round(phasePart * 2) : action === "pack" ? Math.round(Math.sin(phasePart * Math.PI) * 3) : 0;
  const crouch = resting ? 5 : action === "pack" ? Math.round(Math.sin(phasePart * Math.PI) * 3)
    : pulling && index % 4 > 1 ? 1 : 0;
  const breath = !still && !walking && (action === "idle" || action === "fish") && index > 4 ? -1 : 0;
  const body = point(24 + (sideView ? lean : 0), 33 + rise + Math.min(2, crouch) + breath);
  const head = point((sideView ? 28 : 24) + (sideView ? lean : 0), 18 + rise + crouch + breath
    + (action === "greet" && phasePart > .35 && phasePart < .7 ? 1 : 0));
  const tail = point(back ? 24 + (walking ? step : index === 4 ? 1 : 0) : sideView ? 9 - step : 9 + (index > 3 ? 1 : 0),
    back ? 38 : resting ? 39 : 37 + (walking ? Math.abs(step) - 1 : 0));
  const feet = sideView
    ? [point(19 + step + (walking && index === 4 ? 1 : 0), 42 - (walking && step < 0 ? 1 : 0)),
      point(29 - step - (walking && index === 4 ? 1 : 0), 42 - (walking && step > 0 ? 1 : 0))]
    : [point(18, 42 - (walking && step < 0 ? 2 : 0)), point(30, 42 - (walking && step > 0 ? 2 : 0))];
  const shoulder = point(sideView ? 29 + lean : 30, 28 + rise + crouch);
  const farShoulder = point(sideView ? 23 + lean : 17, 29 + rise + crouch);
  let grip = point(sideView ? 33 : 34, 32 + rise + crouch);
  let otherHand = point(sideView ? 29 : 16, 35 + rise + crouch);
  if (action === "cast") {
    grip = lerp(point(sideView ? 21 : 24, 20), point(37, 29), phasePart);
    otherHand = point(grip.x - 4, grip.y + 3);
  } else if (action === "fish" || pulling) {
    grip = point((sideView ? 35 : 33) - (pulling ? Math.round(phasePart * 4) : 0),
      31 + rise + crouch - (pulling ? Math.round(phasePart * 3) : 0));
    otherHand = point(grip.x - 4 + (action === "reel" ? [0, 1, 2, 1, 0, -1, -2, -1][index] : 0),
      grip.y + 3 + (action === "reel" ? [0, -1, -2, -1, 0, 1, 2, 1][index] : 0));
  } else if (action === "catch") {
    grip = point(35, 27 - Math.round(Math.sin(phasePart * Math.PI) * 5));
    otherHand = point(sideView ? 29 : 15, 34);
  } else if (action === "pack") {
    grip = lerp(point(34, 26), point(40, 38), Math.min(1, phasePart / .7));
    otherHand = point(sideView ? 29 : 19, 35 + crouch);
  } else if (action === "trade") {
    grip = point(35 + (index > 3 ? 1 : 0), 30 + (index > 3 ? -1 : 1));
    otherHand = point(16, 35);
  } else if (action === "greet") {
    grip = point(37 + [0, 1, 2, 1, 0, -1, -2, -1][index], 18 + (phasePart > .8 ? 5 : 0));
    otherHand = point(16, 35);
  } else if (resting) {
    grip = point(31, 38); otherHand = point(sideView ? 24 : 18, 38);
  } else if (walking) {
    grip = point(32, 31 + Math.round(step / 2)); otherHand = point(sideView ? 21 - step : 16, 35 - step);
  }
  const basket = ["walk", "idle", "greet"].includes(action) ? point(otherHand.x, otherHand.y + 5) : point(43, 41);
  const drawTail = () => {
    oval(tail.x, tail.y, back ? 6 : 8, back ? 6 : 4, c.outline);
    oval(tail.x, tail.y - 1, back ? 5 : 7, back ? 5 : 3, c.dark);
    oval(tail.x - 1, tail.y - 2, back ? 3 : 5, 2, c.fur);
    rect(tail.x - 3, tail.y - 3, 4, 1, c.light);
  };
  const drawArm = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    const elbow = point((from.x + to.x) / 2 - 1, (from.y + to.y) / 2 + 1);
    segment(from, elbow, 3, c.outline); segment(elbow, to, 3, c.outline);
    segment(from, elbow, 2, near ? c.fur : c.dark); segment(elbow, to, 2, near ? c.fur : c.dark);
    oval(to.x, to.y, 3, 2, near ? c.light : c.fur);
    rect(to.x + 1, to.y, 1, 1, c.dark);
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
  const ears = sideView ? [point(head.x - 8, head.y - 9), point(head.x + 6, head.y - 10)]
    : [point(head.x - 10, head.y - 8), point(head.x + 10, head.y - 8)];
  for (const ear of ears) {
    oval(ear.x, ear.y, 4, 4, c.outline); oval(ear.x, ear.y - 1, 3, 3, c.fur);
    oval(ear.x, ear.y, 2, 2, back ? c.dark : c.ear);
  }
  oval(head.x, head.y, sideView ? 11 : 12, 10, c.outline);
  oval(head.x, head.y - 1, sideView ? 10 : 11, 9, c.fur);
  oval(head.x - 2, head.y - 4, 8, 5, c.light);
  rect(head.x - 5, head.y - 8, 5, 1, c.shine);
  if (!back) {
    const muzzleX = head.x + (sideView ? 7 : 0), muzzleY = head.y + 4;
    oval(muzzleX, muzzleY + 1, sideView ? 7 : 9, 5, c.shade);
    oval(muzzleX, muzzleY, sideView ? 7 : 9, 4, c.cream);
    oval(muzzleX - (sideView ? 0 : 3), muzzleY - 1, 4, 2, c.pale);
    const eyes = sideView ? [head.x + 5] : [head.x - 5, head.x + 5];
    for (const eyeX of eyes) {
      if (closedEyes) rect(eyeX - 1, head.y, 3, 1, c.eye);
      else {
        rect(eyeX - 1, head.y - 2, 3, 4, c.eye);
        rect(eyeX, head.y - 2, 1, 1, c.pale);
      }
    }
    const noseX = muzzleX + (sideView ? 4 : 0);
    oval(noseX, muzzleY - 1, 2, 1, c.nose); rect(noseX, muzzleY, 1, 2, c.nose);
    rect(noseX - 1, muzzleY + 2, 3, 1, c.nose);
    if (sideView) {
      rect(muzzleX - 3, muzzleY + 1, 1, 1, c.nose);
      rect(muzzleX - 7, muzzleY + 1, 4, 1, c.shade); rect(muzzleX - 6, muzzleY + 3, 4, 1, c.shade);
    } else {
      for (const sign of [-1, 1]) {
        rect(muzzleX + sign * 5, muzzleY, 1, 1, c.nose);
        rect(muzzleX + (sign < 0 ? -12 : 7), muzzleY + 1, 5, 1, c.shade);
        rect(muzzleX + (sign < 0 ? -11 : 7), muzzleY + 3, 4, 1, c.shade);
      }
    }
  } else {
    oval(head.x, head.y + 4, 8, 4, c.fur);
    rect(head.x - 3, head.y + 6, 5, 1, c.dark);
  }
  if (!sideView) drawArm(farShoulder, otherHand, false);
  drawArm(shoulder, grip, true);

  const mappedFeet = feet.map(mirror), bottom = Math.max(...mappedFeet.map(foot => foot.y + 3));
  const planted = mappedFeet.filter(foot => foot.y + 3 === bottom);
  rigs.set(canvas, { contact: { bottom, left: Math.min(...planted.map(foot => foot.x - 4)), right: Math.max(...planted.map(foot => foot.x + 5)) },
    grip: mirror(action === "catch" || action === "greet" ? otherHand : grip), heldFish: mirror(point(grip.x, grip.y - 1)), basket: mirror(basket),
    head: mirror(head), tail: mirror(tail), feet: mappedFeet });
  cache.set(key, canvas);
  if (cache.size > PLESK_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
