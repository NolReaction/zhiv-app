import { fishingSceneAtmosphere, type FishingSceneAmbience, type FishingSceneExclusion } from "./fishing-scene-atmosphere";

export type FishingWaterEvent = Readonly<{
  kind: "feeding-jump" | "bubble-trail" | "sun-dart" | "drift-leaf";
  x: number; y: number; progress: number; opacity: number; size: number; scale: number;
  extentX: number; extentY: number; bounds: FishingSceneExclusion;
}>;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const random = (key: number) => { const value = Math.sin(key * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
const overlaps = (a: FishingSceneExclusion, b: FishingSceneExclusion) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const durations = { "feeding-jump": 4.6, "bubble-trail": 5.8, "sun-dart": 3.8, "drift-leaf": 5.4 } as const;
function voyageHash(sceneKey?: string) {
  let value = 2166136261;
  for (const character of sceneKey ?? "river") value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
}

type EventLayout = Pick<FishingWaterEvent, "kind" | "x" | "y" | "size" | "scale" | "extentX" | "extentY" | "bounds">;
let layoutCache: { key: string; value: EventLayout | null } | undefined;

/** Edges fit narrow channels that a uniform grid misses. The bounded list retains gap centers too. */
function axisCandidates(length: number, half: number, exclusions: readonly FishingSceneExclusion[], vertical: boolean) {
  const values = [half + 8, length - half - 8], edges = [0, length];
  for (const rect of exclusions) {
    const low = vertical ? rect.y : rect.x, high = low + (vertical ? rect.height : rect.width);
    values.push(low - half - 4.5, high + half + 4.5); edges.push(low, high);
  }
  const sorted = [...new Set(edges.map(value => clamp(value, 0, length)))].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index++) values.push((sorted[index - 1] + sorted[index]) / 2);
  return [...new Set(values.filter(value => value >= half + 4 && value <= length - half - 4))].slice(0, 20);
}

/** Layout is chosen once for a cycle, independently of the local animation progress. */
function eventLayout(width: number, height: number, hash: number, cycle: number, night: boolean,
  exclusions: readonly FishingSceneExclusion[]): EventLayout | null {
  const cacheKey = `${width}:${height}:${hash}:${cycle}:${night}:${exclusions.map(rect => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";")}`;
  if (layoutCache?.key === cacheKey) return layoutCache.value;
  const kinds = night ? ["bubble-trail", "drift-leaf", "feeding-jump"] as const
    : ["feeding-jump", "sun-dart", "bubble-trail", "drift-leaf"] as const;
  const preferred = kinds[(hash + cycle) % kinds.length];
  const choices = [...new Set([preferred, "bubble-trail", "drift-leaf"] as const)];
  const baseSize = clamp(width * .023, 28, 40);
  for (const kind of choices) for (const scale of [1, .8, .65, .5]) {
    const baseX = kind === "feeding-jump" ? clamp(width * .055, 68, 100) : kind === "bubble-trail" ? 40 : kind === "sun-dart" ? 68 : 56;
    const baseY = kind === "feeding-jump" ? clamp(baseSize * 1.1, 32, 48) : kind === "bubble-trail" ? 34 : kind === "sun-dart" ? 26 : 28;
    const extentX = baseX * scale, extentY = baseY * scale;
    if (width < extentX * 2 + 16 || height < extentY * 2 + 16) continue;
    const candidates: { x: number; y: number }[] = [];
    for (let attempt = 0; attempt < 24; attempt++) {
      const key = hash % 100003 + cycle * 173 + attempt * 29;
      candidates.push({ x: extentX + 8 + random(key + 3) * (width - extentX * 2 - 16),
        y: extentY + 8 + random(key + 11) * (height - extentY * 2 - 16) });
    }
    const xs = axisCandidates(width, extentX, exclusions, false), ys = axisCandidates(height, extentY, exclusions, true);
    for (const y of ys) for (const x of xs) candidates.push({ x, y });
    for (const { x, y } of candidates) {
      const bounds = { x: x - extentX - 4, y: y - extentY - 4, width: extentX * 2 + 8, height: extentY * 2 + 8 };
      if (exclusions.some(rect => overlaps(bounds, rect))) continue;
      const value = { kind, x, y, size: baseSize * scale, scale, extentX, extentY, bounds };
      layoutCache = { key: cacheKey, value }; return value;
    }
  }
  layoutCache = { key: cacheKey, value: null }; return null;
}

/** Nature follows a separate bounded presentation schedule. Events never signal a catch or alter fishing. */
export function fishingWaterEvents(width: number, height: number, elapsed: number, sceneKey?: string,
  ambience?: FishingSceneAmbience, exclusions: readonly FishingSceneExclusion[] = []): readonly FishingWaterEvent[] {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height + elapsed) || elapsed < 0) return [];
  const hash = voyageHash(sceneKey), first = 8 + hash % 5, period = 24 + (hash >>> 3) % 10;
  if (elapsed < first) return [];
  const age = elapsed - first, cycle = Math.floor(age / period), local = age - cycle * period;
  if (local >= 5.8 || width < 80 || height < 80) return [];
  const mood = fishingSceneAtmosphere(ambience);
  const layout = eventLayout(width, height, hash, cycle, mood.night > .6, exclusions);
  if (!layout) return [];
  const progress = local / durations[layout.kind];
  return progress >= 1 ? [] : [{ ...layout, progress, opacity: Math.sin(Math.PI * progress) ** .65 * (.64 + mood.daylight * .2) }];
}

function rings(ctx: CanvasRenderingContext2D, event: FishingWaterEvent, start = 0) {
  const age = clamp((event.progress - start) / (1 - start), 0, 1);
  if (!age) return;
  for (let index = 0; index < 3; index++) {
    const phase = age - index * .12;
    if (phase <= 0) continue;
    ctx.save(); ctx.globalAlpha *= Math.sin(Math.PI * Math.min(1, phase)) * .8;
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#c6ded1";
    ctx.beginPath(); ctx.ellipse(0, 4, 6 + phase * event.extentX * .75, 3 + phase * event.extentY * .3, -.08, .15, Math.PI * .94); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 4, 6 + phase * event.extentX * .75, 3 + phase * event.extentY * .3, -.08, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    ctx.restore();
  }
}

/** An anonymous wild silhouette, deliberately independent of every hooked fish class/species. */
function wildFish(ctx: CanvasRenderingContext2D, size: number, bright: boolean) {
  ctx.fillStyle = bright ? "#82b2b4" : "#436b79";
  ctx.beginPath(); ctx.ellipse(0, 0, size * .48, size * .14, -.02, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-size * .34, 0); ctx.lineTo(-size * .75, -size * .18); ctx.lineTo(-size * .63, 0); ctx.lineTo(-size * .75, size * .18); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = bright ? "#d0ded0" : "#92bdba"; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(-size * .22, -size * .025); ctx.quadraticCurveTo(size * .1, -size * .11, size * .32, -size * .02); ctx.stroke();
}

/** Paint behind the hull and controls; complete event paths already avoid every supplied obstacle. */
export function paintFishingWaterEvents(ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number,
  sceneKey?: string, ambience?: FishingSceneAmbience, exclusions: readonly FishingSceneExclusion[] = []) {
  for (const placed of fishingWaterEvents(width, height, elapsed, sceneKey, ambience, exclusions)) {
    // Every local offset scales together, including bubbles and glints, so a compact event stays in its footprint.
    const event = { ...placed, size: placed.size / placed.scale, extentX: placed.extentX / placed.scale, extentY: placed.extentY / placed.scale };
    ctx.save(); ctx.translate(event.x, event.y); ctx.scale(placed.scale, placed.scale); ctx.globalAlpha *= event.opacity; ctx.lineCap = "round";
    if (event.kind === "feeding-jump") {
      const leap = (event.progress - .12) / .46;
      if (leap >= 0 && leap <= 1) {
        ctx.save(); ctx.translate((leap - .5) * event.extentX * .85, -Math.sin(Math.PI * leap) * event.extentY * .54);
        ctx.rotate((leap - .5) * .95); wildFish(ctx, event.size, true); ctx.restore();
      }
      rings(ctx, event, .46);
    } else if (event.kind === "bubble-trail") {
      for (let index = 0; index < 5; index++) {
        const phase = (event.progress * 1.2 + index * .17) % 1;
        ctx.strokeStyle = "#b6d5ce"; ctx.lineWidth = 1.4;
        ctx.save(); ctx.globalAlpha *= Math.sin(Math.PI * phase);
        ctx.beginPath(); ctx.ellipse((index - 2) * 9 + Math.sin(phase * Math.PI * 2) * 4,
          event.extentY * (.42 - phase * .76) - index * 2, 2.5 + phase * 3, 1.8 + phase * 2, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      rings(ctx, event, .35);
    } else if (event.kind === "sun-dart") {
      ctx.save(); ctx.translate((event.progress - .5) * event.extentX * 1.1, Math.sin(event.progress * Math.PI) * event.extentY * .15);
      ctx.rotate(-.12); wildFish(ctx, event.size * .9, false); ctx.restore();
      ctx.strokeStyle = "rgba(225,224,173,.6)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-event.extentX * .48, 10); ctx.quadraticCurveTo(0, 15, event.extentX * .45, 8); ctx.stroke();
    } else {
      ctx.save(); ctx.translate((event.progress - .5) * event.extentX * .8, Math.sin(event.progress * Math.PI * 2) * event.extentY * .18);
      ctx.rotate(.25 + Math.sin(event.progress * Math.PI) * .35); ctx.fillStyle = "#a0ad6b";
      ctx.beginPath(); ctx.ellipse(0, 0, event.size * .48, event.size * .17, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#d4cc8c"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(-event.size * .4, 0); ctx.lineTo(event.size * .4, 0); ctx.stroke(); ctx.restore();
      rings(ctx, event, .1);
    }
    ctx.restore();
  }
}
