/** Shared moonlit fill for both geometric shadows and the legacy light field.
 * It lifts unlit paths without flattening the painted wood, foliage and water.
 * Called only while baking a cached field, never as another per-frame pass. */
export function drawForestNightAmbient(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = "#3d4f70";
  ctx.fillRect(0, 0, width, height);
  const moon = ctx.createRadialGradient(width * .68, height * .12, 0,
    width * .68, height * .12, Math.max(width, height) * .98);
  moon.addColorStop(0, "rgba(126,157,204,.3)");
  moon.addColorStop(.55, "rgba(94,128,184,.14)");
  moon.addColorStop(1, "rgba(76,101,156,0)");
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = moon;
  ctx.fillRect(0, 0, width, height);
}
