type FruitPalette = { shade: string; body: string; light: string; detail: string; stem: string };
export type ForestFruitAppearance = {
  green: FruitPalette; filling: FruitPalette; ripe: FruitPalette;
  /** The visual crop must be fully ripe when the existing harvest rule accepts it. */
  ripeAt: number; clusterDelay: number; fruitDelay: number;
  minimumSize: number; fillingAt: number; coloringAt: number;
};

/** Artwork profiles only. Crop selection and species persistence are not implemented. */
export const FOREST_FRUIT_APPEARANCES = {
  woodlandBerry: {
    green: { shade: "#46592a", body: "#7f9840", light: "#b2bf68", detail: "#5f7733", stem: "#536a30" },
    filling: { shade: "#756035", body: "#ae9549", light: "#d4ba70", detail: "#917737", stem: "#58662e" },
    ripe: { shade: "#854622", body: "#c77332", light: "#e6ac60", detail: "#a25229", stem: "#626731" },
    ripeAt: .98, clusterDelay: .024, fruitDelay: .012,
    minimumSize: .2, fillingAt: .34, coloringAt: .61,
  },
} as const satisfies Record<string, ForestFruitAppearance>;

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
