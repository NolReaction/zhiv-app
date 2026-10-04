/** Shared drawing vocabulary for catches, underwater life and the fish stall.
 * These are visual identities; rewards and prices belong to the economy catalog. */
export const FISH_SPECIES_IDS = ["fish", "fish_silverfin", "fish_reedperch", "fish_mooncarp"] as const;
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
};
export const FISH_SPECIES: Readonly<Record<FishSpeciesId, FishSpecies>> = {
  fish: { name: "Речная рыбка", radius: [.5, .24], tail: .28,
    colors: { body: "#a9c3bf", belly: "#dce5ce", fin: "#628c8c", outline: "#344f56", mark: "#6f9998", eye: "#233d42" },
    dorsal: [[-.23, -.15], [-.1, -.34], [.17, -.22], [.24, -.13]] },
  fish_silverfin: { name: "Серебринка", radius: [.53, .17], tail: .22,
    colors: { body: "#b7dcd9", belly: "#eff0d9", fin: "#4d929a", outline: "#3e6972", mark: "#5c9eac", eye: "#233e50" },
    dorsal: [[-.14, -.12], [.07, -.29], [.18, -.1]] },
  fish_reedperch: { name: "Камышовый окунёк", radius: [.48, .25], tail: .26,
    colors: { body: "#abb472", belly: "#e8d89c", fin: "#d09450", outline: "#596345", mark: "#647947", eye: "#354537" },
    dorsal: [[-.31, -.15], [-.3, -.36], [-.18, -.27], [-.12, -.39], [0, -.29], [.08, -.37], [.2, -.16]] },
  fish_mooncarp: { name: "Лунный карасик", radius: [.43, .31], tail: .27,
    colors: { body: "#c8d9df", belly: "#f5ecdb", fin: "#8da8c4", outline: "#576c89", mark: "#92b4c5", eye: "#384661" },
    dorsal: [[-.26, -.18], [-.13, -.39], [.09, -.34], [.22, -.17]] },
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
  const shapes: FishShape[] = [
    { kind: "polygon", points: [[-.32, 0], [-.75, -fish.tail + swing], [-.65, swing], [-.75, fish.tail + swing]], fill: "fin", stroke: "outline", width: .045 },
    { kind: "polygon", points: fish.dorsal, fill: "fin", stroke: "outline", width: .035 },
    { kind: "polygon", points: [[-.19, ry * .5], [-.09, ry + .11], [.11, ry * .6]], fill: "fin", stroke: "outline", width: .035 },
    { kind: "ellipse", x: 0, y: 0, rx, ry, fill: "body", stroke: "outline", width: .055 },
    { kind: "ellipse", x: .035, y: ry * .39, rx: rx * .76, ry: ry * .36, fill: "belly" },
  ];
  if (id === "fish_reedperch") {
    for (const x of [-.23, -.055, .12]) shapes.push({ kind: "line", points: [[x, -ry * .73], [x + .05, ry * .33]], stroke: "mark", width: .052 });
  } else if (id === "fish_mooncarp") {
    for (const [x, y] of [[-.16, -.075], [-.005, -.095], [-.1, .07]]) shapes.push({ kind: "ellipse", x, y, rx: .025, ry: .032, fill: "belly" });
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
