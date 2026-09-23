import type { WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
export type ForestAirParticle = WorldPoint & { size: number; opacity: number; phase: number };
export type ForestBird = ForestAirParticle & { angle: number };

const BUTTERFLY_COLORS = [
  { edge: "#62402d", wing: "#eeb34d", spot: "#ffe1a1" },
  { edge: "#335968", wing: "#79c7df", spot: "#d1edf0" },
  { edge: "#654661", wing: "#c791c8", spot: "#f2d4e5" },
] as const;

/** Four rounded, tapered wings retain the butterfly silhouette at clearing scale. */
export function drawForestButterfly(ctx: CanvasRenderingContext2D, particle: ForestAirParticle, elapsed: number) {
  const s = particle.size, flutter = .42 + Math.abs(Math.sin(elapsed * 7 + particle.phase)) * .58;
  const palette = BUTTERFLY_COLORS[Math.floor(Math.abs(particle.phase) * 3) % BUTTERFLY_COLORS.length];
  ctx.save(); ctx.translate(particle.x, particle.y); ctx.rotate(Math.sin(particle.phase) * .38);
  ctx.globalAlpha = particle.opacity;
  for (const side of [-1, 1]) {
    const wing = (inset: number) => {
      ctx.beginPath(); ctx.moveTo(side * s * .16, -s * .45);
      ctx.bezierCurveTo(side * s * (3.4 - inset) * flutter, -s * 3.3,
        side * s * (3.7 - inset) * flutter, -s * .8, side * s * 1.9 * flutter, s * .2);
      ctx.bezierCurveTo(side * s * (3 - inset) * flutter, s * 2.5,
        side * s * .65 * flutter, s * 2.7, side * s * .16, s * .45);
      ctx.closePath(); ctx.fill();
    };
    ctx.fillStyle = palette.edge; wing(0);
    ctx.fillStyle = palette.wing; wing(.42);
    ctx.fillStyle = palette.spot;
    ctx.beginPath(); ctx.ellipse(side * s * 1.9 * flutter, -s * 1.15, s * .4 * flutter, s * .6, side * .55, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(side * s * 1.2 * flutter, s * 1.05, s * .3 * flutter, s * .4, 0, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = "#514334";
  ctx.beginPath(); ctx.ellipse(0, 0, s * .28, s * 1.45, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, -s * 1.45, s * .38, s * .38, 0, 0, TAU); ctx.fill();
  ctx.restore();
}

/** A radial falloff and round warm core avoid hard square pixels around the glow. */
export function drawForestFirefly(ctx: CanvasRenderingContext2D, particle: ForestAirParticle, elapsed: number) {
  const s = particle.size * (.97 + Math.cos(elapsed * .65 + particle.phase) * .03);
  ctx.save();
  const glow = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, s * 4.4);
  glow.addColorStop(0, "rgba(223,245,154,.55)");
  glow.addColorStop(.3, "rgba(194,232,120,.2)");
  glow.addColorStop(1, "rgba(178,225,101,0)");
  ctx.globalAlpha = particle.opacity; ctx.fillStyle = glow;
  ctx.beginPath(); ctx.ellipse(particle.x, particle.y, s * 4.4, s * 4.4, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#f5f5be";
  ctx.beginPath(); ctx.ellipse(particle.x, particle.y, s * .46, s * .46, 0, 0, TAU); ctx.fill();
  ctx.restore();
}

/** Body, head, beak, forked tail and layered flight feathers remain visible in motion. */
export function drawForestBird(ctx: CanvasRenderingContext2D, bird: ForestBird) {
  const s = bird.size, spread = 2.5 + (Math.sin(bird.phase) + 1) * 1.35;
  ctx.save(); ctx.translate(bird.x, bird.y); ctx.rotate(bird.angle);
  ctx.globalAlpha = bird.opacity; ctx.fillStyle = "#41534d";
  // The tail has two distinct feather tips behind a filled, rounded torso.
  ctx.beginPath(); ctx.moveTo(-s * 1.1, 0); ctx.lineTo(-s * 4.5, -s * 1.25);
  ctx.lineTo(-s * 3.7, 0); ctx.lineTo(-s * 4.5, s * 1.25); ctx.closePath(); ctx.fill();
  for (const side of [-1, 1]) {
    ctx.fillStyle = "#41534d";
    ctx.beginPath(); ctx.moveTo(s * .95, side * s * .35);
    ctx.bezierCurveTo(s * .6, side * s * spread, -s * 1.1, side * s * (spread + 1.1), -s * 2.3, side * s * spread);
    ctx.lineTo(-s * 3.6, side * s * (spread - .4));
    ctx.lineTo(-s * 2.65, side * s * (spread - 1.1));
    ctx.lineTo(-s * 3.25, side * s * (spread - 1.2));
    ctx.lineTo(-s * 2.4, side * s * (spread - 1.9));
    ctx.lineTo(-s * 2.75, side * s * (spread - 2));
    ctx.lineTo(-s * 1.5, side * s * .25); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#82918a";
    ctx.beginPath(); ctx.ellipse(-s * .9, side * s * spread * .48, s * .55, s * spread * .36, side * .4, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = "#56685e";
  ctx.beginPath(); ctx.ellipse(0, 0, s * 2.6, s * .95, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#c6c9ae";
  ctx.beginPath(); ctx.ellipse(s * .55, s * .12, s * 1.55, s * .47, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#47594f";
  ctx.beginPath(); ctx.ellipse(s * 2.05, -s * .05, s * .95, s * .78, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = "#b99a58";
  ctx.beginPath(); ctx.moveTo(s * 2.7, -s * .3); ctx.lineTo(s * 3.8, 0); ctx.lineTo(s * 2.7, s * .35); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#182b24";
  ctx.beginPath(); ctx.ellipse(s * 2.25, -s * .28, s * .19, s * .19, 0, 0, TAU); ctx.fill();
  ctx.restore();
}
