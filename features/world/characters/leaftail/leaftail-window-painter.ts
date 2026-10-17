import { leaftailSprite } from "./leaftail-sprite";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type LeaftailWindowResidentFrame = {
  position: WorldPoint;
  width: number;
  height: number;
  elapsed: number;
  speaking: boolean;
};
const windows = new WeakMap<FixedWorldScene, Omit<LeaftailWindowResidentFrame, "elapsed" | "speaking"> | null>();

/** Source-image annotations for the existing round end window. The rim stays
 * in the author's PNG; this is only the dark interior and its little resident. */
export function leaftailWindowResidentFrame(scene: FixedWorldScene, elapsed: number, speaking = false): LeaftailWindowResidentFrame | null {
  if (!Number.isFinite(elapsed)) return null;
  if (!windows.has(scene)) {
    const site = scene.sites.find(site => site.id === "leaftail-caravan"), box = site?.imagePlacement ?? site?.bounds;
    windows.set(scene, box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0
      && !(site?.imagePlacement?.rotation) ? {
        position: { x: box.x + box.width * .344, y: box.y + box.height * .624 },
        width: box.width * .055, height: box.height * .095,
      } : null);
  }
  const window = windows.get(scene);
  return window ? { ...window, elapsed, speaking } : null;
}

/** A genuine crop from the same resident sprite, not a second character design.
 * The oval clip keeps ears, scarf and greeting paw inside the authored window. */
export function drawLeaftailWindowResident(ctx: CanvasRenderingContext2D, frame: LeaftailWindowResidentFrame, still: boolean) {
  const { position, width, height, elapsed } = frame;
  if (![position.x, position.y, width, height, elapsed].every(Number.isFinite) || width <= 0 || height <= 0) return;
  const clock = still ? 0 : Math.floor(elapsed * 3) % 32;
  // Most of a conversation is a settled face. The one short greeting remains
  // well inside the opening instead of waving a full arm over the caravan.
  const greeting = frame.speaking && !still && elapsed % 4.8 < 1.25;
  const phase = greeting ? (elapsed % 4.8) / 1.25 : 0;
  const sprite = leaftailSprite(greeting ? "greet" : "idle", "front", clock, phase, still);
  ctx.save(); ctx.beginPath();
  ctx.ellipse(position.x, position.y, width / 2, height / 2, -.13, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "#254342"; ctx.fillRect(position.x - width, position.y - height, width * 2, height * 2);
  ctx.imageSmoothingEnabled = false;
  const portraitWidth = width * 1.17, portraitHeight = height * 1.15;
  ctx.drawImage(sprite, 13, 5, 29, 33, position.x - portraitWidth * .51, position.y - portraitHeight * .5, portraitWidth, portraitHeight);
  // One small paw rests on the interior sill. It moves by less than one window
  // pixel during the brief greeting and never covers the outer wooden rim.
  const unit = width / 18, lift = greeting ? Math.sin(phase * Math.PI) * unit : 0;
  ctx.fillStyle = "#e4954d";
  ctx.fillRect(position.x + width * .22, position.y + height * .29 - lift, unit * 3, unit * 2);
  ctx.restore();
}
