/** Sixteen distance-driven poses keep each source-pixel joint within one
 * pixel of its neighbours, including the loop seam. One sole is always down;
 * the painter can keep its contact fixed instead of bobbing the whole actor. */
export function forestVillagerGait(frame: number) {
  const index = Number.isFinite(frame) ? ((Math.trunc(frame) % 16) + 16) % 16 : 0;
  const step = [0, 1, 2, 2, 3, 2, 2, 1, 0, -1, -2, -2, -3, -2, -2, -1][index];
  const half = index % 8;
  const lift = [0, 0, 1, 1, 2, 1, 1, 0][half];
  return { step, swing: Math.sign(step), bob: half >= 2 && half <= 6 ? -1 : 0,
    leftLift: index >= 8 ? lift : 0, rightLift: index < 8 ? lift : 0 };
}
