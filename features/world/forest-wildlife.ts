import type { WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
export type ForestAirParticle = WorldPoint & { size: number; opacity: number; phase: number };
export type ForestBirdSpecies = "robin" | "blue-tit" | "swallow" | "finch";
export type ForestBirdState = "flap" | "glide" | "landing" | "perched" | "preen" | "hop" | "takeoff";
export type ForestBird = ForestAirParticle & {
  angle: number;
  id?: string;
  species?: ForestBirdSpecies;
  scenario?: string;
  state?: ForestBirdState;
  wingFold?: number;
  wingLift?: number;
  headTurn?: number;
  tailFlick?: number;
  legReach?: number;
  bank?: number;
  facing?: -1 | 1;
  preen?: number;
  perchId?: string;
};

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

const BIRD_COLORS = {
  robin: { back: "#655849", head: "#655143", breast: "#dc8951", cheek: "#e9a062", tail: "#493f38", farWing: "#544638", wing: "#766044", feather: "#b6a17c", beak: "#80522f", eye: "#211d19" },
  "blue-tit": { back: "#668765", head: "#3e7c9a", breast: "#dbca6e", cheek: "#e6e5c9", tail: "#376778", farWing: "#355e75", wing: "#538da4", feather: "#c9dcca", beak: "#526164", eye: "#1a2b37" },
  swallow: { back: "#344c62", head: "#314354", breast: "#e0d4b3", cheek: "#b57155", tail: "#263b50", farWing: "#263c52", wing: "#3a556e", feather: "#8b9fad", beak: "#675043", eye: "#15202a" },
  finch: { back: "#627857", head: "#4f6146", breast: "#cebc7d", cheek: "#d8c99a", tail: "#364940", farWing: "#41554a", wing: "#57705a", feather: "#c4ce9b", beak: "#aa8248", eye: "#172b22" },
} as const;

/** Species keep distinct plumage, wing profiles and tails at the clearing's small scale. */
export function drawForestBird(ctx: CanvasRenderingContext2D, bird: ForestBird) {
  const s = bird.size, folded = bird.wingFold ?? 0;
  const species = bird.species ?? "finch", palette = BIRD_COLORS[species];
  const swallow = species === "swallow", tit = species === "blue-tit";
  const facing = bird.facing ?? (Math.cos(bird.angle) < 0 ? -1 : 1);
  const bank = bird.bank ?? Math.atan2(Math.sin(bird.angle), Math.abs(Math.cos(bird.angle)));
  const lift = bird.wingLift ?? .45 + Math.sin(bird.phase) * .5;
  const headTurn = bird.headTurn ?? 0, preen = bird.preen ?? 0, legs = bird.legReach ?? 0;
  const px = (x: number) => x * s * facing, py = (y: number) => y * s;
  const ellipse = (x: number, y: number, rx: number, ry: number, rotation = 0) => {
    ctx.beginPath(); ctx.ellipse(px(x), py(y), s * rx, s * ry, rotation * facing, 0, TAU); ctx.fill();
  };
  ctx.save(); ctx.translate(bird.x, bird.y); ctx.rotate(bank * facing);
  ctx.globalAlpha = bird.opacity;
  // Legs extend before touch-down; feet end exactly at the authored crown anchor.
  if (legs > .01) {
    ctx.strokeStyle = "#7d633f"; ctx.lineWidth = s * .27;
    for (const foot of [-.6, .65]) {
      const footX = foot - .2;
      ctx.beginPath(); ctx.moveTo(px(foot), py(1.1));
      ctx.lineTo(px(footX), py(1.1 + 2.2 * legs));
      ctx.lineTo(px(footX + .7), py(1.1 + 2.2 * legs));
      ctx.moveTo(px(footX), py(1.1 + 2.2 * legs));
      ctx.lineTo(px(footX - .45), py(1 + 2.2 * legs)); ctx.stroke();
    }
  }
  const tailY = folded * 2 + (bird.tailFlick ?? 0) * .8;
  ctx.fillStyle = palette.tail;
  ctx.beginPath(); ctx.moveTo(px(-.9), py(.3));
  ctx.lineTo(px((swallow ? -6 : tit ? -3.6 : -4.1) + folded), py(tailY - (swallow ? 1 : .5)));
  ctx.lineTo(px((swallow ? -3.2 : -3.5) + folded), py(tailY + .1));
  ctx.lineTo(px((swallow ? -6 : tit ? -3.6 : -4) + folded), py(tailY + (swallow ? 1.1 : .6)));
  ctx.lineTo(px(-1), py(1)); ctx.closePath(); ctx.fill();
  // Near and far wings have different foreshortening during each downstroke.
  const spread = (1 - folded) * (2.4 + lift * 3.1) * (swallow ? 1.3 : tit ? .92 : 1);
  for (const side of [-1, 1]) {
    ctx.fillStyle = side < 0 ? palette.farWing : palette.wing;
    if (spread > .03) {
      ctx.beginPath(); ctx.moveTo(px(.8), py(side * .4));
      if (swallow) {
        ctx.bezierCurveTo(px(-.1), py(side * spread * .7), px(-2.7), py(side * spread), px(-4.8), py(side * (spread + .8)));
        ctx.lineTo(px(-2.6), py(side * spread * .38));
      } else {
        ctx.bezierCurveTo(px(.5), py(side * spread), px(-1.5), py(side * (spread + .9)), px(-2.8), py(side * spread));
        ctx.lineTo(px(-3.5), py(side * (spread - .25)));
        ctx.lineTo(px(-2.6), py(side * (spread - .65)));
        ctx.lineTo(px(-3), py(side * (spread - 1)));
      }
      ctx.lineTo(px(-1.5), py(side * .35)); ctx.closePath(); ctx.fill();
      ctx.fillStyle = palette.feather;
      ellipse(-.9, side * spread * .53, .45, Math.max(.08, spread * .27), side * .4);
    }
  }
  ctx.fillStyle = palette.back;
  ellipse(0, 0, (swallow ? 2.55 : 2.3) - folded * .8, (swallow ? .76 : .95) + folded * .8, -.2 * folded);
  ctx.fillStyle = palette.breast;
  ellipse(.55, .28 + folded * .3, 1.45 - folded * .6, .52 + folded * .68, -.2 * folded);
  if (folded > .01) {
    ctx.globalAlpha = bird.opacity * folded; ctx.fillStyle = palette.farWing;
    ellipse(-.48, .12, 1.12, 1.35, -.48);
    ctx.fillStyle = palette.wing; ellipse(-.53, -.15, .65, .85, -.48);
    ctx.fillStyle = palette.feather; ellipse(-.56, -.03, .18, .82, -.56);
    ctx.globalAlpha = bird.opacity;
  }
  const headX = 2 - folded * .85 - preen * 1.3;
  const headY = -.18 - folded * 1.55 + preen * 1.3;
  ctx.fillStyle = palette.head; ellipse(headX, headY, .92, .81);
  ctx.fillStyle = palette.cheek; ellipse(headX + .15, headY + .24, .6, .4);
  if (tit) {
    ctx.fillStyle = "#edf0d7"; ellipse(headX + .05, headY + .02, .77, .52);
    ctx.fillStyle = palette.head; ellipse(headX - .02, headY - .51, .7, .27);
    ctx.fillStyle = "#263c44"; ellipse(headX + .14, headY - .07, .63, .14);
  }
  // Looking back shortens the beak and shifts the visible eye; preening reaches the wing.
  const beakDirection = headTurn < -.65 ? -1 : 1;
  ctx.fillStyle = palette.beak;
  ctx.beginPath(); ctx.moveTo(px(headX + beakDirection * .6), py(headY - .05));
  ctx.lineTo(px(headX + beakDirection * (1.48 - Math.abs(headTurn) * .2)), py(headY + .18 + preen * .35));
  ctx.lineTo(px(headX + beakDirection * .6), py(headY + .32)); ctx.closePath(); ctx.fill();
  ctx.fillStyle = palette.eye; ellipse(headX + beakDirection * .31, headY - .17, .19, .19);
  ctx.fillStyle = "#f7eed0"; ellipse(headX + beakDirection * .34, headY - .23, .055, .055);
  ctx.restore();
}
