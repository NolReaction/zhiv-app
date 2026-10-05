import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { fishingCatchFrame, fishingPackCenter, fishingBasketHandle, FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF, type FishingAction, type FishingMotion } from "./fishing-props";
import type { WorldPoint } from "./tiled/types";

/** The resident is built from the same opaque integer-pixel primitives as
 * Mochlik. Joints, contact and prop anchors are recorded before rasterization;
 * neither movement nor grounding needs a GPU readback. */
export type PleskSpriteRig = {
  contact: { bottom: number; left: number; right: number };
  grip: WorldPoint; heldFish: WorldPoint; restingFish: WorldPoint; basket: WorldPoint;
  head: WorldPoint; tail: WorldPoint; feet: readonly WorldPoint[];
  palms: readonly { position: WorldPoint; near: boolean }[];
  basketPalm?: WorldPoint;
  arms: readonly { shoulder: WorldPoint; elbow: WorldPoint; palm: WorldPoint }[];
  ears: readonly WorldPoint[]; flower: WorldPoint;
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
  const fishScale = Math.round(Math.max(.7, Math.min(1.5, (Number.isFinite(motion?.catchScale) ? motion!.catchScale! : motion?.outcome === "large" ? 1.35 : 1))) * 20) / 20;
  const carryingBasket = Boolean(motion?.carryingBasket && ["walk", "idle", "greet"].includes(action));
  const key = `${carryingBasket}:${action}:${direction}:${index}:${stage}:${closedEyes}:${variation}:${fishScale}:${motion?.outcome === "miss"}`;
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
  // Left mirrors the skeleton, not the clip: the little lily remains on her
  // anatomical left temple, partly hidden when she turns left.
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
    : pulling ? -Math.round(phasePart * 2) : action === "pack" ? -Math.round(Math.sin(phasePart * Math.PI) * 2) : 0;
  const crouch = resting ? 5 : action === "pack" ? Math.round(Math.sin(phasePart * Math.PI) * 3)
    : pulling && phasePart < 1 && index % 4 > 1 ? 1 : 0;
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
  // The basket hangs outside the body, lifted clear of the planted sole. Its
  // modest pendulum follows the step; the same handle anchors the carrying paw.
  const basket = carryingBasket ? point((sideView ? 38 : 10) + Math.round(step / 2), 39 + rise)
    : ["walk", "idle", "greet"].includes(action) ? point(sideView ? 21 - step : 16, 40 - step)
      : point(sideView ? 14 : 7, 41);
  const restingFish = point(sideView ? 18 : 13, 33);
  let heldFish = point(restingFish.x, restingFish.y - (action === "catch" ? Math.round(Math.sin(phasePart * Math.PI) * 2) : 0));
  if (action === "cast") {
    grip = lerp(point(33, 29), point(39, 32), phasePart);
    otherHand = point(grip.x - 4, grip.y + 3);
  } else if (action === "fish" || pulling) {
    grip = point(37 - (pulling ? Math.round(phasePart * 2) : 0),
      33 + rise + Math.min(crouch, 2) - (pulling ? Math.round(phasePart * 2) : 0));
    otherHand = point(grip.x - 4 + (action === "reel" ? [0, 1, 1, 0, 0, -1, -1, 0][index] : 0),
      grip.y + 3 + (action === "reel" ? [0, -1, -1, 0, 0, 1, 1, 0][index] : 0));
  } else if (action === "catch") {
    grip = point(35, 31);
  } else if (action === "pack") {
    grip = point(35, 31);
    const packed = fishingPackCenter(mirror(restingFish), mirror(basket), PLESK_SPRITE_SIZE, phasePart);
    heldFish = { x: direction === "left" ? PLESK_SPRITE_SIZE - packed.x : packed.x, y: packed.y };
  } else if (action === "trade") {
    grip = point(35 + (index > 3 ? 1 : 0), 32 + (index > 3 ? -1 : 1));
    otherHand = point(16, 35);
  } else if (action === "greet") {
    // A small paw waves beside the cheek; lifting the whole forearm above the
    // head made her short otter limb look like a long human arm.
    grip = point(36 + [0, 0, 1, 1, 0, 0, -1, -1][index], 25 + (phasePart > .8 ? 4 : 0));
    otherHand = point(sideView ? 37 : 15, 36);
  } else if (resting) {
    grip = point(31, 38); otherHand = point(sideView ? 24 : 18, 38);
  } else if (walking) {
    grip = point(36, 34 + Math.round(step / 2)); otherHand = point(sideView ? 21 - step : 16, 35 - step);
  }
  if (action === "fish" || pulling) {
    if (variation === "check") { grip.y -= index > 3 ? 3 : 1; otherHand.y -= index > 3 ? 3 : 1; }
    if (variation === "nibble") { grip.y -= index % 4 < 2 ? 1 : 0; otherHand.y -= index % 4 < 2 ? 1 : 0; }
    if (variation === "struggle") {
      const effort = action === "reel" ? Math.round(2 * Math.sin(phasePart * Math.PI)) : 2;
      grip.x -= effort; grip.y -= effort; otherHand.x -= effort; otherHand.y -= Math.round(effort / 2);
    }
    if (variation === "escape") { grip.y += Math.round(phasePart * 3); otherHand.y += Math.round(phasePart * 2); }
  }
  if (action === "catch" || action === "pack" || action === "reel" && motion?.outcome !== "miss" && phasePart > FISHING_REEL_HANDOFF) {
    const fish = fishingCatchFrame({ x: 24, y: 45, size: 48, direction,
      action, phase: phasePart, frame: index, carryingFish: true, ...motion, catchScale: fishScale }, still, { grip: mirror(grip), heldFish: mirror(heldFish), basket: mirror(basket) });
    const wrist = mirror(fish.wrist);
    if (action === "reel") otherHand = lerp(otherHand, wrist, Math.min(1, (phasePart - FISHING_REEL_HANDOFF) / (1 - FISHING_REEL_HANDOFF)));
    else if (action === "pack" && phasePart > FISHING_PACK_RELEASE) otherHand = lerp(wrist, point(sideView ? 23 : 16, 35),
      (phasePart - FISHING_PACK_RELEASE) / (1 - FISHING_PACK_RELEASE));
    else otherHand = wrist;
  }
  if (carryingBasket) {
    const handle = fishingBasketHandle(basket, PLESK_SPRITE_SIZE);
    if (sideView) {
      // In profile the visible shoulder carries the basket ahead of the hip.
      // Routing the far arm around the tail looked like a limb growing from it.
      grip = point(handle.x, handle.y);
      otherHand = action === "greet" ? point(20, 25 + (index % 2)) : point(22 - Math.round(step / 2), 36 + rise);
    } else {
      otherHand = point(handle.x, handle.y);
      if (action !== "greet") grip = point(34, 36 + rise - Math.round(step / 2));
    }
  }
  const reachable = (from: WorldPoint, to: WorldPoint) => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    return distance > 12.5 ? lerp(from, to, 12.5 / distance) : to;
  };
  grip = reachable(shoulder, grip); otherHand = reachable(farShoulder, otherHand);
  const drawTail = () => {
    oval(tail.x, tail.y, back ? 6 : 8, back ? 6 : 4, c.outline);
    oval(tail.x, tail.y - 1, back ? 5 : 7, back ? 5 : 3, c.dark);
    oval(tail.x - 1, tail.y - 2, back ? 3 : 5, 2, c.fur);
    rect(tail.x - 3, tail.y - 3, 4, 1, c.light);
  };
  const arms: { shoulder: WorldPoint; elbow: WorldPoint; palm: WorldPoint }[] = [];
  const drawArm = (from: WorldPoint, to: WorldPoint, near: boolean) => {
    const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
    const segmentLength = Math.max(6, distance / 2);
    const bend = Math.sqrt(Math.max(0, segmentLength * segmentLength - distance * distance / 4));
    const sign = dx < 0 ? -1 : 1;
    // Two similarly short bones share the bend. In particular, a raised palm
    // now raises its elbow instead of stretching down to a fixed low elbow.
    const elbow = distance > 0 ? point((from.x + to.x) / 2 - dy / distance * bend * sign,
      (from.y + to.y) / 2 + dx / distance * bend * sign) : point(from.x + 4, from.y + 4);
    arms.push({ shoulder: mirror(from), elbow: mirror(elbow), palm: mirror(to) });
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
  const ears = sideView ? [point(head.x - 8, head.y - 10), point(head.x + 6, head.y - 10)]
    : [point(head.x - 10, head.y - 8), point(head.x + 10, head.y - 8)];
  for (const ear of ears) {
    oval(ear.x, ear.y, 4, 4, c.outline); oval(ear.x, ear.y - 1, 3, 3, c.fur);
    oval(ear.x, ear.y, 2, 2, back ? c.dark : c.ear);
  }
  const flower = sideView ? point(direction === "left" ? head.x + 10 : head.x - 11, head.y - 4)
    : point(head.x + (back ? -12 : 12), head.y - 2);
  const drawFlower = () => {
    rect(flower.x - 2, flower.y + 2, 3, 1, c.leaf);
    rect(flower.x - 2, flower.y - 1, 5, 3, c.petalShade);
    rect(flower.x - 1, flower.y - 2, 3, 5, c.petalShade);
    for (const petal of [point(-1, -1), point(1, -1), point(-1, 1), point(1, 1)]) {
      oval(flower.x + petal.x, flower.y + petal.y, 1, 1, c.petal);
      rect(flower.x + petal.x, flower.y + petal.y - 1, 1, 1, c.petalLight);
    }
    rect(flower.x, flower.y, 1, 1, c.pollen);
  };
  // The far-side clip disappears naturally behind the head. Neither clip
  // replaces an ear; the ear silhouette and its inner fur remain visible.
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
    grip: mirror(action === "greet" ? otherHand : grip), heldFish: mirror(heldFish), restingFish: mirror(restingFish), basket: mirror(basket),
    head: mirror(head), tail: mirror(tail), feet: mappedFeet, arms, ears: ears.map(mirror), flower: mirror(flower),
    ...(carryingBasket ? { basketPalm: mirror(sideView ? grip : otherHand) } : {}),
    palms: [{ position: mirror(otherHand), near: false }, { position: mirror(grip), near: true }] });
  cache.set(key, canvas);
  if (cache.size > PLESK_SPRITE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return canvas;
}
