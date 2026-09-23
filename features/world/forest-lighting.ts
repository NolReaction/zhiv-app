import type { FixedWorldScene, PreviewLevels, WorldLight, WorldPoint } from "./tiled/types";

export type ForestLightingOptions = {
  night: number;
  elapsed: number;
  reducedMotion: boolean;
  showBuildings?: boolean;
  levels?: PreviewLevels;
};
const TAU = Math.PI * 2;
const TEXTURE_SIZE = 768;
const clamp = (value: number, max = 1) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
const textures = new WeakMap<FixedWorldScene, Map<string, HTMLCanvasElement>>();
const colorParts = (color: string) => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
const rgba = (color: string, alpha: number) => `rgba(${colorParts(color).join(",")},${clamp(alpha)})`;

/** Authored positions are shared by every camera. Legacy site markers remain valid. */
export function forestLightSources(scene: FixedWorldScene, options: Pick<ForestLightingOptions, "showBuildings" | "levels"> = {}): WorldLight[] {
  const sources = [...(scene.lights ?? [])];
  for (const site of scene.sites) {
    if (!site.light || (options.levels?.[site.id] ?? site.initialLevel) < 1) continue;
    if (sources.some(light => Math.hypot(light.position.x - site.light!.x, light.position.y - site.light!.y) < 2)) continue;
    sources.push({ id: `site:${site.id}`, position: site.light, kind: "lantern", radius: 70,
      intensity: 1, color: "#ffd28a", flicker: .04 });
  }
  return sources.filter(light => options.showBuildings !== false || !scene.sites.some(site => {
    const p = light.position, b = site.bounds;
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  }));
}

function seed(id: string) {
  let result = 0;
  for (let index = 0; index < id.length; index++) result = (Math.imul(result, 31) + id.charCodeAt(index)) | 0;
  return (result >>> 0) / 4294967296 * TAU;
}

/** Gentle independent flames; pausing the shared clock freezes every light. */
export function forestLightPulse(light: WorldLight, elapsed: number, reducedMotion: boolean) {
  if (reducedMotion || !light.flicker) return 1;
  const time = Number.isFinite(elapsed) ? elapsed : 0, offset = seed(light.id);
  return 1 + light.flicker * (.52 * Math.sin(time * 3.7 + offset)
    + .3 * Math.sin(time * 6.1 + offset * 3) + .18 * Math.sin(time * 9.3 + offset * 7));
}

function lightTexture(scene: FixedWorldScene, sources: WorldLight[]) {
  if (typeof document === "undefined") return undefined;
  // Only different enabled source sets need another texture. Animation never rebuilds it.
  const key = JSON.stringify(sources.map(light => [light.id, light.position.x, light.position.y,
    light.kind, light.radius, light.intensity, light.color]));
  let cached = textures.get(scene);
  if (!cached) { cached = new Map(); textures.set(scene, cached); }
  if (cached.has(key)) return cached.get(key);
  const canvas = document.createElement("canvas"), scale = TEXTURE_SIZE / Math.max(scene.width, scene.height);
  canvas.width = Math.max(1, Math.ceil(scene.width * scale));
  canvas.height = Math.max(1, Math.ceil(scene.height * scale));
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  ctx.scale(scale, scale);
  // Multiplication darkens the painted world without laying a grey veil over it.
  ctx.fillStyle = "#2d3d62"; ctx.fillRect(0, 0, scene.width, scene.height);
  const moon = ctx.createRadialGradient(scene.width * .68, scene.height * .12, 0,
    scene.width * .68, scene.height * .12, Math.max(scene.width, scene.height) * .98);
  moon.addColorStop(0, "rgba(112,151,198,.28)");
  moon.addColorStop(.55, "rgba(87,121,176,.12)"); moon.addColorStop(1, "rgba(76,101,156,0)");
  ctx.globalCompositeOperation = "screen"; ctx.fillStyle = moon; ctx.fillRect(0, 0, scene.width, scene.height);
  for (const light of sources) {
    if (light.intensity <= 0) continue;
    const { x, y } = light.position, r = light.radius;
    ctx.save(); ctx.translate(x, y + (light.kind === "torch" ? 7 : 3)); ctx.scale(1, .86);
    const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    pool.addColorStop(0, rgba(light.color, light.intensity * .96));
    pool.addColorStop(.14, rgba(light.color, light.intensity * .83));
    pool.addColorStop(.38, rgba(light.color, light.intensity * .44));
    pool.addColorStop(.7, rgba(light.color, light.intensity * .12));
    pool.addColorStop(1, rgba(light.color, 0));
    ctx.fillStyle = pool; ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
  }
  // At most a handful of DEV combinations are useful; do not retain arbitrary level histories.
  if (cached.size >= 4) cached.delete(cached.keys().next().value!);
  cached.set(key, canvas); return canvas;
}

/** One cached illumination texture shades ground, buildings and hero together. */
export function drawForestLighting(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestLightingOptions) {
  const night = clamp(options.night); if (!night) return;
  const texture = lightTexture(scene, forestLightSources(scene, options));
  ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = night;
  if (texture) ctx.drawImage(texture, 0, 0, scene.width, scene.height);
  else { ctx.fillStyle = "#354b78"; ctx.fillRect(0, 0, scene.width, scene.height); }
  ctx.restore();
}

function visible(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number) {
  const t = ctx.getTransform?.();
  if (!t || t.b || t.c || t.a <= 0 || t.d <= 0) return true;
  return (point.x + radius) * t.a + t.e >= 0 && (point.x - radius) * t.a + t.e <= ctx.canvas.width
    && (point.y + radius) * t.d + t.f >= 0 && (point.y - radius) * t.d + t.f <= ctx.canvas.height;
}

/** Torches have physical posts even in daylight; lanterns attach to existing artwork. */
export function drawForestLightFixtures(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, showBuildings = true) {
  for (const light of forestLightSources(scene, { showBuildings })) {
    if (light.kind !== "torch" || !visible(ctx, light.position, 20)) continue;
    const { x, y } = light.position;
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = "rgba(16,22,12,.25)";
    ctx.beginPath(); ctx.ellipse(3, 16.5, 7, 2.2, -.14, 0, TAU); ctx.fill();
    ctx.fillStyle = "#382d20"; ctx.fillRect(-1.8, 1.5, 3.6, 15);
    ctx.fillStyle = "#8b6940"; ctx.fillRect(-1.2, 2, 1.1, 13.8);
    ctx.fillStyle = "#a18a59"; ctx.fillRect(-2.1, 6.8, 4.2, 1.2); ctx.fillRect(-2.1, 9, 4.2, 1.2);
    ctx.fillStyle = "#303b35"; ctx.beginPath(); ctx.moveTo(-4, -.4); ctx.lineTo(4, -.4);
    ctx.lineTo(2.5, 3); ctx.lineTo(-2.5, 3); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#988164"; ctx.lineWidth = .65;
    ctx.beginPath(); ctx.moveTo(-3.8, -.2); ctx.lineTo(3.8, -.2); ctx.stroke(); ctx.restore();
  }
}

/** Small luminous cores sit above the night pass. Broad pools remain textured terrain. */
export function drawForestLightEmitters(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestLightingOptions) {
  const night = clamp(options.night); if (!night) return;
  for (const light of forestLightSources(scene, options)) {
    if (light.intensity <= 0) continue;
    const { x, y } = light.position, pulse = forestLightPulse(light, options.elapsed, options.reducedMotion);
    const glowRadius = Math.min(20, light.radius * .25) * pulse;
    if (!visible(ctx, light.position, Math.max(glowRadius, 9 * pulse))) continue;
    ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = night;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
    glow.addColorStop(0, rgba(light.color, .33 * light.intensity * pulse));
    glow.addColorStop(.24, rgba(light.color, .12 * light.intensity * pulse)); glow.addColorStop(1, rgba(light.color, 0));
    ctx.fillStyle = glow; ctx.fillRect(x - glowRadius, y - glowRadius, glowRadius * 2, glowRadius * 2);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = night * clamp(light.intensity);
    if (light.kind === "torch") {
      const sway = options.reducedMotion ? 0 : Math.sin(options.elapsed * 4.3 + seed(light.id)) * .7 * Math.min(1, light.flicker / .12);
      ctx.fillStyle = "#f18732"; ctx.beginPath(); ctx.moveTo(x - 2.3, y + .5);
      ctx.bezierCurveTo(x - 4, y - 3, x - .2 + sway, y - 4.8, x + sway, y - 8 * pulse);
      ctx.bezierCurveTo(x + 1.2, y - 4, x + 4, y - 2, x + 2.1, y + .6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#ffd680"; ctx.beginPath(); ctx.moveTo(x - 1.4, y + .3);
      ctx.quadraticCurveTo(x - 1.8, y - 2.6, x + sway * .4, y - 4.6 * pulse);
      ctx.quadraticCurveTo(x + 2.4, y - 1.4, x + 1.3, y + .3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff0c6"; ctx.beginPath(); ctx.ellipse(x, y - .6, .75, 1.6, 0, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = light.kind === "glow" ? light.color : "#fff0be";
      ctx.beginPath(); ctx.ellipse(x, y, light.kind === "glow" ? 1.35 : 1.25,
        light.kind === "glow" ? 1 : 2, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
}
