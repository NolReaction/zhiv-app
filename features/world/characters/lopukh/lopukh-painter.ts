import type { ForestVillagerFrame } from "../forest-villager-types";
import type { WorldBounds } from "@/features/world/tiled/types";
import { lopukhSprite, lopukhSpriteRig, LOPUKH_SPRITE_SIZE } from "./lopukh-sprite";

/** Body and long ears are interactive; the far end of an axe is not. */
export function lopukhHitBounds(frame: ForestVillagerFrame): WorldBounds {
  return { x: frame.x - frame.size * .33, y: frame.y - frame.size * .88, width: frame.size * .66, height: frame.size * .9 };
}

/** Includes both ears, the complete short axe swing and the contact shadow. */
export function lopukhRenderBounds(frame: ForestVillagerFrame): WorldBounds {
  return { x: frame.x - frame.size / 2, y: frame.y - frame.size * 45 / 48, width: frame.size, height: frame.size };
}

export function drawLopukhResident(ctx: CanvasRenderingContext2D, frame: ForestVillagerFrame, still: boolean) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const sprite = lopukhSprite(frame.action, frame.direction, frame.frame, frame.phase, still);
  const bottom = lopukhSpriteRig(sprite)?.contact.bottom ?? 45;
  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, frame.opacity ?? 1));
  ctx.fillStyle = "rgba(28,43,35,.1)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, frame.size * .28, frame.size * .05, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.17)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, frame.size * .18, frame.size * .025, 0, 0, Math.PI * 2); ctx.fill();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, frame.x - frame.size / 2, frame.y - bottom / LOPUKH_SPRITE_SIZE * frame.size, frame.size, frame.size);
  ctx.restore();
}
