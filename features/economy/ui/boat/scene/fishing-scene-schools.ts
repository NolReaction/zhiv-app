import { fishingSceneAtmosphere, type FishingSceneExclusion } from "./fishing-scene-atmosphere";
import type { FishingSceneFrame, FishingScenePoint, FishingSceneVisual } from "./fishing-scene-types";

type SchoolFrame = Pick<FishingSceneFrame, "stage" | "castKey" | "sceneKey" | "biteLeadSeconds" | "ambience">;
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

type SchoolAnchor = { x: number; y: number; key: number; school: number; count: number;
  sizeLow: number; sizeHigh: number; gap: number; stagger: number; motionX: number; motionY: number };
let anchorCache: { key: string; anchors: readonly SchoolAnchor[] } | undefined;
const overlaps = (a: FishingSceneExclusion, b: FishingSceneExclusion) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Fit a whole moving group into visible water. Hull/HUD envelopes can leave only narrow side channels. */
function schoolAnchors(width: number, height: number, hash: number, pixelScale: number,
  exclusions: readonly FishingSceneExclusion[]): readonly SchoolAnchor[] {
  const cacheKey = `${width}:${height}:${hash}:${pixelScale}:${exclusions.map(rect => `${rect.x},${rect.y},${rect.width},${rect.height}`).join(";")}`;
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
  const portrait = width * pixelScale < 700;
  for (let school = 0; school < 3; school++) {
    let selected: SchoolAnchor | undefined;
    for (const scale of [1, .85, .7, .55, .45]) {
      // Body size has a CSS-pixel floor, independent of how tightly the group must fit a narrow channel.
      const minimum = portrait ? 6.5 : 11.25;
      const sizeLow = Math.max(minimum, (portrait ? 8.5 : 14) * scale) / pixelScale;
      const sizeHigh = Math.max(minimum, (portrait ? 12.5 : 19) * scale) / pixelScale;
      const gap = (portrait ? 13 : 18) * scale / pixelScale;
      const stagger = (portrait ? 6 : 8) * scale / pixelScale;
      const motionX = (portrait ? 28 : 42) * scale / pixelScale;
      const motionY = (portrait ? 6 : 10) * scale / pixelScale;
      const padding = 2.5 / pixelScale;
      const halfWidth = motionX + gap * 1.5 + sizeHigh * .82 + padding;
      const halfHeight = motionY + stagger + sizeHigh * .82 + padding;
      const edgeX = [halfWidth + 18, width - halfWidth - 18,
        ...exclusions.flatMap(rect => [rect.x - halfWidth - .5, rect.x + rect.width + halfWidth + .5])];
      const edgeY = [halfHeight + 32, height - halfHeight - 32,
        ...exclusions.flatMap(rect => [rect.y - halfHeight - .5, rect.y + rect.height + halfHeight + .5])];
      const fittedCandidates = [...candidates];
      for (const y of edgeY) for (const x of edgeX) fittedCandidates.push([x / width, y / height]);
      for (let attempt = 0; attempt < fittedCandidates.length; attempt++) {
        const index = (attempt + hash % fittedCandidates.length + school * 17) % fittedCandidates.length, candidate = fittedCandidates[index];
        const x = clamp(width * candidate[0], halfWidth + 12, width - halfWidth - 12);
        const y = clamp(height * candidate[1], halfHeight + 26, height - halfHeight - 26);
        const bounds = { x: x - halfWidth, y: y - halfHeight, width: halfWidth * 2, height: halfHeight * 2 };
        if (exclusions.some(rect => overlaps(bounds, rect)) || occupied.some(rect => overlaps(bounds, rect))) continue;
        const key = hash + school * 71;
        selected = { x, y, key, school, count: 4, sizeLow, sizeHigh, gap, stagger, motionX, motionY }; occupied.push(bounds); break;
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
  const pixelScale = Number.isFinite(geometry.scale) && geometry.scale! > 0 ? geometry.scale! : 1;
  const mood = fishingSceneAtmosphere(frame.ambience), hash = sceneHash(frame.sceneKey);
  // Reserve the full future target path in a real scene, so progress cannot relocate a shoal during the fight.
  const castX = geometry.composition && geometry.scale ? geometry.composition.floatX / geometry.scale : geometry.hook.x;
  const landingX = geometry.boat ? geometry.boat.x + geometry.boat.scale * 975 + 18 : geometry.hook.x;
  const protectedWater = [...exclusions, { x: Math.min(castX, landingX) - 86, y: top - 60,
    width: Math.abs(castX - landingX) + 172, height: bottom - top + 120 }];
  // Decorative schools use all visible water, independently of the shallow vertical fight lane.
  for (const anchor of schoolAnchors(width, height, hash, pixelScale, protectedWater)) {
    const { key, school, count } = anchor;
    const schoolOpacity = school === 2 ? mood.sunset * .85 + mood.dawn * .55 + mood.night * .45 : 1;
    const phase = random(key + 3) * Math.PI * 2, clock = time * (.27 + random(key + 5) * .065) + phase;
    const centerX = anchor.x + Math.sin(clock) * anchor.motionX, centerY = anchor.y + Math.cos(clock) * anchor.motionY;
    const angle = Math.atan2(-Math.sin(clock) * anchor.motionY, Math.cos(clock) * anchor.motionX);
    for (let member = 0; member < count; member++) {
      const stagger = (member % 2 ? -1 : 1) * anchor.stagger;
      const lag = (member - 1.5) * anchor.gap;
      const sway = visual.still ? 0 : Math.sin(time * 1.8 + member * .7 + phase) * anchor.stagger * .12;
      // The loose staggered formation stays inside its fitted envelope even while the bodies turn together.
      const x = centerX + lag, y = centerY + stagger + sway;
      const size = mix(anchor.sizeLow, anchor.sizeHigh, random(key + member * 13 + 11));
      const clearance = visibility({ x, y }, size * .82, protectedWater);
      // The complete fitted path already avoids land: keep a readable underwater silhouette even in a narrow safe channel.
      const opacity = (.32 + mood.daylight * .15 + mood.sunset * .1) * schoolOpacity * (clearance > 0 ? .72 + clearance * .28 : 0);
      if (opacity > .003) schools.push({ school, member, x, y, size, angle: angle + (visual.still ? 0 : Math.sin(time * 1.4 + member * .7) * .025),
        tail: visual.still ? 0 : Math.sin(time * 6.2 + member * .65 + phase) * .42, opacity });
    }
  }
  const lead = frame.biteLeadSeconds;
  if (frame.stage === "bite" && frame.castKey && !visual.still && visual.stageElapsed >= 0 && visual.stageElapsed < .45) {
    const depth = smooth(visual.stageElapsed / .45);
    const point = { x: geometry.fish.x, y: geometry.fish.y + depth * 22 / pixelScale };
    const opacity = (1 - depth) * visibility(point, 13 / pixelScale, approachExclusions);
    return { schools, approach: opacity > .003 ? { point, opacity, progress: 1 } : null };
  }
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
  ctx.fillStyle = "#204b56"; ctx.strokeStyle = "rgba(168,205,177,.62)"; ctx.lineWidth = .04;
  ctx.beginPath(); ctx.ellipse(0, 0, .52, .14, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-.38, 0); ctx.lineTo(-.76, -.16 + fish.tail * .09); ctx.lineTo(-.65, fish.tail * .09); ctx.lineTo(-.76, .16 + fish.tail * .09); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(191,214,174,.58)"; ctx.beginPath(); ctx.ellipse(.06, -.035, .29, .028, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Paint behind controls and hull. Ambient schools avoid its padded envelope; the approach uses physical land/HUD only. */
export function paintFishingUnderwaterLife(ctx: CanvasRenderingContext2D, width: number, height: number, frame: FishingSceneFrame,
  visual: SchoolVisual, geometry: SchoolGeometry, exclusions: readonly FishingSceneExclusion[] = [],
  approachExclusions: readonly FishingSceneExclusion[] = exclusions) {
  const life = fishingUnderwaterLife(width, height, frame, visual, geometry, exclusions, approachExclusions);
  for (const fish of life.schools) paintSchoolShadow(ctx, fish);
  if (life.approach) {
    const pixelScale = Number.isFinite(geometry.scale) && geometry.scale! > 0 ? geometry.scale! : 1;
    // Only a quiet anonymous underwater shadow approaches; class/species artwork is reserved for the confirmed catch.
    paintSchoolShadow(ctx, { school: -1, member: 0, ...life.approach.point, size: 13 / pixelScale,
      angle: -.09, tail: visual.still ? 0 : Math.sin(visual.elapsed * 6) * .3, opacity: life.approach.opacity * .4 });
  }
}
