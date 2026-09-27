import type { ForestCampfire } from "./forest-campfire";

const TAU = Math.PI * 2;
function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
}
function stone(ctx: CanvasRenderingContext2D, r: number, i: number, warmth: number, wetness: number) {
  const a = i / 9 * TAU, x = Math.cos(a) * r * .9, y = Math.sin(a) * r * .5;
  const rx = r * (.23 + i % 3 * .015), ry = r * .16;
  ellipse(ctx, x + r * .025, y + ry * .48, rx * 1.06, ry * .9, "rgba(23,24,17,.28)");
  ellipse(ctx, x, y, rx, ry, i % 2 ? "#585b4c" : "#676551");
  // A small faceted upper face, with its warm edge pointing towards the coals.
  ctx.fillStyle = i % 2 ? "#83836b" : "#969074";
  ctx.beginPath(); ctx.moveTo(x - rx, y - ry * .15);
  ctx.lineTo(x - rx * .43, y - ry * .95); ctx.lineTo(x + rx * .45, y - ry * .85);
  ctx.lineTo(x + rx * .88, y - ry * .1); ctx.lineTo(x + rx * .25, y + ry * .18);
  ctx.closePath(); ctx.fill();
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * warmth * .45;
  ellipse(ctx, x - Math.cos(a) * rx * .45, y - Math.sin(a) * ry * .5, rx * .5, ry * .28, "#efaa64");
  ctx.globalAlpha = alpha * wetness * .24;
  ellipse(ctx, x - rx * .2, y - ry * .52, rx * .34, ry * .12, "#d9d7bb");
  ctx.globalAlpha = alpha;
}
function logs(ctx: CanvasRenderingContext2D, r: number) {
  ctx.lineCap = "round";
  for (const angle of [-.28, .4]) {
    ctx.save(); ctx.rotate(angle);
    ctx.strokeStyle = "#2c2119"; ctx.lineWidth = r * .3;
    ctx.beginPath(); ctx.moveTo(-r * .58, 0); ctx.lineTo(r * .57, 0); ctx.stroke();
    ctx.strokeStyle = "#785337"; ctx.lineWidth = r * .11;
    ctx.beginPath(); ctx.moveTo(-r * .48, -r * .065); ctx.lineTo(r * .42, -r * .065); ctx.stroke();
    ellipse(ctx, r * .56, 0, r * .105, r * .13, "#947048");
    ellipse(ctx, r * .57, 0, r * .043, r * .062, "#523923");
    // Broken charcoal bands follow the wood, avoiding evenly striped logs.
    ctx.strokeStyle = "#211e17"; ctx.lineWidth = r * .045;
    for (const offset of [-.25, .02, .29]) {
      ctx.beginPath(); ctx.moveTo(r * offset, -r * .105);
      ctx.lineTo(r * (offset + .035), -r * .025); ctx.lineTo(r * (offset + .015), r * .08); ctx.stroke();
    }
    ctx.restore();
  }
}
function tongue(ctx: CanvasRenderingContext2D, x: number, width: number, height: number, sway: number) {
  ctx.beginPath(); ctx.moveTo(x - width, 0);
  ctx.bezierCurveTo(x - width * 1.1, -height * .36, x + sway * .25 - width * .22, -height * .62, x + sway, -height);
  ctx.bezierCurveTo(x + sway * .8 + width * .1, -height * .62, x + width * 1.15, -height * .28, x + width, 0);
  ctx.closePath(); ctx.fill();
}
/** All particles are sampled from shared time; the painter owns no timers. */
export function drawForestCampfires(ctx: CanvasRenderingContext2D, fires: readonly ForestCampfire[], elapsed: number, still: boolean, emissionOnly = false) {
  const time = still ? 0 : elapsed;
  for (const fire of fires) {
    const { x, y } = fire.position, r = fire.radius, heat = fire.flame;
    const alpha = ctx.globalAlpha, phase = x * .073 + y * .041;
    const breath = .93 + Math.sin(time * 2.3 + phase) * .05 + Math.sin(time * 4.7 + phase * .7) * .025;
    ctx.save(); ctx.translate(x, y);
    if (!emissionOnly) {
      ellipse(ctx, 0, r * .25, r * 1.35, r * .65, "rgba(27,31,17,.13)");
      ellipse(ctx, 0, 0, r * .92, r * .55, "#403a28");
      ellipse(ctx, 0, -.2, r * .74, r * .4, "#28251d");
      for (let i = 0; i < 7; i++) {
        const a = i * 2.4;
        ellipse(ctx, Math.cos(a) * r * .53, Math.sin(a) * r * .27, r * .07, r * .035, i % 2 ? "#666151" : "#302b21");
      }
      for (let i = 5; i < 9; i++) stone(ctx, r, i, heat * breath, fire.wetness);
      logs(ctx, r);
    }
    if (fire.embers > .02) {
      for (let i = 0; i < 6; i++) {
        ctx.globalAlpha = alpha * fire.embers * (.76 + Math.sin(time * 1.7 + phase + i * 2) * .16);
        const ex = (i - 2.5) * r * .16, ey = Math.sin(i * 2) * r * .14;
        ellipse(ctx, ex, ey, r * .09, r * .055, i % 2 ? "#dd7130" : "#b74522");
        ellipse(ctx, ex - r * .015, ey - r * .014, r * .038, r * .021, "#efb761");
      }
      ctx.globalAlpha = alpha;
    }
    if (heat > .015) {
      const sway = (Math.sin(time * 2.1 + phase) * .12 + Math.sin(time * 3.9 + phase) * .045) * r;
      const height = r * 1.35 * heat * breath;
      const outer = ctx.createLinearGradient(0, -height, 0, r * .08);
      outer.addColorStop(0, "rgba(216,94,28,.06)"); outer.addColorStop(.3, "#e88529"); outer.addColorStop(1, "#ffc67c");
      ctx.fillStyle = outer; ctx.globalAlpha = alpha * heat * .83;
      tongue(ctx, -r * .25, r * .24, height * (.78 + Math.sin(time * 3.1 + phase) * .1), sway - r * .08);
      tongue(ctx, r * .22, r * .25, height * (.85 + Math.sin(time * 3.7 + phase + 1) * .09), sway + r * .06);
      tongue(ctx, 0, r * .3, height, sway);
      const core = ctx.createLinearGradient(0, -height * .66, 0, 0);
      core.addColorStop(0, "rgba(255,215,133,0)"); core.addColorStop(.5, "#ffd789"); core.addColorStop(1, "#ffeab3");
      ctx.fillStyle = core; ctx.globalAlpha = alpha * heat * .73;
      tongue(ctx, -r * .035, r * .19, height * .68, sway * .5);
      // Three staggered tracks include a quiet interval after each ember fades.
      if (!still) for (let i = 0; i < 3; i++) {
        const cycle = ((time * .23 + phase + i / 3) % 1 + 1) % 1;
        if (cycle >= .58) continue;
        const age = cycle / .58;
        const ex = Math.sin(age * 4.3 + i) * r * .2 + age * r * .38;
        const ey = -r * (.62 + age * 1.9);
        ctx.globalAlpha = alpha * Math.sin(age * Math.PI) * heat * .52;
        ctx.strokeStyle = "#ffc977"; ctx.lineWidth = r * .045 * (1 - age * .45);
        ctx.beginPath(); ctx.moveTo(ex, ey + r * .09 * (1 - age)); ctx.lineTo(ex + r * .02, ey); ctx.stroke();
      }
      ctx.globalAlpha = alpha;
    }
    if (!emissionOnly) {
      // Near stones cover the flame's foot and ground the bright center in the hearth.
      for (let i = 0; i < 5; i++) stone(ctx, r, i, heat * breath, fire.wetness);
      if (!still && (heat > .03 || fire.embers > .12)) {
        // Damp, still-warm embers release a short pale wisp; cold wet wood does not.
        const steam = fire.wetness * fire.embers * (1 - heat);
        for (let i = 0; i < 5; i++) {
          const age = ((time * .14 + i / 5 + phase) % 1 + 1) % 1;
          const size = r * (.17 + age * (.49 + steam * .2));
          const sx = age * r * 1.05 + Math.sin(age * 5 + phase + i) * r * .12;
          const sy = -r * (.85 + age * (2.7 - steam * .5));
          const smoke = ctx.createRadialGradient(sx, sy, 0, sx, sy, size);
          smoke.addColorStop(0, steam > .06 ? "rgba(210,211,192,.75)" : "rgba(177,173,152,.65)");
          smoke.addColorStop(1, "rgba(180,179,159,0)");
          ctx.globalAlpha = alpha * Math.sin(age * Math.PI) ** 2 * (.08 * Math.max(heat, fire.embers) + steam * .08);
          ctx.fillStyle = smoke; ctx.fillRect(sx - size, sy - size, size * 2, size * 2);
        }
      }
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
    const phase = fire.position.x * .073 + fire.position.y * .041;
    const pulse = still ? 1 : 1 + Math.sin(elapsed * 2.3 + phase) * .035 + Math.sin(elapsed * 4.7 + phase * .7) * .018;
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
