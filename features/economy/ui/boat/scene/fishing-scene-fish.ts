import { drawFishSprite } from "@/features/world/activities/fishing/fish-sprite";
import { fishShapes, fishSpeciesId, type FishColor } from "@/features/world/activities/fishing/fish-species";
import type { FishingSceneFrame, FishingScenePoint } from "./fishing-scene-types";

type Rarity = NonNullable<FishingSceneFrame["fishRarity"]>;
const classes: Record<Rarity, { size: number; colors: readonly [string, string, string] }> = {
  common: { size: 55, colors: ["#a9c3bf", "#dce5ce", "#628c8c"] },
  uncommon: { size: 65, colors: ["#9eb46e", "#e0d99a", "#829956"] },
  rare: { size: 76, colors: ["#82b8d4", "#dbebeb", "#597cae"] },
  epic: { size: 88, colors: ["#b19bd4", "#e9dcf0", "#8765b2"] },
  legendary: { size: 102, colors: ["#e2c073", "#fff1bd", "#c7934a"] },
};

/** Before confirmation the silhouette identifies only the server's public class, never a guessed species. */
export function fishingSceneFishAppearance(frame: Pick<FishingSceneFrame, "fishRarity" | "fishId" | "stage">) {
  const rarity = frame.fishRarity ?? "common";
  const revealed = frame.stage === "landed" && Boolean(frame.fishId);
  return { rarity, ...classes[rarity], species: revealed ? fishSpeciesId(frame.fishId) : "fish" as const, revealed };
}

export function paintSceneFish(ctx: CanvasRenderingContext2D, point: FishingScenePoint, frame: FishingSceneFrame, time: number, still: boolean) {
  const appearance = fishingSceneFishAppearance(frame), raised = frame.stage === "caught" || frame.stage === "landed";
  const angle = raised ? -.32 : Math.sin(time * 1.7) * .06;
  if (appearance.revealed) {
    drawFishSprite(ctx, { x: point.x, y: point.y, size: appearance.size, angle,
      species: appearance.species, tailSwing: still ? 0 : Math.sin(time * 7) * .5 });
    return;
  }
  const [body, belly, fin] = appearance.colors;
  const colors: Record<FishColor, string> = { body, belly, fin, outline: "#285768", mark: fin, eye: "#204555" };
  ctx.save(); ctx.translate(point.x, point.y); ctx.rotate(angle); ctx.scale(appearance.size, appearance.size);
  // A translucent body sits under the water; a local landing shows class colors but does not claim its species yet.
  ctx.globalAlpha *= raised ? .95 : .62;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const shape of fishShapes("fish", still ? 0 : Math.sin(time * 7) * .65)) {
    ctx.beginPath();
    if (shape.kind === "ellipse") ctx.ellipse(shape.x, shape.y, shape.rx, shape.ry, 0, 0, Math.PI * 2);
    else { shape.points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (shape.kind === "polygon") ctx.closePath(); }
    if (shape.fill) { ctx.fillStyle = colors[shape.fill]; ctx.fill(); }
    if (shape.stroke) { ctx.strokeStyle = colors[shape.stroke]; ctx.lineWidth = shape.width ?? .04; ctx.stroke(); }
  }
  ctx.restore();
}
