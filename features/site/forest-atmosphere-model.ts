export type ForestParticle = { x: number; y: number; depth: number; phase: number; pace: number };

/** Keep a decorative layer small even on a large, high-DPI display. */
export function atmosphereBudget(width: number, height: number, deviceRatio: number, coarsePointer: boolean) {
  const area = Math.max(1, width) * Math.max(1, height);
  const ratio = Math.min(Math.max(1, deviceRatio || 1), 1.5, Math.sqrt(1_500_000 / area));
  return { ratio, particles: coarsePointer ? 18 : 30, interval: 1000 / (coarsePointer ? 20 : 24) };
}

/** A fixed seed prevents an unrelated random composition on every rerender. */
export function forestParticles(count: number): ForestParticle[] {
  let seed = 271828;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: Math.min(40, Math.max(0, Math.floor(count))) }, () => ({
    x: .04 + random() * .92, y: .12 + random() * .78,
    depth: .2 + random() * .8, phase: random() * Math.PI * 2, pace: .18 + random() * .18,
  }));
}

export function forestParticleFrame(particle: ForestParticle, seconds: number, pointerX: number, pointerY: number) {
  const phase = seconds * particle.pace + particle.phase;
  return {
    x: particle.x + Math.sin(phase) * .025 + pointerX * particle.depth * .008,
    y: particle.y + Math.cos(phase * .8) * .035 + pointerY * particle.depth * .008,
    opacity: (.34 + .4 * ((Math.sin(phase * 1.7) + 1) / 2)) * particle.depth,
    size: 7 + particle.depth * 12,
  };
}
