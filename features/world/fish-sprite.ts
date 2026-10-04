import { FISH_SPECIES, fishShapes, fishSpeciesId, type FishColor, type FishSpeciesId } from "./fish-species";

export type FishSpriteFrame = {
  x: number; y: number; size: number; species?: FishSpeciesId; angle?: number;
  tailSwing?: number; underwater?: boolean;
};

/** Code-native fish art. Callers own time, opacity, water clipping and economics. */
export function drawFishSprite(ctx: CanvasRenderingContext2D, frame: FishSpriteFrame) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const species = fishSpeciesId(frame.species), colors = FISH_SPECIES[species].colors;
  const color = (part: FishColor) => frame.underwater
    ? part === "outline" || part === "eye" || part === "mark" ? "#345c59" : part === "belly" ? "#75968a" : "#547b70"
    : colors[part];
  ctx.save(); ctx.translate(frame.x, frame.y);
  ctx.rotate(Number.isFinite(frame.angle) ? frame.angle! : 0); ctx.scale(frame.size, frame.size);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const shape of fishShapes(species, frame.tailSwing)) {
    // Tiny underwater pupils and scales flicker under moving surface highlights.
    if (frame.underwater && shape.kind === "ellipse" && shape.rx < .05) continue;
    ctx.beginPath();
    if (shape.kind === "ellipse") ctx.ellipse(shape.x, shape.y, shape.rx, shape.ry, 0, 0, Math.PI * 2);
    else {
      shape.points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      if (shape.kind === "polygon") ctx.closePath();
    }
    if (shape.fill) { ctx.fillStyle = color(shape.fill); ctx.fill(); }
    if (shape.stroke) { ctx.strokeStyle = color(shape.stroke); ctx.lineWidth = shape.width ?? .04; ctx.stroke(); }
  }
  ctx.restore();
}
