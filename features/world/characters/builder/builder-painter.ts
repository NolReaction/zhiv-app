import type { BuilderResidentFrame } from "./builder-types";
import { builderSprite, builderSpriteRig, BUILDER_SPRITE_SIZE } from "./builder-sprite";
import type { WorldBounds } from "@/features/world/tiled/types";

export function builderHitBounds(frame: BuilderResidentFrame): WorldBounds {
  return { x: frame.x - frame.size * .37, y: frame.y - frame.size * .78, width: frame.size * .74, height: frame.size * .8 };
}

/** Includes every source pixel, the mallet's short swing and the ground shadow. */
export function builderRenderBounds(frame: BuilderResidentFrame): WorldBounds {
  return { x: frame.x - frame.size / 2, y: frame.y - frame.size * 45 / 48, width: frame.size, height: frame.size };
}

export function drawBuilderResident(ctx: CanvasRenderingContext2D, frame: BuilderResidentFrame, still: boolean) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const sprite = builderSprite(frame.action, frame.direction, frame.frame, frame.phase, still);
  const contact = builderSpriteRig(sprite)?.contact.bottom ?? 45;
  ctx.save();
  ctx.globalAlpha *= Math.max(0, Math.min(1, frame.opacity ?? 1));
  ctx.fillStyle = "rgba(28,43,35,.1)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, frame.size * .3, frame.size * .055, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.17)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, frame.size * .2, frame.size * .03, 0, 0, Math.PI * 2); ctx.fill();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, frame.x - frame.size / 2, frame.y - contact / BUILDER_SPRITE_SIZE * frame.size, frame.size, frame.size);
  ctx.restore();
}
