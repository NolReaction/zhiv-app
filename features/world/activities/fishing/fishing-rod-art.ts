/** Geometry shared by the equipped world prop and its shop/collection icon.
 * Prices and fishing bonuses belong to the economy catalog. Coordinates use
 * the gripping palm as origin, +x toward the tip, and one unit per actor size. */
export const FISHING_ROD_IDS = ["reed_rod", "brook_rod", "river_rod", "willow_rod", "tide_rod", "starfall_rod",
  "traveller_rod", "marsh_rod", "dusk_rod", "float_rod", "predator_rod", "mirror_rod", "abyss_rod"] as const;
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
const brookRod: FishingRodAppearance = Object.freeze({ shaft: "#795438", highlight: "#d6af73", handle: "#ac7849",
  reel: "#88633e", metal: "#ddc08b", wrap: "#718755" });
const riverRod: FishingRodAppearance = Object.freeze({ shaft: "#674133", highlight: "#b98d60", handle: "#c5965e",
  reel: "#79563b", metal: "#e1c28d", wrap: "#5a493a" });
const willowRod: FishingRodAppearance = Object.freeze({ shaft: "#886240", highlight: "#c3a169", handle: "#786044",
  reel: "#bc7f4f", metal: "#e5bf88", wrap: "#75905a" });

const tideRod: FishingRodAppearance = Object.freeze({ shaft: "#28616a", highlight: "#9cd5cd", handle: "#334c59",
  reel: "#549197", metal: "#cae6df", wrap: "#78c7c5" });
const starfallRod: FishingRodAppearance = Object.freeze({ shaft: "#554775", highlight: "#b8a6d2", handle: "#443d5c",
  reel: "#c69f54", metal: "#f5df9e", wrap: "#8e74aa" });
const travellerRod: FishingRodAppearance = Object.freeze({ shaft: "#9b6544", highlight: "#e2b77b", handle: "#776144",
  reel: "#9b7951", metal: "#ded5ac", wrap: "#5f816e" });
const marshRod: FishingRodAppearance = Object.freeze({ shaft: "#5f7150", highlight: "#bfcc87", handle: "#644f38",
  reel: "#8b6545", metal: "#d4bd81", wrap: "#a87b49" });
const duskRod: FishingRodAppearance = Object.freeze({ shaft: "#514d72", highlight: "#c0b4d7", handle: "#65516b",
  reel: "#9b7a62", metal: "#e1d8b4", wrap: "#9189b1" });
const floatRod: FishingRodAppearance = Object.freeze({ shaft: "#886a43", highlight: "#e3c994", handle: "#b48d5c",
  reel: "#ad6b4f", metal: "#e2d0a0", wrap: "#ce7951" });
const predatorRod: FishingRodAppearance = Object.freeze({ shaft: "#426653", highlight: "#a7c58a", handle: "#454c39",
  reel: "#827d4a", metal: "#d5ce87", wrap: "#a18e45" });
const mirrorRod: FishingRodAppearance = Object.freeze({ shaft: "#748b9d", highlight: "#e1edf0", handle: "#58647b",
  reel: "#a4bcb5", metal: "#e3d6b4", wrap: "#c3a9cf" });
const abyssRod: FishingRodAppearance = Object.freeze({ shaft: "#32465a", highlight: "#92aebb", handle: "#504a40",
  reel: "#526a77", metal: "#c7bd91", wrap: "#77928c" });

export function fishingRodId(value: unknown): FishingRodId {
  return FISHING_ROD_IDS.find(id => id === value) ?? "reed_rod";
}
export function fishingRodAppearance(rodId?: string): FishingRodAppearance {
  return rodId === "float_rod" ? floatRod : rodId === "predator_rod" ? predatorRod : rodId === "mirror_rod" ? mirrorRod : rodId === "abyss_rod" ? abyssRod
    : rodId === "traveller_rod" ? travellerRod : rodId === "marsh_rod" ? marshRod : rodId === "dusk_rod" ? duskRod
    : rodId === "starfall_rod" ? starfallRod : rodId === "tide_rod" ? tideRod : rodId === "brook_rod" ? brookRod : rodId === "river_rod" ? riverRod : rodId === "willow_rod" ? willowRod : reedRod;
}

export type FishingRodGeometryOptions = {
  length?: number; tension?: number; crank?: number; side?: number;
  reel?: { x: number; y: number };
  detailScale?: number;
};
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;

/** Reed: knotted bamboo + little winding spool. Brook: short plain wood,
 * green lashings, a paddle grip and low wooden spool. River: three slim sections,
 * continuous cork grip and a compact rounded reel. Tide: heavier sections,
 * split grip and a deep hanging reel. Willow: bowed wood, leaf-shaped fittings
 * and a large round copper reel. Traveller has folding collars and a box spool;
 * Marsh has a forked grip and open wheel; Dusk has a slender crescent reel.
 * The tip and gripping palm stay fixed. */
export function fishingRodShapes(rodId?: string, options: FishingRodGeometryOptions = {}): readonly FishingRodShape[] {
  const id = fishingRodId(rodId), requestedLength = finite(options.length, id === "brook_rod" ? .82 : 1), length = requestedLength > 0 ? requestedLength : 1;
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
  const curveAt = (t: number) => ((id === "willow_rod" || id === "starfall_rod") ? .055 * side : 0) * 4 * t * (1 - t) + bend * 2 * t * (1 - t);
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
  } else if (id === "brook_rod") {
    // A plain single-piece pole with a carved paddle grip, no metal sections or
    // deep hanging reel. Explicit rig length still preserves the line anchor.
    shaft(0, 1, .023, .006);
    line([["M", 0, -.007], ["Q", length * .5, bend - .007, length, 0]], "highlight", .012);
    body([["M", -.10, -.022], ["Q", -.115, 0, -.10, .022], ["L", .055, .04],
      ["Q", .09, .028, .075, -.025], ["L", -.10, -.022], ["Z"]], "handle", "shaft", .009);
    for (const at of [-.065, .065]) {
      band(at, .029, "wrap", .035);
      line([["M", at - .01, -.027], ["L", at + .011, .028]], "metal", .006);
    }
    for (const at of [.34, .76]) {
      const x = at * length, y = curveAt(at);
      line([["M", x, y - .025], ["L", x, y + .025]], "wrap", .024);
      ellipse(x + .006, y + .03 * side, .018, .015, undefined, "metal", .009);
    }
    line([["M", 0, .005 * side], ["L", rx, ry]], "wrap", .026);
    reelStart = shapes.length;
    ellipse(rx, ry, .048, .031, "reel", "shaft", .009);
    for (const at of [-.036, .036]) ellipse(rx + at, ry, .01, .038, "handle", "shaft", .008);
    for (const at of [-.014, .008]) line([["M", rx + at, ry - .024], ["L", rx + at, ry + .024]], "metal", .009);
    line([["M", rx, ry], ["L", rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025]], "metal", .012);
    ellipse(rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025, .016, .012, "handle");
  } else if (id === "river_rod" || id === "tide_rod") {
    const river = id === "river_rod";
    // River is a light cork-handled pole; Tide keeps the heavier stepped blank.
    for (const [from, to, width] of [[0, .35, .028], [.35, .68, .021], [.68, 1, .013]])
      shaft(from, to, width * (river ? .72 : 1), width * (river ? .45 : .65));
    line([["M", 0, -.011], ["Q", length * .5, bend - .009, length, 0]], "highlight", .013);
    for (const at of [.35, .68]) {
      const half = river ? .026 : .038;
      line([["M", length * at, curveAt(at) - half], ["L", length * at, curveAt(at) + half]], "metal", river ? .02 : .036);
    }
    if (river) {
      line([["M", -.135, 0], ["L", .105, 0]], "handle", .069);
      band(-.13, .032, "wrap", .018); band(.108, .029, "metal", .024);
      for (const at of [-.083, -.022, .044]) band(at, .024, "reel", .008);
    } else {
      line([["M", -.105, 0], ["L", -.026, 0]], "handle", .085);
      line([["M", .035, 0], ["L", .115, 0]], "handle", .075);
      band(-.1, .041, "metal", .016); band(.118, .035, "wrap", .037);
    }
    for (const at of river ? [.24, .57, .9] : [.19, .47, .77, .98]) {
      const x = at * length, y = curveAt(at) + .029 * side;
      line([["M", x - .012, curveAt(at)], ["L", x, y]], "shaft", .012);
      ellipse(x, y, river ? .018 : .024, .018, undefined, "metal", .013);
    }
    if (id === "tide_rod") {
      for (const at of [.1, .27, .47]) { const x = at * length, y = curveAt(at);
        line([["M", x - .025, y - .023], ["Q", x, y + .025, x + .025, y - .015]], "wrap", .021);
      }
    }
    line([["M", rx + .035, 0], ["L", rx + .035, ry], ["L", rx + .006, ry + .022 * side]], "metal", .023);
    reelStart = shapes.length;
    if (river) {
      // Shallow, rounded spool; it reads differently from Tide's deep basket.
      ellipse(rx - .014, ry + .025 * side, .062, .041, "reel", "shaft");
      ellipse(rx + .017, ry + .025 * side, .024, .043, "metal", "shaft", .009);
      line([["M", rx - .032, ry + .006 * side], ["L", rx - .032, ry + .043 * side]], "metal", .013);
    } else {
      body([["M", rx - .065, ry], ["L", rx + .027, ry], ["L", rx + .038, ry + .077 * side],
        ["L", rx - .068, ry + .077 * side], ["Z"]], "reel", "shaft");
      ellipse(rx - .022, ry + .077 * side, .058, .018, "metal", "shaft", .01);
      line([["M", rx - .081, ry + .025 * side], ["Q", rx - .09, ry + .112 * side, rx + .055, ry + .087 * side]], "metal", .011);
    }
    line([["M", rx + .014, ry + .035 * side], ["L", rx + .043 + Math.cos(crank) * .05, ry + (.02 + Math.sin(crank) * .04) * side]], "metal", .018);
    ellipse(rx + .043 + Math.cos(crank) * .05, ry + (.02 + Math.sin(crank) * .04) * side, .025, .016, "handle");
  } else if (id === "float_rod" || id === "predator_rod" || id === "mirror_rod" || id === "abyss_rod") {
    const light = id === "float_rod", predator = id === "predator_rod", mirror = id === "mirror_rod";
    const width = light ? .018 : predator ? .034 : mirror ? .023 : .04;
    shaft(0, .52, width, width * .65); shaft(.52, 1, width * .65, .004);
    line([["M", 0, -.007], ["Q", length * .5, bend - .007, length, 0]], "highlight", .012);
    if (light) {
      body([["M", -.16, -.022], ["Q", -.19, 0, -.16, .022], ["L", .1, .032],
        ["L", .12, .012], ["L", .1, -.032], ["Z"]], "handle", "shaft", .009);
      for (const at of [-.12, -.08, -.04]) band(at, .021, "wrap", .01);
      // Attached cork float remains visible in shop and world silhouettes.
      line([["M", .2 * length, 0], ["L", .22 * length, -.095 * side]], "metal", .007);
      ellipse(.22 * length, -.07 * side, .018, .043, "wrap", "metal", .007);
    } else if (predator) {
      body([["M", -.17, -.04], ["L", .08, -.04], ["L", .12, -.014], ["L", .09, .03],
        ["L", .025, .03], ["L", .005, .08], ["L", -.035, .07], ["L", -.04, .03], ["L", -.17, .03], ["Z"]], "handle", "metal", .009);
      for (const at of [-.12, -.07, -.02]) band(at, .035, "wrap", .013);
    } else if (mirror) {
      body([["M", -.17, 0], ["Q", -.11, -.065, .08, -.025], ["L", .12, 0],
        ["L", .08, .025], ["Q", -.11, .065, -.17, 0], ["Z"]], "handle", "metal", .009);
      for (const at of [-.1, -.035, .03]) ellipse(at, 0, .012, .026, "wrap");
    } else {
      body([["M", -.18, -.04], ["L", .12, -.04], ["L", .12, .04], ["L", -.18, .04], ["Z"]], "handle", "metal", .012);
      for (const at of [-.14, -.08, -.02, .04]) band(at, .036, "wrap", .019);
      ellipse(-.18, 0, .025, .048, "metal", "shaft", .009);
    }
    for (const at of light ? [.4, .75, .95] : predator ? [.25, .49, .73, .95] : mirror ? [.32, .67, .94] : [.22, .45, .7, .94]) {
      const x = at * length, y = curveAt(at);
      line([["M", x, y], ["L", x + .012, y + .035 * side]], "metal", .012);
      ellipse(x + .012, y + .04 * side, .019, .014, undefined, "metal", .009);
    }
    line([["M", .01, .012 * side], ["L", rx, ry]], "metal", .025);
    reelStart = shapes.length;
    if (light) {
      ellipse(rx, ry, .058, .026, "reel", "metal", .01);
      for (const at of [-.025, 0, .025]) line([["M", rx + at, ry - .019], ["L", rx + at, ry + .019]], "handle", .008);
    } else if (predator) {
      const teeth: RodPathCommand[] = [];
      for (let index = 0; index < 20; index++) {
        const angle = index * Math.PI / 10, radius = index % 2 ? .062 : .078;
        teeth.push([index ? "L" : "M", rx + Math.cos(angle) * radius, ry + Math.sin(angle) * radius]);
      }
      body([...teeth, ["Z"]], "reel", "metal", .009); ellipse(rx, ry, .042, .042, "handle", "metal", .009);
    } else if (mirror) {
      body([["M", rx - .09, ry], ["L", rx - .045, ry - .052], ["L", rx + .045, ry - .052],
        ["L", rx + .09, ry], ["L", rx + .045, ry + .052], ["L", rx - .045, ry + .052], ["Z"]], "reel", "metal", .01);
      ellipse(rx, ry, .045, .025, "wrap", "metal", .009);
    } else {
      body([["M", rx - .079, ry - .049], ["Q", rx, ry - .085, rx + .068, ry - .04],
        ["L", rx + .068, ry + .045], ["Q", rx, ry + .085, rx - .079, ry + .049], ["Z"]], "reel", "metal", .012);
      ellipse(rx, ry, .035, .048, "handle", "metal", .01);
      for (const at of [-.055, .05]) line([["M", rx + at, ry - .035], ["L", rx + at, ry + .035]], "wrap", .009);
    }
    line([["M", rx, ry], ["L", rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025]], "metal", .012);
    ellipse(rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025, .017, .013, "handle");
  } else if (id === "traveller_rod") {
    // A compact jointed travelling pole: the folding hardware and flat reel
    // change its silhouette even when its colour is removed.
    shaft(0, .43, .029, .023); shaft(.43, .74, .019, .013); shaft(.74, 1, .01, .004);
    line([["M", 0, -.012], ["Q", length * .5, bend - .009, length, 0]], "highlight", .014);
    body([["M", -.16, -.035], ["L", .085, -.035], ["L", .115, -.018], ["L", .115, .018],
      ["L", .085, .035], ["L", -.16, .035], ["Z"]], "handle", "shaft", .009);
    for (const at of [-.12, -.085, -.05, -.015]) band(at, .029, "wrap", .011);
    for (const at of [.43, .74]) {
      const x = at * length, y = curveAt(at);
      body([["M", x - .022, y - .036], ["L", x + .022, y - .036], ["L", x + .022, y + .036],
        ["L", x - .022, y + .036], ["Z"]], "metal", "shaft", .008);
      ellipse(x, y, .01, .01, "reel");
    }
    for (const at of [.25, .61, .92]) {
      const x = at * length, y = curveAt(at);
      line([["M", x, y], ["L", x, y + .024 * side]], "shaft", .012);
      ellipse(x, y + .03 * side, .015, .014, undefined, "metal", .009);
    }
    line([["M", -.01, .015 * side], ["L", rx, ry]], "metal", .027);
    reelStart = shapes.length;
    body([["M", rx - .061, ry - .036], ["L", rx + .057, ry - .036], ["L", rx + .069, ry + .023],
      ["L", rx + .051, ry + .043], ["L", rx - .061, ry + .043], ["Z"]], "reel", "metal", .011);
    for (const at of [-.037, -.012, .013, .038])
      line([["M", rx + at, ry - .025], ["L", rx + at, ry + .028]], "handle", .011);
    ellipse(rx, ry, .021, .021, "metal", "shaft", .008);
    line([["M", rx, ry], ["L", rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025]], "metal", .012);
    ellipse(rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025, .017, .013, "wrap");
  } else if (id === "marsh_rod") {
    shaft(0, 1, .035, .005);
    line([["M", 0, -.013], ["Q", length * .5, bend - .009, length, 0]], "highlight", .017);
    // An asymmetric natural branch instead of a straight wrapped handle.
    body([["M", -.17, -.045], ["L", -.06, -.012], ["L", .1, -.04], ["L", .13, -.008],
      ["L", -.035, .035], ["L", -.13, .058], ["L", -.15, .029], ["L", -.065, .008], ["L", -.18, -.014], ["Z"]], "handle", "shaft", .01);
    for (const at of [.11, .31, .51, .71, .89]) {
      const x = at * length, y = curveAt(at);
      line([["M", x - .02, y - .024], ["L", x, y + .024], ["L", x + .017, y - .018]], "wrap", .017);
    }
    for (const at of [.22, .62, .95]) {
      const x = at * length, y = curveAt(at);
      body([["M", x - .02, y + .014 * side], ["L", x + .026, y + .014 * side],
        ["L", x + .015, y + .059 * side], ["L", x - .015, y + .059 * side], ["Z"]], "metal", "shaft", .008);
      ellipse(x + .002, y + .037 * side, .009, .011, "shaft");
    }
    line([["M", .02, .009 * side], ["L", rx, ry]], "wrap", .037);
    reelStart = shapes.length;
    ellipse(rx, ry, .088, .062, "reel", "shaft", .012);
    ellipse(rx, ry, .068, .045, "shaft", "metal", .009);
    for (let index = 0; index < 5; index++) {
      const angle = index * Math.PI * 2 / 5;
      line([["M", rx, ry], ["L", rx + Math.cos(angle) * .068, ry + Math.sin(angle) * .045]], "handle", .014);
    }
    ellipse(rx, ry, .024, .024, "metal", "shaft", .008);
    line([["M", rx, ry], ["L", rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025]], "metal", .012);
    ellipse(rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025, .019, .014, "wrap");
  } else if (id === "dusk_rod") {
    shaft(0, .6, .02, .012); shaft(.6, 1, .012, .003);
    line([["M", 0, -.007], ["Q", length * .5, bend - .007, length, 0]], "highlight", .012);
    // Narrow counterweighted grip, long swept fittings and a crescent housing.
    line([["M", -.17, 0], ["L", .115, 0]], "handle", .05);
    body([["M", -.18, -.035], ["L", -.14, -.044], ["L", -.12, 0], ["L", -.14, .044], ["L", -.18, .035], ["Z"]], "metal", "shaft", .009);
    for (const at of [-.085, -.045, -.005, .035, .075]) band(at, .024, "wrap", .013);
    for (const at of [.28, .58, .86]) {
      const x = at * length, y = curveAt(at);
      body([["M", x - .032, y], ["Q", x - .01, y + .09 * side, x + .035, y + .035 * side],
        ["Q", x + .01, y + .047 * side, x - .032, y], ["Z"]], "metal", "shaft", .008);
      ellipse(x + .011, y + .037 * side, .012, .012, undefined, "metal", .009);
    }
    line([["M", .02, .015 * side], ["L", rx + .02, ry]], "metal", .021);
    reelStart = shapes.length;
    body([["M", rx + .043, ry - .069], ["Q", rx - .087, ry - .08, rx - .086, ry + .013],
      ["Q", rx - .065, ry + .088, rx + .053, ry + .05],
      ["Q", rx - .045, ry + .043, rx - .045, ry - .007],
      ["Q", rx - .042, ry - .043, rx + .043, ry - .069], ["Z"]], "reel", "metal", .01);
    ellipse(rx, ry, .029, .043, "handle", "metal", .011);
    ellipse(rx, ry, .012, .022, "wrap", "shaft", .008);
    for (const at of [-.045, .045]) ellipse(rx - .047, ry + at, .009, .009, "metal");
    line([["M", rx, ry], ["L", rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025]], "metal", .012);
    ellipse(rx + Math.cos(crank) * .035, ry + Math.sin(crank) * .025, .016, .016, "metal", "shaft", .008);
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
    if (id === "starfall_rod") {
      for (const at of [.24, .55]) { const x = at * length, y = curveAt(at);
        body([["M", x, y - .065], ["L", x + .015, y - .015], ["L", x + .051, y], ["L", x + .015, y + .016], ["L", x, y + .051], ["L", x - .015, y + .016], ["L", x - .051, y], ["L", x - .015, y - .015], ["Z"]], "metal", "shaft", .008);
      }
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
