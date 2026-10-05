/** Geometry shared by the equipped world prop and its shop/collection icon.
 * Prices and fishing bonuses belong to the economy catalog. Coordinates use
 * the gripping palm as origin, +x toward the tip, and one unit per actor size. */
export const FISHING_ROD_IDS = ["reed_rod", "river_rod", "willow_rod"] as const;
export type FishingRodId = typeof FISHING_ROD_IDS[number];
export type FishingRodAppearance = Readonly<{
  shaft: string; highlight: string; handle: string; reel: string; metal: string; wrap: string | null;
}>;
type RodColor = keyof Omit<FishingRodAppearance, "wrap"> | "wrap";
export type RodPathCommand = readonly ["M" | "L", number, number] | readonly ["Q", number, number, number, number] | readonly ["Z"];
export type FishingRodShape = { fill?: RodColor; stroke?: RodColor; width?: number } & (
  | { kind: "path"; commands: readonly RodPathCommand[] }
  | { kind: "ellipse"; x: number; y: number; rx: number; ry: number }
);
const reedRod: FishingRodAppearance = Object.freeze({ shaft: "#62472d", highlight: "#d1b27c", handle: "#765639",
  reel: "#586861", metal: "#d4bf8c", wrap: null });
const riverRod: FishingRodAppearance = Object.freeze({ shaft: "#334d51", highlight: "#597779", handle: "#3c514a",
  reel: "#416260", metal: "#bad6c6", wrap: "#65b3aa" });
const willowRod: FishingRodAppearance = Object.freeze({ shaft: "#886240", highlight: "#c3a169", handle: "#786044",
  reel: "#bc7f4f", metal: "#e5bf88", wrap: "#75905a" });

export function fishingRodId(value: unknown): FishingRodId {
  return value === "river_rod" || value === "willow_rod" ? value : "reed_rod";
}
export function fishingRodAppearance(rodId?: string): FishingRodAppearance {
  return rodId === "river_rod" ? riverRod : rodId === "willow_rod" ? willowRod : reedRod;
}

export type FishingRodGeometryOptions = {
  length?: number; tension?: number; crank?: number; side?: number;
  reel?: { x: number; y: number };
  detailScale?: number;
};
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;

/** Reed: knotted bamboo + little winding spool. River: three dark sections,
 * split grip and a hanging spinning reel. Willow: bowed wood, leaf-shaped
 * fittings and a large round copper reel. The tip and gripping palm stay fixed. */
export function fishingRodShapes(rodId?: string, options: FishingRodGeometryOptions = {}): readonly FishingRodShape[] {
  const id = fishingRodId(rodId), requestedLength = finite(options.length, 1), length = requestedLength > 0 ? requestedLength : 1;
  const side = finite(options.side, 1) < 0 ? -1 : 1;
  const bend = Math.max(0, Math.min(1.5, finite(options.tension, 0))) * .11 * side;
  const crank = finite(options.crank, .5), reel = options.reel ?? { x: -.025, y: .09 * side };
  const rx = finite(reel.x, -.025), ry = finite(reel.y, .09 * side);
  const detail = Math.max(.2, Math.min(1, finite(options.detailScale, 1)));
  let reelStart = 0;
  const shapes: FishingRodShape[] = [];
  const line = (commands: readonly RodPathCommand[], stroke: RodColor, width: number) => shapes.push({ kind: "path", commands, stroke, width });
  const body = (commands: readonly RodPathCommand[], fill: RodColor, stroke?: RodColor, width = .012) => shapes.push({ kind: "path", commands, fill, stroke, width });
  const ellipse = (x: number, y: number, radiusX: number, radiusY: number, fill?: RodColor, stroke?: RodColor, width = .012) =>
    shapes.push({ kind: "ellipse", x, y, rx: radiusX, ry: radiusY, fill, stroke, width });
  const band = (at: number, halfWidth: number, color: RodColor, thickness = .026) =>
    line([["M", at - thickness / 2, -halfWidth], ["L", at - thickness / 2, halfWidth]], color, thickness);
  const curveAt = (t: number) => (id === "willow_rod" ? .055 * side : 0) * 4 * t * (1 - t) + bend * 2 * t * (1 - t);
  const shaft = (from: number, to: number, startWidth: number, endWidth: number) => {
    const top: RodPathCommand[] = [], bottom: RodPathCommand[] = [];
    for (let step = 0; step <= 6; step++) {
      const part = step / 6, t = from + (to - from) * part, width = startWidth + (endWidth - startWidth) * part;
      top.push([step ? "L" : "M", length * t, curveAt(t) - width]);
      bottom.unshift(["L", length * t, curveAt(t) + width]);
    }
    body([...top, ...bottom, ["Z"]], "shaft");
  };

  if (id === "reed_rod") {
    // Natural thick base and a slim flexible last segment.
    shaft(0, .59, .026, .017); shaft(.59, 1, .017, .005);
    line([["M", 0, -.006], ["Q", length * .5, bend - .006, length, 0]], "highlight", .018);
    for (const at of [.2, .39, .57, .76]) {
      const x = length * at, y = curveAt(at);
      line([["M", x, y - .032], ["L", x, y + .032]], "handle", .022);
    }
    line([["M", -.065, 0], ["L", .08, 0]], "handle", .071);
    for (const at of [-.04, -.014, .012, .038]) band(at, .03, "metal", .009);
    line([["M", 0, .005 * side], ["L", rx, ry]], "shaft", .021);
    reelStart = shapes.length;
    ellipse(rx, ry, .047, .034, "handle", "shaft");
    for (const at of [-.02, 0, .02]) line([["M", rx + at, ry - .024], ["L", rx + at, ry + .024]], "metal", .011);
  } else if (id === "river_rod") {
    // The telescoping shoulders remain visible even with all color removed.
    for (const [from, to, width] of [[0, .35, .028], [.35, .68, .021], [.68, 1, .013]]) shaft(from, to, width, width * .65);
    line([["M", 0, -.011], ["Q", length * .5, bend - .009, length, 0]], "highlight", .013);
    for (const at of [.35, .68]) line([["M", length * at, curveAt(at) - .038], ["L", length * at, curveAt(at) + .038]], "metal", .036);
    line([["M", -.105, 0], ["L", -.026, 0]], "handle", .085);
    line([["M", .035, 0], ["L", .115, 0]], "handle", .075);
    band(-.1, .041, "metal", .016); band(.118, .035, "wrap", .037);
    for (const at of [.19, .47, .77, .98]) {
      const x = at * length, y = curveAt(at) + .029 * side;
      line([["M", x - .012, curveAt(at)], ["L", x, y]], "shaft", .012);
      ellipse(x, y, .024, .018, undefined, "metal", .013);
    }
    line([["M", rx + .035, 0], ["L", rx + .035, ry], ["L", rx + .006, ry + .022 * side]], "metal", .023);
    reelStart = shapes.length;
    body([["M", rx - .065, ry], ["L", rx + .027, ry], ["L", rx + .038, ry + .077 * side],
      ["L", rx - .068, ry + .077 * side], ["Z"]], "reel", "shaft");
    ellipse(rx - .022, ry + .077 * side, .058, .018, "metal", "shaft", .01);
    line([["M", rx - .081, ry + .025 * side], ["Q", rx - .09, ry + .112 * side, rx + .055, ry + .087 * side]], "metal", .011);
    line([["M", rx + .014, ry + .035 * side], ["L", rx + .043 + Math.cos(crank) * .05, ry + (.02 + Math.sin(crank) * .04) * side]], "metal", .018);
    ellipse(rx + .043 + Math.cos(crank) * .05, ry + (.02 + Math.sin(crank) * .04) * side, .025, .016, "handle");
  } else {
    shaft(0, 1, .031, .005);
    line([["M", 0, -.005], ["Q", length * .5, .11 * side + bend - .005, length, 0]], "highlight", .016);
    line([["M", -.11, 0], ["L", .095, .014 * side]], "handle", .083);
    ellipse(-.11, 0, .019, .043, "metal");
    for (const at of [-.069, -.03, .009, .048]) line([["M", at - .012, -.028], ["L", at + .012, .032]], "wrap", .019);
    for (const at of [.24, .55, .81]) {
      const x = length * at, y = curveAt(at);
      body([["M", x - .024, y], ["Q", x + .005, y - .065 * side, x + .045, y],
        ["Q", x + .005, y + .027 * side, x - .024, y], ["Z"]], "wrap", "metal", .01);
    }
    line([["M", 0, .02 * side], ["L", rx, ry]], "metal", .023);
    reelStart = shapes.length;
    ellipse(rx, ry, .079, .079, "reel", "metal", .013);
    ellipse(rx, ry, .059, .059, "handle", "metal", .008);
    for (let index = 0; index < 4; index++) {
      const angle = crank + index * Math.PI / 2;
      ellipse(rx + Math.cos(angle) * .034, ry + Math.sin(angle) * .034, .012, .012, "reel");
    }
    ellipse(rx, ry, .015, .015, "metal");
    line([["M", rx, ry], ["L", rx + Math.cos(crank) * .09, ry + Math.sin(crank) * .09]], "metal", .015);
    ellipse(rx + Math.cos(crank) * .09, ry + Math.sin(crank) * .09, .023, .016, "handle");
  }
  if (detail === 1) return shapes;
  return shapes.map((shape, index) => {
    if (index < reelStart) return shape;
    const width = (shape.width ?? .012) * detail;
    if (shape.kind === "ellipse") return { ...shape, width, x: rx + (shape.x - rx) * detail,
      y: ry + (shape.y - ry) * detail, rx: shape.rx * detail, ry: shape.ry * detail };
    const commands = shape.commands.map(command => command[0] === "Z" ? command : command[0] === "Q"
      ? ["Q", rx + (command[1] - rx) * detail, ry + (command[2] - ry) * detail,
        rx + (command[3] - rx) * detail, ry + (command[4] - ry) * detail] as const
      : [command[0], rx + (command[1] - rx) * detail, ry + (command[2] - ry) * detail] as const);
    return { ...shape, width, commands };
  });
}

/** Static icon framing uses the same shape builder and proportions as a world rod. */
export const FISHING_ROD_ICON = { viewBox: "0 0 64 64", origin: { x: 15, y: 50 }, angle: -49, scale: 53 } as const;
export function fishingRodPath(commands: readonly RodPathCommand[]): string {
  return commands.map(command => command.join(" ")).join(" ");
}
