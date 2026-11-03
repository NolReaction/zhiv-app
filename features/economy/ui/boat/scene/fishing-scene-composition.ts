const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const variants = [
  { id: "quiet-reach", offset: -.018, floatOffset: -.015, roll: -.008, surface: 0, currentPhase: 0 },
  { id: "open-water", offset: .018, floatOffset: .012, roll: .006, surface: .025, currentPhase: 11 },
  { id: "sheltered-bend", offset: 0, floatOffset: .025, roll: .013, surface: -.018, currentPhase: 27 },
] as const;

/** A public voyage id selects only scenery. Reopening or casting again cannot move the composition. */
export function fishingCompositionVariant(sceneKey?: string) {
  let hash = 2166136261;
  for (const character of sceneKey ?? "") hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return variants[sceneKey ? hash % variants.length : 0];
}

/** CSS-pixel framing keeps the boat and float together above the fixed control dock. */
export function fishingSceneComposition(width: number, height: number, sceneKey?: string) {
  const w = Math.max(1, Number.isFinite(width) ? width : 1280), h = Math.max(1, Number.isFinite(height) ? height : 720);
  const shortLandscape = h < 500 && w > h, portrait = w < 700 && !shortLandscape;
  const hud = shortLandscape ? 185 : portrait ? 280 : 260;
  const safeTop = shortLandscape ? 64 : portrait ? 138 : 114;
  const availableBottom = Math.max(safeTop + 38, h - hud - 24);
  const availableHeight = availableBottom - safeTop;
  const variant = fishingCompositionVariant(sceneKey);
  const boatWidth = Math.min(w * (portrait ? .67 : .58), availableHeight * (shortLandscape ? 2.6 : 2.8), 760);
  const gap = Math.min(100, w * .08);
  const groupWidth = boatWidth + gap;
  const boatX = clamp((w - groupWidth) / 2 + variant.offset * w, w * .035, Math.max(w * .035, w - boatWidth - gap));
  const depth = clamp(availableHeight * .55, 72, 168);
  const breathingRoom = Math.max(0, availableHeight - (boatWidth * .3 + depth));
  const surface = Math.max(safeTop + boatWidth * .255,
    safeTop + boatWidth * .27 + breathingRoom * .52 + variant.surface * Math.min(availableHeight, 200));
  const besideHull = w > h && h < 760;
  const waterTop = Math.max(safeTop + 6, besideHull ? safeTop + 8 : surface - 12);
  const waterBottom = Math.max(waterTop + 1, Math.min(availableBottom, besideHull ? availableBottom : waterTop + depth));
  const floatX = clamp(boatX + boatWidth * .96 + gap + variant.floatOffset * w, boatX + boatWidth * .97, w - 36);
  return { variant, shortLandscape, portrait, hud, safeTop, availableBottom, boatWidth, boatX, surface,
    waterTop, waterBottom, floatX };
}
