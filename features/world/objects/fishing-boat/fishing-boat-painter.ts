import { pixelSprite, pixelSpriteContact } from "@/features/mochlik/pixel-sprite";
import { drawGroundedHero } from "@/features/world/scene/grounding";
import type { WorldState } from "@/features/world/domain/model";
import type { ForestFishingBoatFrame } from "@/features/world/activities/fishing/forest-boat-travel";
import { BOAT_ASSEMBLY, boatArtworkLayers, type BoatArtLayer } from "./fishing-boat-artwork";

const emptyArtwork: ReadonlyMap<string, HTMLImageElement> = new Map();

/** The same independent raster modules used by the garage, anchored at their waterline. */
export function drawFishingBoat(ctx: CanvasRenderingContext2D, frame: ForestFishingBoatFrame,
  equipment: WorldState["equipment"] | undefined, size: number, still: boolean,
  artwork: ReadonlyMap<string, HTMLImageElement> = emptyArtwork) {
  const bridge = frame.gangway, dx = bridge.to.x - bridge.from.x, dy = bridge.to.y - bridge.from.y;
  const length = Math.hypot(dx, dy), scale = frame.width / 44;
  ctx.save(); ctx.translate(bridge.from.x, bridge.from.y); ctx.rotate(Math.atan2(dy, dx));
  // The gangway remains authored local support, never a global WalkArea.
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
  const facing = Math.cos(frame.heading) < 0 ? -1 : 1;
  ctx.scale(facing * scale, scale); ctx.rotate(Math.sin(frame.heading) * .12);
  if (frame.moving && !still) {
    ctx.strokeStyle = "rgba(167,218,210,.16)"; ctx.lineWidth = .45;
    ctx.beginPath(); ctx.ellipse(-18, 2, 12, 2.5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.scale(44 / BOAT_ASSEMBLY.width, 44 / BOAT_ASSEMBLY.width);
  ctx.translate(-BOAT_ASSEMBLY.width / 2, -BOAT_ASSEMBLY.waterline);
  const layers = boatArtworkLayers({ repaired: frame.level > 0, upgrades: frame.upgrades, artifacts: frame.artifacts });
  function part(layer: BoatArtLayer) {
    const image = artwork.get(layer.src); if (!image) return;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, ...layer.crop, ...layer.box);
  }
  layers.filter(layer => layer.id !== "oars").forEach(part);
  if (frame.passenger) {
    ctx.save(); ctx.translate(BOAT_ASSEMBLY.width / 2, 0); ctx.scale(facing, 1);
    const sprite = pixelSprite("idle", "front", 0, equipment), contact = pixelSpriteContact(sprite)?.bottom ?? 45;
    const width = size / frame.width * BOAT_ASSEMBLY.width * .88;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite, -width / 2, BOAT_ASSEMBLY.waterline - contact / 48 * width, width, width);
    ctx.restore();
  }
  // Reuse the actual front planks to occlude a seated actor and module feet.
  ctx.save(); ctx.beginPath(); ctx.rect(0, BOAT_ASSEMBLY.foredeck, BOAT_ASSEMBLY.width, BOAT_ASSEMBLY.height); ctx.clip();
  part(layers[0]); ctx.restore();
  layers.filter(layer => layer.id === "oars").forEach(part);
  ctx.restore();
}
