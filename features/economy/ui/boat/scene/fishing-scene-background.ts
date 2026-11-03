import type { FishingScenePoint } from "./fishing-scene-types";

/** Original replaceable scenery; boat and actor artwork never get flattened into it. */
export function paintFishingLandscape(ctx: CanvasRenderingContext2D, width: number, height: number, surface: number, time: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, surface);
  sky.addColorStop(0, "#b3ba9e"); sky.addColorStop(.65, "#c4c9b0"); sky.addColorStop(1, "#749c96");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, width, surface);
  ctx.fillStyle = "rgba(244,225,167,.28)"; ctx.beginPath(); ctx.arc(width * .73, surface * .37, 55, 0, Math.PI * 2); ctx.fill();
  function hill(color: string, baseline: number, peaks: readonly number[]) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(-40, surface);
    for (let i = 0; i < peaks.length; i++) ctx.lineTo(width * i / (peaks.length - 1), baseline - peaks[i]);
    ctx.lineTo(width + 40, surface + 12); ctx.closePath(); ctx.fill();
  }
  hill("#77948b", surface * .88, [25, 60, 40, 110, 76, 120, 50, 30]);
  hill("#4e7771", surface * .97, [65, 35, 78, 25, 42, 18, 70, 48]);
  hill("#355b55", surface, [24, 10, 32, 12, 5, 18, 26, 30]);
  const water = ctx.createLinearGradient(0, surface, 0, height);
  water.addColorStop(0, "#477e80"); water.addColorStop(.16, "#28646c"); water.addColorStop(.62, "#174954"); water.addColorStop(1, "#0e303e");
  ctx.fillStyle = water; ctx.fillRect(0, surface, width, height - surface);
  ctx.fillStyle = "rgba(181,215,191,.055)";
  for (let i = 0; i < 4; i++) {
    const x = width * (.24 + i * .19);
    ctx.beginPath(); ctx.moveTo(x, surface); ctx.lineTo(x + 65, surface);
    ctx.lineTo(x + 190, height); ctx.lineTo(x - 90, height); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = "rgba(206,230,208,.16)"; ctx.lineWidth = 2;
  for (let i = 0; i < 18; i++) {
    const x = ((i * 127 + Math.sin(i * 3 + time * .25) * 18) % (width + 100)) - 50;
    const y = surface + 4 + (i % 5) * 10;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 32 + i % 4 * 12, y); ctx.stroke();
  }
  ctx.fillStyle = "rgba(10,30,31,.22)";
  ctx.beginPath(); ctx.ellipse(width * .32, surface + 25, width * .25, 18, 0, 0, Math.PI * 2); ctx.fill();
}

export function paintFishingRipples(ctx: CanvasRenderingContext2D, point: FishingScenePoint, time: number, strength = 1) {
  for (let i = 0; i < 3; i++) {
    const phase = (time * .7 + i / 3) % 1;
    ctx.strokeStyle = `rgba(210,234,214,${(1 - phase) * .28 * strength})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(point.x, point.y, 8 + phase * 48, 2 + phase * 10, 0, 0, Math.PI * 2); ctx.stroke();
  }
}

export function paintFishingReeds(ctx: CanvasRenderingContext2D, width: number, height: number, time: number) {
  ctx.lineCap = "round";
  for (const side of [-1, 1]) for (let i = 0; i < 7; i++) {
    const x = side < 0 ? i * 17 - 20 : width + 20 - i * 16;
    const top = height - 36 - (i % 4) * 27, sway = Math.sin(time * .6 + i) * 4;
    ctx.strokeStyle = i % 2 ? "#1b3e36" : "#24483c"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x, height + 12); ctx.quadraticCurveTo(x + side * 7, top + 32, x + side * 18 + sway, top); ctx.stroke();
    if (i % 2) { ctx.strokeStyle = "#4d5340"; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(x + side * 18 + sway, top); ctx.lineTo(x + side * 20 + sway, top - 17); ctx.stroke(); }
  }
}
