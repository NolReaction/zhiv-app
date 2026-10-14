export type FruitPalette = { shade: string; body: string; light: string; detail: string; stem: string };
export type ForestFruitAppearance = {
  shape: "woodland" | "raspberry" | "strawberry" | "blueberry" | "currant" | "blackberry" | "cranberry";
  radiusScale: number;
  green: FruitPalette; filling: FruitPalette; ripe: FruitPalette;
  /** The visual crop must be fully ripe when the existing harvest rule accepts it. */
  ripeAt: number; clusterDelay: number; fruitDelay: number;
  minimumSize: number; fillingAt: number; coloringAt: number;
};

/** Cosmetic profiles use canonical item IDs; they never change recipes or crop deadlines. */
export const FOREST_FRUIT_APPEARANCES = {
  woodlandBerry: {
    shape: "woodland", radiusScale: 1,
    green: { shade: "#46592a", body: "#7f9840", light: "#b2bf68", detail: "#5f7733", stem: "#536a30" },
    filling: { shade: "#756035", body: "#ae9549", light: "#d4ba70", detail: "#917737", stem: "#58662e" },
    ripe: { shade: "#854622", body: "#c77332", light: "#e6ac60", detail: "#a25229", stem: "#626731" },
    ripeAt: .98, clusterDelay: .024, fruitDelay: .012,
    minimumSize: .2, fillingAt: .34, coloringAt: .61,
  },
  berries: {
    shape: "raspberry", radiusScale: 1.27,
    green: { shade: "#46592d", body: "#7f9a49", light: "#aec176", detail: "#5b7738", stem: "#526930" },
    filling: { shade: "#945553", body: "#c67e76", light: "#e1aaa0", detail: "#ab6664", stem: "#596934" },
    ripe: { shade: "#842f43", body: "#c7465a", light: "#e78087", detail: "#a5384d", stem: "#566b32" },
    ripeAt: .98, clusterDelay: .023, fruitDelay: .012,
    minimumSize: .18, fillingAt: .3, coloringAt: .57,
  },
  strawberries: {
    shape: "strawberry", radiusScale: 1.5,
    green: { shade: "#506234", body: "#91a957", light: "#beca87", detail: "#718743", stem: "#526b32" },
    filling: { shade: "#ad7658", body: "#d1a078", light: "#e8c099", detail: "#a78b4c", stem: "#59713a" },
    ripe: { shade: "#92392c", body: "#d54c39", light: "#ef8970", detail: "#eab96b", stem: "#5a7134" },
    ripeAt: .98, clusterDelay: .019, fruitDelay: .011,
    minimumSize: .16, fillingAt: .33, coloringAt: .6,
  },
  blueberries: {
    shape: "blueberry", radiusScale: 1.3,
    green: { shade: "#455b3d", body: "#7e9c6e", light: "#b0c495", detail: "#5d7755", stem: "#536b36" },
    filling: { shade: "#72546e", body: "#a17b9d", light: "#c2a5b7", detail: "#84677f", stem: "#596c37" },
    ripe: { shade: "#35475f", body: "#617fa6", light: "#98adbf", detail: "#465875", stem: "#596e37" },
    ripeAt: .98, clusterDelay: .026, fruitDelay: .009,
    minimumSize: .2, fillingAt: .31, coloringAt: .58,
  },
  currants: {
    shape: "currant", radiusScale: 1.2,
    green: { shade: "#4d6233", body: "#87a650", light: "#bdcf88", detail: "#6a843f", stem: "#566c33" },
    filling: { shade: "#986b48", body: "#c99767", light: "#e9bc82", detail: "#aa7d52", stem: "#626d35" },
    ripe: { shade: "#8d3032", body: "#d74643", light: "#ef8b73", detail: "#b9393c", stem: "#626d36" },
    ripeAt: .98, clusterDelay: .027, fruitDelay: .013,
    minimumSize: .17, fillingAt: .29, coloringAt: .6,
  },
  blackberries: {
    shape: "blackberry", radiusScale: 1.32,
    green: { shade: "#46582f", body: "#7e9547", light: "#aebd72", detail: "#607436", stem: "#526832" },
    filling: { shade: "#773f50", body: "#af6170", light: "#cc9396", detail: "#914856", stem: "#596b34" },
    ripe: { shade: "#322b3e", body: "#55415f", light: "#8b718e", detail: "#413249", stem: "#5c6d38" },
    ripeAt: .98, clusterDelay: .022, fruitDelay: .012,
    minimumSize: .17, fillingAt: .31, coloringAt: .63,
  },
  cranberries: {
    shape: "cranberry", radiusScale: 1.48,
    green: { shade: "#506137", body: "#8fa05a", light: "#bdc68b", detail: "#748044", stem: "#647039" },
    filling: { shade: "#9d6770", body: "#c79598", light: "#e1b6ab", detail: "#aa737e", stem: "#686c39" },
    ripe: { shade: "#762d3f", body: "#ad4058", light: "#d87883", detail: "#892d45", stem: "#666f38" },
    ripeAt: .98, clusterDelay: .025, fruitDelay: .01,
    minimumSize: .18, fillingAt: .35, coloringAt: .62,
  },
} as const satisfies Record<string, ForestFruitAppearance>;

export function forestFruitAppearance(itemId?: string): ForestFruitAppearance {
  return itemId && Object.hasOwn(FOREST_FRUIT_APPEARANCES, itemId)
    ? FOREST_FRUIT_APPEARANCES[itemId as keyof typeof FOREST_FRUIT_APPEARANCES]
    : FOREST_FRUIT_APPEARANCES.woodlandBerry;
}

const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const smooth = (value: number) => { const t = unit(value); return t * t * (3 - 2 * t); };
function mixColor(from: string, to: string, progress: number) {
  const t = unit(progress);
  const channels = [1, 3, 5].map(index => Math.round(parseInt(from.slice(index, index + 2), 16) * (1 - t)
    + parseInt(to.slice(index, index + 2), 16) * t));
  return `rgb(${channels.join(",")})`;
}

/** A pure sample of saved growth: no render clock, randomness, or changing fruit positions. */
export function forestFruitVisual(growth: number, clusterIndex = 0, fruitIndex = 0,
  appearance: ForestFruitAppearance = FOREST_FRUIT_APPEARANCES.woodlandBerry) {
  const cluster = Math.max(0, Number.isFinite(clusterIndex) ? Math.floor(clusterIndex) : 0) % 7;
  const fruit = Math.max(0, Number.isFinite(fruitIndex) ? Math.floor(fruitIndex) : 0) % 3;
  const delay = cluster * appearance.clusterDelay + fruit * appearance.fruitDelay;
  const maturity = unit((unit(growth) - delay) / Math.max(.01, appearance.ripeAt - delay));
  const filling = smooth((maturity - appearance.fillingAt) / (appearance.coloringAt - appearance.fillingAt));
  const ripeness = smooth((maturity - appearance.coloringAt) / (1 - appearance.coloringAt));
  const from = maturity < appearance.coloringAt ? appearance.green : appearance.filling;
  const to = maturity < appearance.coloringAt ? appearance.filling : appearance.ripe;
  const color = maturity < appearance.coloringAt ? filling : ripeness;
  return {
    maturity, ripeness,
    size: appearance.minimumSize + (1 - appearance.minimumSize) * smooth(maturity),
    opacity: smooth(maturity / .1),
    palette: Object.fromEntries(Object.keys(from).map(key => [key,
      mixColor(from[key as keyof FruitPalette], to[key as keyof FruitPalette], color)])) as FruitPalette,
  };
}
