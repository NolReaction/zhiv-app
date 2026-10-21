import type { ForestVillagerFrame } from "@/features/world/characters/forest-villager-types";
import type { WorldBounds } from "@/features/world/tiled/types";
import { kamneshmygSprite, kamneshmygSpriteRig, KAMNESHMYG_SPRITE_SIZE } from "./kamneshmyg-sprite";

export function kamneshmygHitBounds(frame: ForestVillagerFrame): WorldBounds {
  return { x: frame.x - frame.size * .35, y: frame.y - frame.size * .8, width: frame.size * .7, height: frame.size * .82 };
}

export function kamneshmygRenderBounds(frame: ForestVillagerFrame): WorldBounds {
  return { x: frame.x - frame.size / 2, y: frame.y - frame.size * 45 / 48, width: frame.size, height: frame.size };
}

export function drawKamneshmygResident(ctx: CanvasRenderingContext2D, frame: ForestVillagerFrame, still: boolean) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const sprite = kamneshmygSprite(frame.action, frame.direction, frame.frame, frame.phase, still);
  const contact = kamneshmygSpriteRig(sprite)?.contact.bottom ?? 45;
  ctx.save();
  ctx.globalAlpha *= Number.isFinite(frame.opacity) ? Math.max(0, Math.min(1, frame.opacity!)) : 1;
  ctx.fillStyle = "rgba(28,43,35,.1)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, frame.size * .31, frame.size * .055, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.17)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, frame.size * .22, frame.size * .03, 0, 0, Math.PI * 2); ctx.fill();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, frame.x - frame.size / 2, frame.y - contact / KAMNESHMYG_SPRITE_SIZE * frame.size, frame.size, frame.size);
  ctx.restore();
}
