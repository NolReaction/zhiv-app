import type { ForestCampfire } from "./forest-campfire";

const TAU = Math.PI * 2;
function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
}
/** All particles are sampled from shared time; the painter owns no timers. */
export function drawForestCampfires(ctx: CanvasRenderingContext2D, fires: readonly ForestCampfire[], elapsed: number, still: boolean, emissionOnly = false) {
  const time = still ? 0 : elapsed;
  for (const fire of fires) {
    const { x, y } = fire.position, r = fire.radius, heat = fire.flame;
    ctx.save(); ctx.translate(x, y);
    if (!emissionOnly) {
      ellipse(ctx, 0, r * .25, r * 1.35, r * .65, "rgba(27,31,17,.13)");
      ellipse(ctx, 0, 0, r * .92, r * .55, "#403a28");
      ellipse(ctx, 0, -.2, r * .74, r * .4, "#28251d");
      // Uneven stones sit in an ellipse, with small warm top faces.
      for (let i = 0; i < 9; i++) {
        const a = i / 9 * TAU, sx = Math.cos(a) * r * .9, sy = Math.sin(a) * r * .5;
        ellipse(ctx, sx, sy, r * (.23 + i % 3 * .015), r * .16, i % 2 ? "#656756" : "#77745c");
        ellipse(ctx, sx - r * .025, sy - r * .065, r * .17, r * .075, "#979274");
      }
      ctx.lineCap = "round";
      for (const angle of [-.28, .4]) {
        ctx.save(); ctx.rotate(angle); ctx.strokeStyle = "#36251a"; ctx.lineWidth = r * .28;
        ctx.beginPath(); ctx.moveTo(-r * .57, 0); ctx.lineTo(r * .57, 0); ctx.stroke();
        ctx.strokeStyle = "#785135"; ctx.lineWidth = r * .09;
        ctx.beginPath(); ctx.moveTo(-r * .46, -r * .065); ctx.lineTo(r * .44, -r * .065); ctx.stroke(); ctx.restore();
      }
    }
    if (fire.embers > .02) {
      ctx.globalAlpha = fire.embers;
      for (let i = 0; i < 5; i++) ellipse(ctx, (i - 2) * r * .16, Math.sin(i * 2) * r * .14, r * .09, r * .055, i % 2 ? "#ed8241" : "#bf5028");
      ctx.globalAlpha = 1;
    }
    if (heat > .015) {
      // Three overlapping tapered tongues, not an expanding stack of circles.
      for (let i = 0; i < 3; i++) {
        const sway = Math.sin(time * (2.6 + i * .4) + i * 2) * r * .15;
        const height = r * (1.22 + .19 * Math.sin(time * 4.2 + i)) * heat;
        const left = (i - 1) * r * .22, width = r * (i === 1 ? .34 : .27);
        const fill = ctx.createLinearGradient(0, -height, 0, r * .08);
        fill.addColorStop(0, "rgba(224,91,28,.08)"); fill.addColorStop(.3, "#ed9132"); fill.addColorStop(1, "#ffd18a");
        ctx.fillStyle = fill; ctx.globalAlpha = heat * .88;
        ctx.beginPath(); ctx.moveTo(left - width, r * .08);
        ctx.bezierCurveTo(left - width * 1.1, -height * .4, left + sway, -height * .64, left + sway, -height);
        ctx.bezierCurveTo(left + width * .28, -height * .7, left + width * 1.3, -height * .32, left + width, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!still) for (let i = 0; i < 3; i++) {
        const age = (time * .31 + i * .37) % 1;
        ctx.globalAlpha = Math.sin(age * Math.PI) * heat * .48;
        ellipse(ctx, Math.sin(age * 4 + i) * r * .32 + age * r * .35, -r * (.5 + age * 2.2), r * .037, r * .065, "#ffd487");
      }
    }
    // A few soft translucent wisps; wind drift grows with height.
    if (!emissionOnly && !still && (heat > .03 || fire.embers > .12)) for (let i = 0; i < 7; i++) {
      const age = (time * .14 + i / 7) % 1, size = r * (.16 + age * .54);
      ctx.globalAlpha = Math.sin(age * Math.PI) ** 2 * .065 * Math.max(heat, fire.embers);
      ellipse(ctx, age * r * 1.2 + Math.sin(age * 5 + i) * r * .12, -r * (.9 + age * 3), size, size * 1.3, "#bdb5a0");
    }
    ctx.restore();
  }
}
/** Dynamic pools are cheap gradients; they do not invalidate the cached night texture. */
export function drawForestCampfireGlow(ctx: CanvasRenderingContext2D, fires: readonly ForestCampfire[], elapsed: number, still: boolean, night: number, actor?: { x: number; y: number; size: number }) {
  if (night <= 0) return;
  ctx.save(); ctx.globalCompositeOperation = "screen";
  for (const fire of fires) {
    const strength = (fire.flame * .28 + fire.embers * .03) * night;
    if (strength < .003) continue;
    const pulse = still ? 1 : 1 + Math.sin(elapsed * 3.1) * .035 + Math.sin(elapsed * 5.3) * .018;
    const r = fire.radius * 5.2, { x, y } = fire.position;
    const glow = ctx.createRadialGradient(x, y - 3, 0, x, y, r);
    glow.addColorStop(0, `rgba(255,164,73,${strength * pulse})`);
    glow.addColorStop(.45, `rgba(230,126,48,${strength * .45})`); glow.addColorStop(1, "rgba(190,97,30,0)");
    ctx.fillStyle = glow; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Emissive color survives night shading, but stays behind the hero when occluded.
  const exposed = fires.filter(fire => !actor || fire.position.y >= actor.y
    || Math.abs(fire.position.x - actor.x) > actor.size * .42 + fire.radius * .6
    || fire.position.y < actor.y - actor.size);
  drawForestCampfires(ctx, exposed, elapsed, still, true);
  ctx.restore();
}
