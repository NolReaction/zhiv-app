import { leaftailSprite, leaftailSpriteRig, LEAFTAIL_SPRITE_SIZE } from "./leaftail-sprite";
import { drawLeaftailResident } from "./leaftail-painter";
import type { LeaftailBoatArrivalFrame } from "./leaftail-boat-arrival";

/** This temporary, visible support belongs only to the introductory crossing. */
export function drawLeaftailGangplank(ctx: CanvasRenderingContext2D, frame: LeaftailBoatArrivalFrame) {
  const plank = frame.gangplank; if (!plank || plank.opacity <= 0) return;
  const dx = plank.to.x - plank.from.x, dy = plank.to.y - plank.from.y, length = Math.hypot(dx, dy);
  if (length <= 0) return;
  ctx.save(); ctx.globalAlpha *= plank.opacity; ctx.translate(plank.from.x, plank.from.y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = "#483b2b"; ctx.fillRect(-2, -5, length + 4, 10);
  ctx.fillStyle = "#9a7547"; ctx.fillRect(-2, -4, length + 4, 7);
  ctx.fillStyle = "#c19b64"; ctx.fillRect(-2, -4, length + 4, 1);
  ctx.fillStyle = "#604a31";
  for (let at = 4; at < length; at += 7) ctx.fillRect(at, -4, 1, 7);
  ctx.restore();
}
function seatedTrader(ctx: CanvasRenderingContext2D, frame: LeaftailBoatArrivalFrame) {
  const person = frame.resident, sprite = leaftailSprite(person.action, person.direction, person.frame, person.phase, false);
  const contact = leaftailSpriteRig(sprite)?.contact.bottom ?? 45;
  ctx.save(); ctx.globalAlpha *= person.opacity ?? 1;
  // The front gunwale hides the lower legs; no grounded oval is painted on water.
  ctx.beginPath(); ctx.rect(person.x - person.size, person.y - person.size, person.size * 2, person.size - 3); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, person.x - person.size / 2, person.y - contact / LEAFTAIL_SPRITE_SIZE * person.size, person.size, person.size);
  ctx.restore();
}
/** Root may paint the gangplank behind depth-sorted residents. During sailing use
 * resident:true here; on land use resident:false and submit frame.resident to the
 * ordinary occlusion/shadow actor queue. This painter never advances the scene. */
export function drawLeaftailBoatArrival(ctx: CanvasRenderingContext2D, frame: LeaftailBoatArrivalFrame, still: boolean,
  options: { resident?: boolean; gangplank?: boolean } = {}) {
  if (options.gangplank !== false) drawLeaftailGangplank(ctx, frame);
  const boat = frame.boat, sailing = frame.phase === "sailing";
  if (boat.opacity > 0) {
    const bob = still ? 0 : Math.sin(boat.phase * 2.6) * .5;
    ctx.save(); ctx.globalAlpha *= boat.opacity; ctx.translate(boat.x, boat.y + bob); ctx.imageSmoothingEnabled = false;
    ctx.strokeStyle = "rgba(179,224,208,.38)"; ctx.lineWidth = .9;
    for (const offset of [0, 3]) { ctx.beginPath(); ctx.ellipse(0, offset, 11, 3.5, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = "#4c3b2d"; ctx.beginPath(); ctx.moveTo(-12, -4); ctx.lineTo(-8, -7); ctx.lineTo(8, -7);
    ctx.lineTo(12, -4); ctx.lineTo(9, 2); ctx.lineTo(-9, 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#9c7546"; ctx.fillRect(-8, -5, 16, 6);
    ctx.fillStyle = "#6d5133"; ctx.fillRect(-7, -3, 14, 2);
    ctx.fillStyle = "#c09b66"; ctx.fillRect(-10, -5, 20, 1);
    // A low bundled parcel makes the trader's travel purpose visible.
    ctx.fillStyle = "#6e7150"; ctx.fillRect(5, -9, 5, 5);
    ctx.fillStyle = "#b5ab7d"; ctx.fillRect(7, -9, 1, 5);
    if (boat.rowing) {
      const stroke = still ? 0 : Math.sin(boat.phase * 4) * 2;
      ctx.strokeStyle = "#b39563"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(-4, -7); ctx.lineTo(-13, -1 + stroke); ctx.stroke();
      ctx.fillStyle = "#8c673f"; ctx.fillRect(-15, -2 + stroke, 4, 2);
    }
    ctx.restore();
    if (sailing && options.resident !== false) seatedTrader(ctx, frame);
    // Foreground bow covers the feet after the sprite, without masking the face.
    ctx.save(); ctx.globalAlpha *= boat.opacity; ctx.translate(boat.x, boat.y + bob);
    ctx.fillStyle = "#6e4e31"; ctx.fillRect(-10, -1, 20, 3);
    ctx.fillStyle = "#b18a54"; ctx.fillRect(-10, -2, 20, 1); ctx.restore();
  }
  if (!sailing && options.resident !== false) drawLeaftailResident(ctx, frame.resident, still);
}
