import { fishingSceneAtmosphere, type FishingSceneExclusion } from "./fishing-scene-atmosphere";
import { paintSceneFish } from "./fishing-scene-fish";
import type { FishingSceneFrame, FishingScenePoint, FishingSceneVisual } from "./fishing-scene-types";

type SchoolFrame = Pick<FishingSceneFrame, "stage" | "castKey" | "sceneKey" | "fishRarity" | "biteLeadSeconds" | "ambience">;
type SchoolGeometry = { fish: FishingScenePoint; hook: FishingScenePoint; waterTop: number; waterBottom: number;
  composition?: { floatX: number }; scale?: number; boat?: { x: number; scale: number } };
type SchoolVisual = Pick<FishingSceneVisual, "elapsed" | "stageElapsed" | "still">;
export type FishingSchoolShadow = { school: number; member: number; x: number; y: number; size: number; angle: number; tail: number; opacity: number };
export type FishingBiteApproach = { point: FishingScenePoint; opacity: number; progress: number };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const random = (value: number) => { const x = Math.sin(value * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
function sceneHash(key?: string) {
  let value = 2166136261;
  for (let index = 0; index < (key?.length ?? 0); index++) value = Math.imul(value ^ key!.charCodeAt(index), 16777619) >>> 0;
  return value % 65521;
}

/** A soft diving fade starts outside an obstacle. The whole silhouette has disappeared before contact. */
function visibility(point: FishingScenePoint, extent: number, exclusions: readonly FishingSceneExclusion[]) {
  let alpha = 1;
  for (const rect of exclusions) {
    const dx = Math.max(rect.x - extent - point.x, point.x - rect.x - rect.width - extent, 0);
    const dy = Math.max(rect.y - extent - point.y, point.y - rect.y - rect.height - extent, 0);
    alpha = Math.min(alpha, smooth(Math.hypot(dx, dy) / 45));
    if (alpha === 0) break;
  }
  return alpha;
}

type SchoolAnchor = { x: number; y: number; scale: number; key: number; school: number; count: number };
let anchorCache: { key: string; anchors: readonly SchoolAnchor[] } | undefined;
const overlaps = (a: FishingSceneExclusion, b: FishingSceneExclusion) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Fit a whole moving group into visible water. Hull/HUD envelopes can leave only narrow side channels. */
function schoolAnchors(width: number, height: number, hash: number, exclusions: readonly FishingSceneExclusion[]): readonly SchoolAnchor[] {
  const cacheKey = `${width}:${height}:${hash}:${exclusions.map(rect => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";")}`;
  if (anchorCache?.key === cacheKey) return anchorCache.anchors;
  const anchors: SchoolAnchor[] = [], occupied: FishingSceneExclusion[] = [];
  const candidates = [[.12, .60], [.87, .7], [.25, .84], [.75, .84], [.12, .32], [.88, .37], [.5, .7]];
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) candidates.push([(column + .5) / 8, (row + .5) / 8]);
  // Sample centers of actual gaps as well: a short phone may have only a thin strip below the hull.
  const xEdges = [...new Set([12, width - 12, ...exclusions.flatMap(rect => [rect.x, rect.x + rect.width])]
    .map(value => clamp(value, 12, width - 12)))].sort((a, b) => a - b);
  const yEdges = [...new Set([26, height - 26, ...exclusions.flatMap(rect => [rect.y, rect.y + rect.height])]
    .map(value => clamp(value, 26, height - 26)))].sort((a, b) => a - b);
  for (let row = 1; row < yEdges.length; row++) for (let column = 1; column < xEdges.length; column++)
    candidates.push([(xEdges[column - 1] + xEdges[column]) / (width * 2), (yEdges[row - 1] + yEdges[row]) / (height * 2)]);
  for (let school = 0; school < 3; school++) {
    let selected: SchoolAnchor | undefined;
    for (const scale of [1, .85, .7, .55, .5]) {
      const halfWidth = 90 * scale, halfHeight = 68 * scale;
      const edgeX = [halfWidth + 18, width - halfWidth - 18,
        ...exclusions.flatMap(rect => [rect.x - halfWidth - 7, rect.x + rect.width + halfWidth + 7])];
      const edgeY = [halfHeight + 32, height - halfHeight - 32,
        ...exclusions.flatMap(rect => [rect.y - halfHeight - 7, rect.y + rect.height + halfHeight + 7])];
      const fittedCandidates = [...candidates];
      for (const y of edgeY) for (const x of edgeX) fittedCandidates.push([x / width, y / height]);
      for (let attempt = 0; attempt < fittedCandidates.length; attempt++) {
        const index = (attempt + hash % fittedCandidates.length + school * 17) % fittedCandidates.length, candidate = fittedCandidates[index];
        const x = clamp(width * candidate[0], halfWidth + 12, width - halfWidth - 12);
        const y = clamp(height * candidate[1], halfHeight + 26, height - halfHeight - 26);
        const bounds = { x: x - halfWidth - 6, y: y - halfHeight - 6, width: halfWidth * 2 + 12, height: halfHeight * 2 + 12 };
        if (exclusions.some(rect => overlaps(bounds, rect)) || occupied.some(rect => overlaps(bounds, rect))) continue;
        const key = hash + school * 71;
        selected = { x, y, scale, key, school, count: 4 + Math.floor(random(key + 7) * 2) }; occupied.push(bounds); break;
      }
      if (selected) break;
    }
    if (selected) anchors.push(selected);
  }
  anchorCache = { key: cacheKey, anchors }; return anchors;
}

/** Separate cosmetic life: only the public voyage ID, civil time and current stage can affect it. */
export function fishingUnderwaterLife(width: number, height: number, frame: SchoolFrame, visual: SchoolVisual,
  geometry: SchoolGeometry, exclusions: readonly FishingSceneExclusion[] = [],
  approachExclusions: readonly FishingSceneExclusion[] = exclusions): { schools: FishingSchoolShadow[]; approach: FishingBiteApproach | null } {
  const schools: FishingSchoolShadow[] = [];
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) return { schools, approach: null };
  const top = Math.max(26, geometry.waterTop), bottom = Math.min(height - 30, geometry.waterBottom);
  if (!(bottom > top)) return { schools, approach: null };
  const time = visual.still || !Number.isFinite(visual.elapsed) ? 0 : Math.max(0, visual.elapsed);
  const mood = fishingSceneAtmosphere(frame.ambience), hash = sceneHash(frame.sceneKey);
  // Reserve the full future target path in a real scene, so progress cannot relocate a shoal during the fight.
  const castX = geometry.composition && geometry.scale ? geometry.composition.floatX / geometry.scale : geometry.hook.x;
  const landingX = geometry.boat ? geometry.boat.x + geometry.boat.scale * 975 + 18 : geometry.hook.x;
  const protectedWater = [...exclusions, { x: Math.min(castX, landingX) - 86, y: top - 60,
    width: Math.abs(castX - landingX) + 172, height: bottom - top + 120 }];
  // Decorative schools use all visible water, independently of the shallow vertical fight lane.
  for (const anchor of schoolAnchors(width, height, hash, protectedWater)) {
    const { key, school, count, scale } = anchor;
    const schoolOpacity = school === 2 ? mood.sunset * .8 + mood.dawn * .45 + mood.night * .15 : 1;
    const phase = random(key + 3) * Math.PI * 2, clock = time * (.085 + random(key + 5) * .025) + phase;
    const centerX = anchor.x + Math.sin(clock) * 24 * scale, centerY = anchor.y + Math.cos(clock) * 9 * scale;
    const angle = Math.atan2(-Math.sin(clock) * 9, Math.cos(clock) * 24);
    for (let member = 0; member < count; member++) {
      const stagger = member === 0 ? 0 : (member % 2 ? -1 : 1) * (11 + Math.floor((member + 1) / 2) * 7);
      const lag = 28 - Math.floor((member + 1) / 2) * 28;
      const sway = visual.still ? 0 : Math.sin(time * 1.4 + member * .7 + phase) * 2.6;
      // The loose staggered formation stays inside its fitted envelope even while the bodies turn together.
      const x = centerX + lag * scale, y = centerY + (stagger + sway) * scale;
      const size = (21 + random(key + member * 13 + 11) * 11) * scale;
      const opacity = (.105 + mood.daylight * .075 + mood.sunset * .08) * schoolOpacity * visibility({ x, y }, size * .82, protectedWater);
      if (opacity > .003) schools.push({ school, member, x, y, size, angle: angle + (visual.still ? 0 : Math.sin(time * 1.4 + member * .7) * .025),
        tail: visual.still ? 0 : Math.sin(time * 6.2 + member * .65 + phase) * .42, opacity });
    }
  }
  const lead = frame.biteLeadSeconds;
  if (frame.stage !== "soaking" || !frame.castKey || lead === undefined || !Number.isFinite(lead) || lead < 0 || lead > 4.8)
    return { schools, approach: null };
  const progress = smooth(1 - lead / 4.8), point = { ...geometry.fish };
  if (!visual.still) {
    const cast = sceneHash(frame.castKey), side = random(cast + 19) > .5 ? 1 : -1;
    const startX = clamp(point.x + side * 70, 40, width - 40), startY = clamp(point.y + 100 + random(cast + 23) * 38, top + 35, bottom - 35);
    point.x = mix(startX, geometry.fish.x, progress) + Math.sin(progress * Math.PI) * side * 12;
    point.y = mix(startY, geometry.fish.y, progress) + Math.sin(progress * Math.PI) * 12;
  }
  // The approach stays anonymous and stops at the exact public target at bite time. It is never painted in the bite/reel stages.
  const opacity = (visual.still ? .6 : smooth(progress * 4)) * visibility(point, 22, approachExclusions);
  return { schools, approach: opacity > .003 ? { point, opacity, progress } : null };
}

function paintSchoolShadow(ctx: CanvasRenderingContext2D, fish: FishingSchoolShadow) {
  ctx.save(); ctx.translate(fish.x, fish.y); ctx.rotate(fish.angle); ctx.scale(fish.size, fish.size); ctx.globalAlpha *= fish.opacity;
  ctx.fillStyle = "#123f50"; ctx.beginPath(); ctx.ellipse(0, 0, .52, .14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-.38, 0); ctx.lineTo(-.76, -.16 + fish.tail * .09); ctx.lineTo(-.65, fish.tail * .09); ctx.lineTo(-.76, .16 + fish.tail * .09); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(156,207,204,.18)"; ctx.beginPath(); ctx.ellipse(.06, -.035, .29, .025, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Paint behind controls and hull. Ambient schools avoid its padded envelope; the approach uses physical land/HUD only. */
export function paintFishingUnderwaterLife(ctx: CanvasRenderingContext2D, width: number, height: number, frame: FishingSceneFrame,
  visual: SchoolVisual, geometry: SchoolGeometry, exclusions: readonly FishingSceneExclusion[] = [],
  approachExclusions: readonly FishingSceneExclusion[] = exclusions) {
  const life = fishingUnderwaterLife(width, height, frame, visual, geometry, exclusions, approachExclusions);
  for (const fish of life.schools) paintSchoolShadow(ctx, fish);
  if (life.approach) {
    ctx.save(); ctx.globalAlpha *= life.approach.opacity;
    // Construct only public appearance fields; injected species/weight never enter the approach artwork.
    paintSceneFish(ctx, life.approach.point, { stage: "soaking", castKey: frame.castKey, fishRarity: frame.fishRarity,
      held: false, boat: { repaired: true, upgrades: [] } }, visual.still ? 0 : visual.elapsed, visual.still, visual.stageElapsed);
    ctx.restore();
  }
}
