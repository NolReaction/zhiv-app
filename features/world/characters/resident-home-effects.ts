import type { WorldResidentId } from "./world-characters-model";
import type { WorldPoint } from "@/features/world/tiled/types";

export type ResidentHomeIndicator = {
  id: WorldResidentId;
  position: WorldPoint;
  elapsed: number;
  size?: number;
};
export type ResidentHomeParticle = WorldPoint & { unit: number; opacity: number; flipped: boolean };

/** The shared scene supplies indoor state and time. Painting never invents a
 * sleeping resident, a sound, an inventory item or another animation clock. */
export function residentHomeParticles(indicator: ResidentHomeIndicator, still: boolean): ResidentHomeParticle[] {
  const size = indicator.size ?? 44, { x, y } = indicator.position;
  if (![x, y, size, indicator.elapsed].every(Number.isFinite) || size <= 0) return [];
  return [0, 1].map(index => {
    const phase = still ? .32 + index * .28 : ((indicator.elapsed * .18 + index * .5) % 1 + 1) % 1;
    return { x: x + (index ? 3 : -5) * size / 44 + (still ? 0 : Math.sin(phase * Math.PI * 2) * size * .035),
      y: y - size * (.5 + phase * .28), unit: size / 44 * (index ? .85 : 1),
      opacity: still ? .72 : Math.sin(phase * Math.PI) * .78, flipped: index === 1 };
  });
}

const motif: Record<WorldResidentId, { color: string; light: string; rows: readonly string[] }> = {
  plesk: { color: "#76b6bc", light: "#d5e9d3", rows: ["   xxx  x", " xxxxxxxx", "xxxxxxxx ", " xxxxxxxx", "   xxx  x"] },
  builder: { color: "#c2aa78", light: "#f1dfab", rows: ["xxxxx  ", "xxxxx  ", "  xx   ", "  xx   ", "  xx   ", "  xx   "] },
  lopukh: { color: "#8cae66", light: "#d9dca4", rows: ["    xx ", "  xxxx ", " xxxxx ", " xxxxx ", " xxxxx ", "xxx    ", "x      "] },
  kamneshmyg: { color: "#a4b6bc", light: "#e6dfb7", rows: ["   x   ", "  xxx  ", " xxxxx ", "xxxxxxx", " xxxxx ", "  xxx  ", "   x   "] },
  leaftail: { color: "#d2ad56", light: "#f5df91", rows: ["  xxx  ", " xxxxx ", "xxxxxxx", "xxxxxxx", "xxxxxxx", " xxxxx ", "  xxx  "] },
};

/** A pair of quiet occupational daydreams. Pleska has floating little fish,
 * including during a daytime stay at home; no text font or sleep letters. */
export function drawResidentHomeIndicator(ctx: CanvasRenderingContext2D, indicator: ResidentHomeIndicator, still: boolean) {
  const particles = residentHomeParticles(indicator, still), symbol = motif[indicator.id];
  if (!particles.length || !symbol) return;
  ctx.save();
  const alpha = ctx.globalAlpha;
  for (const particle of particles) {
    if (particle.opacity <= .001) continue;
    const width = symbol.rows[0].length, left = particle.x - width * particle.unit / 2;
    ctx.globalAlpha = alpha * particle.opacity;
    for (let row = 0; row < symbol.rows.length; row++) for (let column = 0; column < width; column++) {
      if (symbol.rows[row][column] !== "x") continue;
      const px = particle.flipped ? width - column - 1 : column;
      ctx.fillStyle = row < 2 ? symbol.light : symbol.color;
      ctx.fillRect(left + px * particle.unit, particle.y + row * particle.unit, particle.unit, particle.unit);
    }
    if (indicator.id === "plesk") {
      ctx.fillStyle = "#355c66";
      ctx.fillRect(left + (particle.flipped ? 5 : 3) * particle.unit, particle.y + 2 * particle.unit, particle.unit, particle.unit);
    }
  }
  ctx.restore();
}
