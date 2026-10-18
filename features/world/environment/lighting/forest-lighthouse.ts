import type { ForestLightSource } from "./forest-building-lights";

type BeamOptions = { night: number; elapsed: number; reducedMotion: boolean; quality?: "low" | "high" };
type Optics = { volume: HTMLCanvasElement; surface: HTMLCanvasElement };
const TAU = Math.PI * 2;
const optics = new Map<string, Optics>();
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** A finite beam has a narrow bright axis, a soft penumbra and a feathered end.
 * Both fields are baked once per colour; no frame reads terrain pixels or blurs. */
function lighthouseOptics(color: string): Optics | undefined {
  if (typeof document === "undefined") return undefined;
  const key = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#ffe5a6";
  const previous = optics.get(key);
  if (previous) return previous;
  const rgb = [1, 3, 5].map(offset => parseInt(key.slice(offset, offset + 2), 16));
  const bake = (surface: boolean) => {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 192;
    const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let x = 0; x < canvas.width; x++) {
      const along = x / (canvas.width - 1);
      const spread = 2.5 + 89 * along ** .85;
      const fade = smooth(along / .035) * smooth((1 - along) / .27);
      // Surface spill peaks away from the tower, then dies with the same range.
      const density = surface ? .27 * smooth((along - .2) / .2) * Math.exp(-(((along - .55) / .25) ** 2))
        : (.42 * Math.exp(-along * 1.3) + .08) * fade;
      for (let y = 0; y < canvas.height; y++) {
        const across = (y - (canvas.height - 1) / 2) / spread;
        if (Math.abs(across) >= 1) continue;
        const edge = (1 - across * across) ** 2;
        const axis = Math.exp(-across * across * 23);
        const alpha = surface ? density * edge * fade : density * (.46 * edge + .54 * axis);
        const at = (y * canvas.width + x) * 4;
        pixels.data[at] = rgb[0]; pixels.data[at + 1] = rgb[1]; pixels.data[at + 2] = rgb[2];
        pixels.data[at + 3] = Math.round(255 * alpha);
      }
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  };
  const volume = bake(false), surface = bake(true);
  if (!volume || !surface) return undefined;
  const value = { volume, surface };
  // DEV colour edits cannot retain arbitrary historical beams.
  if (optics.size >= 4) optics.delete(optics.keys().next().value!);
  optics.set(key, value);
  return value;
}

/** Two unhurried sweeps alternate with a hold and a soft dark interval. The
 * hidden return happens only after the ray has faded; no perpetual spinner. */
export function forestLighthouseFrame(elapsed: number, reducedMotion: boolean) {
  if (reducedMotion || !Number.isFinite(elapsed)) return { angle: -.32, strength: .48, counter: 0 };
  const t = ((elapsed % 84) + 84) % 84;
  const second = t >= 44, at = second ? t - 44 : t;
  const sweep = second ? 24 : 28, end = second ? -2.05 : .65;
  const hold = sweep + 8, fade = hold + 6;
  const angle = at < sweep ? -.9 + (end + .9) * smooth(at / sweep)
    : at < fade ? end : end + (-.9 - end) * smooth((at - fade) / 2);
  const strength = .82 * smooth(at / 4) * smooth((fade - at) / 6);
  // A second weaker optic joins only the first sweep, then gives way to a
  // single quiet beam. It uses the existing texture and never adds a source.
  const counter = second ? 0 : .28 * smooth((at - 7) / 5) * smooth((26 - at) / 5);
  return { angle, strength, counter };
}

export function forestLighthouseAngle(elapsed: number, reducedMotion: boolean) {
  return forestLighthouseFrame(elapsed, reducedMotion).angle;
}

export function drawLighthouseBeams(ctx: CanvasRenderingContext2D, light: ForestLightSource, options: BeamOptions) {
  const textures = lighthouseOptics(light.color), length = light.beamLength;
  if (!textures || !length) return;
  const beam = forestLighthouseFrame(options.elapsed, options.reducedMotion);
  const energy = options.night * Math.max(0, Math.min(1, light.intensity));
  const ray = (texture: HTMLCanvasElement, ground: boolean, reverse: boolean) => {
    const strength = reverse ? beam.counter : beam.strength;
    if (strength <= 0) return;
    const origin = ground ? light.beamGround ?? light.position : light.position;
    ctx.save(); ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = energy * strength * (ground ? .55 : .96);
    ctx.translate(origin.x, origin.y);
    // Squeeze the world horizontal plane, not the final screen-space sprite.
    ctx.scale(1, .48); ctx.rotate(beam.angle + (reverse ? Math.PI : 0));
    const range = length * (ground ? .94 : 1), width = range * texture.height / texture.width;
    ctx.drawImage(texture, 0, -width / 2, range, width);
    ctx.restore();
  };
  if (options.quality !== "low") {
    ray(textures.surface, true, false); ray(textures.surface, true, true);
  }
  ray(textures.volume, false, false); ray(textures.volume, false, true);
}

/** Small Fresnel reflections retain the painted brass and horizontal glass ribs. */
export function drawLighthouseLens(ctx: CanvasRenderingContext2D, light: ForestLightSource, options: BeamOptions) {
  if (!light.glass) return;
  const { x, y } = light.position, glass = light.glass;
  const energy = options.night * Math.max(0, Math.min(1, light.intensity));
  const rgb = /^#[0-9a-f]{6}$/i.test(light.color) ? [1, 3, 5].map(offset => parseInt(light.color.slice(offset, offset + 2), 16)).join(",") : "255,229,166";
  const radius = Math.max(glass.width, glass.height) * 2.6;
  ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = energy;
  const halo = ctx.createRadialGradient(x, y, 0, x, y, radius);
  halo.addColorStop(0, `rgba(${rgb},.48)`); halo.addColorStop(.24, `rgba(${rgb},.18)`);
  halo.addColorStop(.6, `rgba(${rgb},.035)`); halo.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = halo; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.translate(x, y); ctx.rotate(glass.rotation);
  ctx.beginPath(); ctx.ellipse(0, 0, glass.width / 2, glass.height / 2, 0, 0, TAU); ctx.clip();
  const lens = ctx.createRadialGradient(-glass.width * .08, -glass.height * .05, 0, 0, 0, glass.height * .7);
  lens.addColorStop(0, "rgba(255,252,219,.7)"); lens.addColorStop(.3, "rgba(255,225,143,.38)");
  lens.addColorStop(1, "rgba(255,183,78,.08)");
  ctx.fillStyle = lens; ctx.fillRect(-glass.width / 2, -glass.height / 2, glass.width, glass.height);
  ctx.fillStyle = "rgba(255,249,202,.55)";
  for (const row of options.quality === "low" ? [0] : [-.27, -.09, .09, .27])
    ctx.fillRect(-glass.width * .37, glass.height * row, glass.width * .74, glass.height * .035);
  ctx.restore();
}
