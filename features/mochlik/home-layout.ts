/** Existing home art uses a 256 × 256 drawing canvas. Keep these anchors together
 * when preparing separate house sprites; upgrades must preserve the doorway. */
export const HOME_CANVAS_SIZE = 256;
export const HOUSE_ANCHORS = {
  inside: { x: .708, y: .407 },
  doorstep: { x: .653, y: .49 },
  doorway: [
    { x: 169, y: 91, width: 23, height: 18 },
    { x: 173, y: 86, width: 15, height: 5 },
  ],
  lamp: { x: 194, y: 101, width: 5, height: 5 },
  lampHighlight: { x: 196, y: 101, width: 2, height: 4 },
  lampGlow: [
    { x: 188, y: 98, width: 17, height: 12 },
    { x: 191, y: 95, width: 11, height: 18 },
  ],
} as const;
