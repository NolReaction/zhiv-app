import { drawFishSprite } from "@/features/world/activities/fishing/fish-sprite";
import { fishSpeciesId, type FishColor, type FishPoint, type FishShape } from "@/features/world/activities/fishing/fish-species";
import type { FishingSceneFrame, FishingScenePoint } from "./fishing-scene-types";

type Rarity = NonNullable<FishingSceneFrame["fishRarity"]>;
type FishAppearanceFrame = Pick<FishingSceneFrame, "fishRarity" | "fishId" | "stage"> & { castKey?: string; fishSizeScale?: number };
const classes: Record<Rarity, { size: number; colors: readonly [string, string, string]; silhouette: string;
  radius: readonly [number, number]; tailHeight: number; dorsal: readonly FishPoint[]; body?: readonly FishPoint[];
  tailRate: number; turnRate: number; turn: number; squash: number }> = {
  common: { size: 55, colors: ["#a9c3bf", "#dce5ce", "#628c8c"], silhouette: "slender", radius: [.54, .18], tailHeight: .18,
    dorsal: [[-.19, -.11], [-.04, -.29], [.16, -.13]], tailRate: 8.4, turnRate: 1.8, turn: .12, squash: .055 },
  uncommon: { size: 65, colors: ["#9eb46e", "#e0d99a", "#829956"], silhouette: "round", radius: [.43, .29], tailHeight: .22,
    dorsal: [[-.26, -.17], [-.17, -.38], [.04, -.42], [.22, -.2]], tailRate: 5.5, turnRate: 1.1, turn: .08, squash: .035 },
  rare: { size: 76, colors: ["#82b8d4", "#dbebeb", "#597cae"], silhouette: "dart", radius: [.61, .145], tailHeight: .25,
    dorsal: [[-.3, -.09], [-.22, -.3], [-.03, -.13], [.19, -.12]],
    body: [[-.55, .015], [-.28, -.12], [.16, -.145], [.38, -.1], [.65, -.025], [.58, .055], [.22, .15], [-.26, .13]],
    tailRate: 11.3, turnRate: 2.6, turn: .18, squash: .075 },
  epic: { size: 88, colors: ["#b19bd4", "#e9dcf0", "#8765b2"], silhouette: "deep", radius: [.37, .36], tailHeight: .29,
    dorsal: [[-.22, -.21], [-.06, -.55], [.08, -.39], [.24, -.18]], tailRate: 4.2, turnRate: .85, turn: .065, squash: .025 },
  legendary: { size: 102, colors: ["#e2c073", "#fff1bd", "#c7934a"], silhouette: "spined", radius: [.57, .23], tailHeight: .31,
    dorsal: [[-.37, -.12], [-.32, -.4], [-.2, -.25], [-.11, -.47], [.015, -.25], [.12, -.4], [.25, -.13]],
    body: [[-.55, .02], [-.35, -.17], [.02, -.23], [.31, -.15], [.58, -.035], [.61, .045], [.28, .19], [-.12, .25], [-.4, .17]],
    tailRate: 3.4, turnRate: .65, turn: .05, squash: .018 },
};

const variantForCast = (castKey?: string) => {
  if (!castKey) return 0;
  let hash = 2166136261;
  for (let index = 0; index < castKey.length; index++) hash = Math.imul(hash ^ castKey.charCodeAt(index), 16777619) >>> 0;
  return hash % 3 - 1;
};

/** Only the public class supplies a live silhouette. A confirmed landing may additionally use real size/species. */
export function fishingSceneFishAppearance(frame: FishAppearanceFrame) {
  const rarity = frame.fishRarity ?? "common", profile = classes[rarity];
  const revealed = frame.stage === "landed" && Boolean(frame.fishId);
  const sizeScale = revealed && Number.isFinite(frame.fishSizeScale) ? Math.max(.78, Math.min(1.3, frame.fishSizeScale!)) : 1;
  return { rarity, colors: profile.colors, size: profile.size * sizeScale, sizeScale, silhouette: profile.silhouette,
    variant: variantForCast(frame.castKey), species: revealed ? fishSpeciesId(frame.fishId) : "fish" as const, revealed };
}

/** Distinct class outlines are generic, not a premature reveal of the saved species. */
export function fishingSceneClassShapes(rarity: Rarity, tailSwing = 0, castKey?: string): readonly FishShape[] {
  const profile = classes[rarity], variant = variantForCast(castKey), breadth = 1 + variant * .05;
  const [rx, baseRy] = profile.radius, ry = baseRy * breadth;
  const swing = Math.max(-1, Math.min(1, Number.isFinite(tailSwing) ? tailSwing : 0)) * .095;
  const shapes: FishShape[] = [
    { kind: "polygon", points: [[-rx * .67, 0], [-.79, -profile.tailHeight + swing], [-.66, swing], [-.79, profile.tailHeight + swing]], fill: "fin", stroke: "outline", width: .038 },
    { kind: "polygon", points: profile.dorsal.map(([x, y]) => [x, y * breadth] as const), fill: "fin", stroke: "outline", width: .032 },
    { kind: "polygon", points: [[-.2, ry * .45], [-.09, ry + .12], [.15, ry * .65]], fill: "fin", stroke: "outline", width: .025 },
    profile.body ? { kind: "polygon", points: profile.body.map(([x, y]) => [x, y * breadth] as const), fill: "body", stroke: "outline", width: .045 }
      : { kind: "ellipse", x: 0, y: 0, rx, ry, fill: "body", stroke: "outline", width: .045 },
    { kind: "ellipse", x: .025, y: ry * .39, rx: rx * .74, ry: ry * .35, fill: "belly" },
    { kind: "polygon", points: [[.015, .015], [-.14, ry * .76], [.13, ry * .48]], fill: "fin" },
    { kind: "line", points: [[rx * .41, -ry * .42], [rx * .34, ry * .42]], stroke: "mark", width: .025 },
    { kind: "ellipse", x: rx * .66, y: -ry * .23, rx: .031, ry: .035, fill: "eye" },
  ];
  if (rarity === "epic" || rarity === "legendary") for (const x of [-.22, -.04, .14]) shapes.push({
    kind: "line", points: [[x, -ry * .56], [x + .035, ry * .33]], stroke: "mark", width: .022,
  });
  return shapes;
}

/** Class-specific swimming affects decorative pose only; the game target remains at its public coordinate. */
export function fishingSceneFishMotion(stage: FishingSceneFrame["stage"], time: number, still: boolean, stageElapsed = 2, rarity: Rarity = "common") {
  if (still) return { angle: stage === "caught" || stage === "landed" ? -.28 : 0, tail: 0, squash: 1 };
  const profile = classes[rarity], raised = stage === "caught" || stage === "landed", reeling = stage === "reeling" || stage === "paused";
  const effort = raised ? Math.max(0, 1 - stageElapsed / 1.45) : reeling ? 1 : .48;
  return { angle: raised ? -.28 + Math.sin(stageElapsed * 17) * effort * .14 : Math.sin(time * profile.turnRate) * profile.turn,
    tail: effort === 0 ? 0 : Math.sin(raised ? stageElapsed * 18 : time * profile.tailRate * (reeling ? 1 : .62)) * effort * .68,
    squash: 1 - Math.abs(Math.sin(time * profile.turnRate)) * (raised ? 0 : profile.squash) };
}

export function paintSceneFish(ctx: CanvasRenderingContext2D, point: FishingScenePoint, frame: FishingSceneFrame, time: number, still: boolean, stageElapsed = 2) {
  const appearance = fishingSceneFishAppearance(frame), raised = frame.stage === "caught" || frame.stage === "landed";
  const motion = fishingSceneFishMotion(frame.stage, time, still, stageElapsed, appearance.rarity);
  if (appearance.revealed) {
    ctx.save(); ctx.translate(point.x, point.y); ctx.scale(1, motion.squash);
    drawFishSprite(ctx, { x: 0, y: 0, size: appearance.size, angle: motion.angle,
      species: appearance.species, tailSwing: motion.tail }); ctx.restore();
    return;
  }
  const [body, belly, fin] = appearance.colors;
  const colors: Record<FishColor, string> = { body, belly, fin, outline: "#285768", mark: fin, eye: "#204555" };
  ctx.save(); ctx.translate(point.x, point.y); ctx.rotate(motion.angle); ctx.scale(appearance.size, appearance.size * motion.squash);
  ctx.globalAlpha *= raised ? .95 : .62;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const shape of fishingSceneClassShapes(appearance.rarity, motion.tail, frame.castKey)) {
    ctx.beginPath();
    if (shape.kind === "ellipse") ctx.ellipse(shape.x, shape.y, shape.rx, shape.ry, 0, 0, Math.PI * 2);
    else { shape.points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (shape.kind === "polygon") ctx.closePath(); }
    if (shape.fill) { ctx.fillStyle = colors[shape.fill]; ctx.fill(); }
    if (shape.stroke) { ctx.strokeStyle = colors[shape.stroke]; ctx.lineWidth = shape.width ?? .04; ctx.stroke(); }
  }
  ctx.restore();
}
