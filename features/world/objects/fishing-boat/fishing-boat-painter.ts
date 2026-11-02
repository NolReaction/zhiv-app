import { pixelSprite, pixelSpriteContact } from "@/features/mochlik/pixel-sprite";
import { drawGroundedHero } from "@/features/world/scene/grounding";
import type { WorldState } from "@/features/world/domain/model";
import type { ForestFishingBoatFrame } from "@/features/world/activities/fishing/forest-boat-travel";

/** Code-native placeholder: a new supplied boat sprite can replace this hull alone. */
export function drawFishingBoat(ctx: CanvasRenderingContext2D, frame: ForestFishingBoatFrame,
  equipment: WorldState["equipment"] | undefined, size: number, still: boolean) {
  const bridge = frame.gangway, dx = bridge.to.x - bridge.from.x, dy = bridge.to.y - bridge.from.y;
  const length = Math.hypot(dx, dy), scale = frame.width / 44;
  ctx.save(); ctx.translate(bridge.from.x, bridge.from.y); ctx.rotate(Math.atan2(dy, dx));
  // The short visible gangway is local support, never a global WalkArea.
  ctx.fillStyle = "#4e432e"; ctx.fillRect(-2 * scale, -6 * scale, length + 2 * scale, 12 * scale);
  ctx.fillStyle = "#b79258"; ctx.fillRect(0, -5 * scale, length, 10 * scale);
  ctx.fillStyle = "#6c5533";
  for (let at = 1; at < length; at += 6 * scale) ctx.fillRect(at, -5 * scale, scale, 10 * scale);
  ctx.restore();
  if (frame.crossing) drawGroundedHero(ctx, { ...frame.crossing, size, pose: "walk", direction: frame.crossing.inward ? "back" : "front",
    appearance: equipment, frame: frame.crossing.frame, shadow: true });
  if (frame.opacity <= 0) return;
  const bob = still ? 0 : Math.sin(frame.age * 2.2) * .4 * scale;
  ctx.save(); ctx.globalAlpha *= frame.opacity; ctx.translate(frame.x, frame.y + bob);
  // The shallow visual turn keeps the seated actor upright and the boat readable.
  const facing = Math.cos(frame.heading) < 0 ? -1 : 1;
  ctx.scale(facing * scale, scale); ctx.rotate(Math.sin(frame.heading) * .12);
  ctx.strokeStyle = "rgba(167,218,210,.42)"; ctx.lineWidth = .8;
  for (const y of [5, 8]) { ctx.beginPath(); ctx.ellipse(0, y, 21, 5, 0, 0, Math.PI * 2); ctx.stroke(); }
  const fresh = frame.level > 0;
  ctx.fillStyle = fresh ? "#49372b" : "#3e3d2c";
  ctx.beginPath(); ctx.moveTo(-23, -4); ctx.lineTo(-17, -11); ctx.lineTo(14, -10); ctx.lineTo(23, -3);
  ctx.lineTo(15, 9); ctx.lineTo(-17, 9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = fresh ? "#aa7c45" : "#77704b";
  ctx.beginPath(); ctx.moveTo(-19, -4); ctx.lineTo(-15, -8); ctx.lineTo(13, -7); ctx.lineTo(19, -3);
  ctx.lineTo(13, 4); ctx.lineTo(-14, 4); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#5d472f"; for (const x of [-13, -5, 5, 13]) ctx.fillRect(x, -6, 1, 11);
  if (frame.upgrades.includes("crate")) {
    ctx.fillStyle = "#a17b48"; ctx.fillRect(-17, -9, 10, 9); ctx.strokeStyle = "#4b3b29"; ctx.strokeRect(-17, -9, 10, 9);
    ctx.fillStyle = "#d2b375"; ctx.fillRect(-16, -6, 8, 1); ctx.fillRect(-13, -8, 1, 7);
  }
  if (frame.artifacts.includes("landing_net")) {
    ctx.strokeStyle = "#b8c2a2"; ctx.lineWidth = .9; ctx.beginPath(); ctx.ellipse(13, -6, 4, 3, -.3, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, -5); ctx.lineTo(0, 2); ctx.stroke();
  }
  if (frame.artifacts.includes("telescope")) {
    ctx.fillStyle = "#ccb46f"; ctx.fillRect(10, -9, 9, 3); ctx.fillStyle = "#49696a"; ctx.fillRect(18, -9, 2, 3);
  }
  const row = frame.moving && !still ? Math.sin(frame.age * 3) * .22 : -.25;
  ctx.save(); ctx.translate(3, 0); ctx.rotate(row); ctx.fillStyle = frame.upgrades.includes("oars") ? "#d9b777" : "#a68a5b";
  ctx.fillRect(-1, -19, 2, 33); ctx.fillRect(-2, 9, 4, 9); ctx.restore();
  if (frame.passenger) {
    ctx.save(); ctx.scale(facing, 1); ctx.beginPath(); ctx.rect(-20, -45, 40, 46); ctx.clip();
    const sprite = pixelSprite("idle", "front", 0, equipment), contact = pixelSpriteContact(sprite)?.bottom ?? 45;
    const width = size / scale * .88;
    ctx.imageSmoothingEnabled = false; ctx.drawImage(sprite, -width / 2, 2 - contact / 48 * width, width, width);
    ctx.restore();
  }
  ctx.fillStyle = fresh ? "#6e4c2e" : "#555039"; ctx.fillRect(-17, 3, 32, 6);
  ctx.fillStyle = fresh ? "#d0a66a" : "#999165"; ctx.fillRect(-18, 2, 34, 2);
  ctx.fillStyle = "#b2905e"; ctx.fillRect(-12, 6, 26, 1);
  ctx.restore();
}
