/** Shared drawing vocabulary for catches, underwater life and the fish stall.
 * These are visual identities; rewards and prices belong to the economy catalog. */
export const FISH_SPECIES_IDS = ["fish", "fish_silverfin", "fish_rudd", "fish_reedperch", "fish_dace", "fish_bream", "fish_mooncarp", "fish_pike", "fish_eel", "fish_sturgeon", "fish_mirror_koi", "fish_shark"] as const;
export type FishSpeciesId = typeof FISH_SPECIES_IDS[number];
export type FishColor = "body" | "belly" | "fin" | "outline" | "mark" | "eye";
export type FishPoint = readonly [number, number];
export type FishShape = { fill?: FishColor; stroke?: FishColor; width?: number } & (
  | { kind: "ellipse"; x: number; y: number; rx: number; ry: number }
  | { kind: "polygon" | "line"; points: readonly FishPoint[] }
);
type FishSpecies = {
  name: string; radius: readonly [number, number]; tail: number;
  colors: Readonly<Record<FishColor, string>>; dorsal: readonly FishPoint[];
  body?: readonly FishPoint[];
};
export const FISH_SPECIES: Readonly<Record<FishSpeciesId, FishSpecies>> = {
  fish: { name: "Речная рыбка", radius: [.5, .24], tail: .28,
    colors: { body: "#a9c3bf", belly: "#dce5ce", fin: "#628c8c", outline: "#344f56", mark: "#6f9998", eye: "#233d42" },
    dorsal: [[-.23, -.15], [-.1, -.34], [.17, -.22], [.24, -.13]] },
  fish_silverfin: { name: "Серебринка", radius: [.53, .17], tail: .22,
    colors: { body: "#b7dcd9", belly: "#eff0d9", fin: "#4d929a", outline: "#3e6972", mark: "#5c9eac", eye: "#233e50" },
    dorsal: [[-.14, -.12], [.07, -.29], [.18, -.1]] },
  fish_rudd: { name: "Краснопёрка", radius: [.47, .22], tail: .25,
    colors: { body: "#c9b68a", belly: "#efe0b5", fin: "#bd6351", outline: "#69584a", mark: "#a88b5e", eye: "#3d3a32" },
    dorsal: [[-.23, -.14], [-.08, -.34], [.14, -.22], [.22, -.13]] },
  fish_reedperch: { name: "Камышовый окунёк", radius: [.48, .25], tail: .26,
    colors: { body: "#abb472", belly: "#e8d89c", fin: "#d09450", outline: "#596345", mark: "#647947", eye: "#354537" },
    dorsal: [[-.31, -.15], [-.3, -.36], [-.18, -.27], [-.12, -.39], [0, -.29], [.08, -.37], [.2, -.16]] },
  fish_dace: { name: "Лесной елец", radius: [.55, .145], tail: .2,
    colors: { body: "#819da2", belly: "#dce6cd", fin: "#648477", outline: "#3e5b57", mark: "#496e6b", eye: "#2b413d" },
    dorsal: [[-.14, -.1], [.015, -.3], [.16, -.11]] },
  fish_bream: { name: "Бронзовый лещ", radius: [.405, .32], tail: .24,
    colors: { body: "#b89a60", belly: "#e7c895", fin: "#8a7453", outline: "#625640", mark: "#8b703f", eye: "#393c2e" },
    dorsal: [[-.13, -.2], [.08, -.43], [.22, -.18]] },
  fish_mooncarp: { name: "Лунный карасик", radius: [.43, .31], tail: .27,
    colors: { body: "#c8d9df", belly: "#f5ecdb", fin: "#8da8c4", outline: "#576c89", mark: "#92b4c5", eye: "#384661" },
    dorsal: [[-.26, -.18], [-.13, -.39], [.09, -.34], [.22, -.17]] },
  fish_pike: { name: "Изумрудная щука", radius: [.57, .175], tail: .215,
    colors: { body: "#548c72", belly: "#c8d7a0", fin: "#41755a", outline: "#2f5947", mark: "#a4bc74", eye: "#283e32" },
    dorsal: [[-.34, -.08], [-.29, -.29], [-.08, -.24], [.03, -.1]],
    body: [[-.5, 0], [-.33, -.12], [0, -.16], [.26, -.13], [.42, -.07], [.58, -.045], [.57, .055], [.35, .085], [.19, .15], [-.08, .17], [-.37, .1]] },
  fish_eel: { name: "Тёмный угорь", radius: [.565, .105], tail: .13,
    colors: { body: "#656485", belly: "#b1b6ba", fin: "#525775", outline: "#393f59", mark: "#8585a5", eye: "#252c3d" },
    dorsal: [[-.52, -.045], [-.4, -.16], [-.2, -.21], [.02, -.17], [.31, -.12]],
    body: [[-.59, .03], [-.36, -.065], [-.12, -.12], [.23, -.1], [.45, -.065], [.56, -.015], [.57, .025], [.39, .09], [.12, .12], [-.18, .1], [-.44, .1]] },
  fish_sturgeon: { name: "Золотой осётр", radius: [.56, .185], tail: .26,
    colors: { body: "#b8a569", belly: "#ecdcaa", fin: "#8c8c66", outline: "#645f42", mark: "#e8c871", eye: "#373d2d" },
    dorsal: [[-.34, -.11], [-.24, -.35], [-.015, -.15]],
    body: [[-.53, .035], [-.32, -.14], [.02, -.18], [.28, -.135], [.58, -.005], [.48, .04], [.32, .11], [.07, .17], [-.25, .15]] },
  fish_mirror_koi: { name: "Зеркальный кои", radius: [.445, .275], tail: .245,
    colors: { body: "#eddbc2", belly: "#fff0d5", fin: "#ceac96", outline: "#786458", mark: "#c16756", eye: "#423e37" },
    dorsal: [[-.24, -.16], [-.12, -.39], [.06, -.37], [.19, -.18]] },
  fish_shark: { name: "Теневая акула", radius: [.555, .205], tail: .275,
    colors: { body: "#6b8296", belly: "#c2d2d2", fin: "#536b82", outline: "#354b60", mark: "#3c586e", eye: "#202f43" },
    dorsal: [[-.24, -.1], [-.055, -.43], [.13, -.1]],
    body: [[-.53, .025], [-.28, -.135], [.015, -.18], [.28, -.13], [.56, -.015], [.58, .025], [.43, .1], [.15, .18], [-.18, .17], [-.38, .095]] },
};

/** Catalog IDs are wider than fish IDs. Unknown items never become an invalid drawing. */
export function fishSpeciesId(value: unknown): FishSpeciesId {
  return typeof value === "string" && (FISH_SPECIES_IDS as readonly string[]).includes(value) ? value as FishSpeciesId : "fish";
}

/** Normalized geometry facing right. Both Canvas and SVG paint these exact parts.
 * Body length is about one unit; the complete silhouette fits [-.8,.58] × [-.43,.43]. */
export function fishShapes(species: FishSpeciesId = "fish", tailSwing = 0): readonly FishShape[] {
  const id = fishSpeciesId(species), fish = FISH_SPECIES[id], [rx, ry] = fish.radius;
  const swing = Number.isFinite(tailSwing) ? Math.max(-1, Math.min(1, tailSwing)) * .09 : 0;
  const tail: readonly FishPoint[] = id === "fish_shark"
    ? [[-.37, .015], [-.75, -.28 + swing], [-.62, .015 + swing], [-.72, .19 + swing], [-.49, .105]]
    : id === "fish_eel" ? [[-.39, -.025], [-.74, .025 + swing], [-.77, .1 + swing], [-.43, .1]]
      : [[-.32, 0], [-.75, -fish.tail + swing], [-.65, swing], [-.75, fish.tail + swing]];
  const shapes: FishShape[] = [
    { kind: "polygon", points: tail, fill: "fin", stroke: "outline", width: .045 },
    { kind: "polygon", points: fish.dorsal, fill: "fin", stroke: "outline", width: .035 },
    { kind: "polygon", points: [[-.19, ry * .5], [-.09, ry + .11], [.11, ry * .6]], fill: "fin", stroke: "outline", width: .035 },
    fish.body ? { kind: "polygon", points: fish.body, fill: "body", stroke: "outline", width: .055 }
      : { kind: "ellipse", x: 0, y: 0, rx, ry, fill: "body", stroke: "outline", width: .055 },
    { kind: "ellipse", x: .035, y: ry * .39, rx: rx * .76, ry: ry * .36, fill: "belly" },
  ];
  if (id === "fish_reedperch") {
    for (const x of [-.23, -.055, .12]) shapes.push({ kind: "line", points: [[x, -ry * .73], [x + .05, ry * .33]], stroke: "mark", width: .052 });
  } else if (id === "fish_mooncarp") {
    for (const [x, y] of [[-.16, -.075], [-.005, -.095], [-.1, .07]]) shapes.push({ kind: "ellipse", x, y, rx: .025, ry: .032, fill: "belly" });
  } else if (id === "fish_pike") {
    for (const [x, y] of [[-.28, -.02], [-.13, -.055], [.025, -.025], [.16, -.02], [-.18, .075]])
      shapes.push({ kind: "ellipse", x, y, rx: .04, ry: .015, fill: "mark" });
  } else if (id === "fish_sturgeon") {
    for (const x of [-.29, -.12, .05, .2]) shapes.push({ kind: "polygon", points: [[x - .045, -.055], [x, -.11], [x + .045, -.055], [x, -.005]], fill: "mark", stroke: "fin", width: .014 });
    shapes.push({ kind: "line", points: [[.4, .065], [.38, .16]], stroke: "fin", width: .021 });
  } else if (id === "fish_mirror_koi") {
    for (const [x, y, patchRx, patchRy] of [[-.21, -.09, .11, .09], [.08, -.13, .085, .11], [.26, .025, .06, .06]])
      shapes.push({ kind: "ellipse", x, y, rx: patchRx, ry: patchRy, fill: "mark" });
    shapes.push({ kind: "line", points: [[.4, .09], [.48, .15]], stroke: "outline", width: .019 });
  } else if (id === "fish_shark") {
    for (const x of [.14, .2, .26]) shapes.push({ kind: "line", points: [[x, -.06], [x - .04, .055]], stroke: "mark", width: .019 });
    shapes.push({ kind: "line", points: [[.39, .07], [.49, .045]], stroke: "outline", width: .021 });
    shapes.push({ kind: "polygon", points: [[-.04, .045], [-.21, .36], [.17, .16]], fill: "fin", stroke: "outline", width: .023 });
  } else if (id === "fish_bream") {
    for (const x of [-.2, -.06, .08]) shapes.push({ kind: "line", points: [[x, -.17], [x + .05, .2]], stroke: "mark", width: .021 });
  } else if (id === "fish_eel") {
    shapes.push({ kind: "line", points: [[-.43, -.015], [-.2, -.065], [.04, -.05], [.29, -.025]], stroke: "mark", width: .029 });
  } else {
    shapes.push({ kind: "line", points: [[-rx * .59, -ry * .17], [rx * .46, -ry * .32]], stroke: id === "fish_silverfin" ? "mark" : "belly", width: id === "fish_silverfin" ? .058 : .05 });
  }
  shapes.push(
    { kind: "polygon", points: [[.015, .015], [-.12, .14], [.1, .1]], fill: "fin" },
    { kind: "line", points: [[rx * .4, -ry * .39], [rx * .35, ry * .37]], stroke: "mark", width: .027 },
    { kind: "ellipse", x: rx * .66, y: -ry * .21, rx: .038, ry: .042, fill: "eye" },
  );
  return shapes;
}
