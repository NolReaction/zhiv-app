import { fishingBiteMotion } from "./fishing-scene-bite";
import { paintFishingCatchEffects } from "./fishing-scene-catch-effects";
import { paintFishingAtmosphere, paintFishingSceneTint } from "./fishing-scene-atmosphere";
import { drawFishingRod } from "@/features/world/activities/fishing/fishing-rod-painter";
import { BOAT_ASSEMBLY, boatArtworkLayers, type BoatArtLayer } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";
import { boatReelFeedback } from "../boat-reel-feedback";
import { FISHING_WATER_TEXTURE, paintFishingLandscape, paintFishingWake, paintFishingRipples, paintFishingHullContact } from "./fishing-scene-background";
import { fishingBoatActorRig, paintFishingBoatArms, paintFishingBoatBody, paintFishingBoatPaws } from "./fishing-scene-actor";
import { paintSceneFish } from "./fishing-scene-fish";
import { fishingBoatMotion, transformFishingBoatPoint, FISHING_BOAT_PIVOT } from "./fishing-scene-buoyancy";
import { FISHING_SCENE_RIG, type FishingSceneFrame, type FishingScenePoint, type FishingSceneViewport, type FishingSceneVisual } from "./fishing-scene-types";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
const unit = (value: number | undefined, fallback = 5000) => clamp(finite(value, fallback) / 10000, 0, 1);
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const pointMix = (from: FishingScenePoint, to: FishingScenePoint, amount: number) => ({ x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) });
const settledStages = new Set<FishingSceneFrame["stage"]>(["caught", "landed", "escaped", "expired"]);

/** Public controls alone determine these anchors. No species, weight or saved draw enters this scene. */
export function fishingSceneGeometry(width: number, height: number, frame: FishingSceneFrame, visual: FishingSceneVisual) {
  const cssWidth = Math.max(1, finite(width, 1600)), cssHeight = Math.max(1, finite(height, 900));
  const viewWidth = clamp(cssWidth / cssHeight * 900, 1000, 1800), scale = cssWidth / viewWidth, viewHeight = cssHeight / scale;
  const time = visual.still ? 0 : finite(visual.elapsed, 0);
  const motion = fishingBoatMotion(time, visual.still);
  const portrait = cssWidth < 700, shortLandscape = cssHeight < 500 && cssWidth > cssHeight;
  // Budget the largest active HUD, including feedback. A fractional height hid the low end on phones in landscape.
  const hud = shortLandscape ? 185 : portrait ? 280 : 260;
  const waterBottom = (cssHeight - hud - 24) / scale;
  const surface = shortLandscape ? waterBottom - 40 / scale
    : Math.min(viewHeight * FISHING_SCENE_RIG.boat.surfaceRatio, waterBottom - 56 / scale);
  const boatScale = clamp(viewWidth * .46, FISHING_SCENE_RIG.boat.minimumWidth, FISHING_SCENE_RIG.boat.maximumWidth)
    / BOAT_ASSEMBLY.width * (shortLandscape ? .65 : 1);
  const boat = { x: viewWidth * FISHING_SCENE_RIG.boat.marginRatio, y: surface - BOAT_ASSEMBLY.waterline * boatScale + motion.bob, scale: boatScale, roll: motion.roll };
  const onBoat = (point: FishingScenePoint) => transformFishingBoatPoint(point, boat);
  const castElapsed = visual.still || !frame.castKey ? FISHING_SCENE_RIG.cast.flightSeconds + 1 : Math.max(0, finite(visual.castElapsed, 0));
  const casting = frame.stage === "casting" && castElapsed < FISHING_SCENE_RIG.cast.flightSeconds;
  const actorRig = fishingBoatActorRig(frame.stage, castElapsed, frame.held, time, visual.still, visual.pose, visual.stageElapsed, frame.biteLeadSeconds);
  const grip = onBoat(actorRig.grip), reel = onBoat(actorRig.reel), tip = onBoat(actorRig.tip);
  // A backswing projects slightly into depth on low viewports rather than clipping its rod/float at the top edge.
  const tipLift = grip.y - tip.y, availableLift = Math.max(1, grip.y - 22 / scale);
  if (frame.stage === "casting" && tipLift > availableLift) {
    const projection = availableLift / tipLift;
    Object.assign(tip, pointMix(grip, tip, projection));
  }
  const tension = visual.pose ? .3 + visual.pose.effort * .85
    : frame.stage === "reeling" || frame.stage === "bite" ? .3 + actorRig.effort * .85 : .12;
  // Surface controls can sit alongside the boat on short screens; they are no longer an underwater cutaway below it.
  const waterTop = Math.max(0, Math.min(Math.max(68 / scale, Math.min(surface + 32 / scale, waterBottom - 96 / scale)), waterBottom - 8 / scale));
  const depthRange = Math.max(1, waterBottom - waterTop), progress = unit(frame.reel?.progress, 2500);
  const pull = ["caught", "landed"].includes(frame.stage) ? 1 : progress * .66;
  const hookX = mix(viewWidth * .76, boat.x + boat.scale * 920 + 40, pull);
  const hook = { x: hookX, y: waterTop + (1 - unit(frame.reel?.bar)) * depthRange };
  const fish = { x: hookX + 14 + (visual.still ? 0 : Math.sin(time * 2.3) * 12), y: waterTop + (1 - unit(frame.reel?.fish)) * depthRange };
  // The float itself occupies the controlled zone on the surface, not an unrelated fixed marker above a cutaway.
  const landing = { x: hook.x, y: hook.y };
  const flight = clamp((castElapsed - .24) / (FISHING_SCENE_RIG.cast.flightSeconds - .24), 0, 1);
  const float = pointMix(tip, landing, flight);
  const castHeadroom = Math.max(0, Math.min(tip.y, landing.y) - 22 / scale);
  float.y -= Math.sin(flight * Math.PI) * Math.min(140 * boat.scale, castHeadroom);
  if (frame.stage === "caught" || frame.stage === "landed") {
    const lift = visual.still || frame.stage === "landed" ? 1 : 1 - Math.pow(1 - clamp(visual.stageElapsed / 1.25, 0, 1), 3);
    Object.assign(fish, pointMix(fish, { x: boat.x + boat.scale * 975, y: surface - 74 * boat.scale }, lift));
    Object.assign(hook, fish);
  } else if (frame.stage === "escaped") {
    const escape = visual.still ? 1 : clamp(visual.stageElapsed / 1.2, 0, 1);
    fish.x += escape * 180; fish.y += escape * 55;
  }
  const zoneHeight = clamp(unit(frame.reel?.zoneWidth, 3200), .08, .8) * depthRange;
  // Clip the interval at the ends instead of shifting it: the painted band must match domain membership.
  const zoneTop = Math.max(waterTop, hook.y - zoneHeight / 2);
  const zone = { x: hook.x, y: zoneTop, height: Math.max(0, Math.min(waterBottom, hook.y + zoneHeight / 2) - zoneTop) };
  const aligned = Math.abs(unit(frame.reel?.fish) - unit(frame.reel?.bar)) <= unit(frame.reel?.zoneWidth, 3200) / 2;
  return { width: viewWidth, height: viewHeight, scale, surface, boat, onBoat, grip, reel, tip, float, landing, hook, fish, zone,
    waterTop, waterBottom, aligned, tension, casting, castElapsed, time, actorRig, actor: { foot: onBoat(FISHING_SCENE_RIG.actor.foot), size: FISHING_SCENE_RIG.actor.size * boat.scale } };
}

type Geometry = ReturnType<typeof fishingSceneGeometry>;

function paintPart(ctx: CanvasRenderingContext2D, layer: BoatArtLayer, images: ReadonlyMap<string, HTMLImageElement>) {
  const image = images.get(layer.src); if (!image) return;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, ...layer.crop, ...layer.box);
}

function paintBoat(ctx: CanvasRenderingContext2D, geometry: Geometry, frame: FishingSceneFrame, images: ReadonlyMap<string, HTMLImageElement>) {
  const layers = boatArtworkLayers({ repaired: frame.boat.repaired, upgrades: frame.boat.upgrades.filter(id => id === "oars" || id === "crate") });
  if (!images.has(layers[0].src)) return false;
  ctx.save(); ctx.translate(geometry.boat.x, geometry.boat.y); ctx.scale(geometry.boat.scale, geometry.boat.scale);
  ctx.translate(FISHING_BOAT_PIVOT.x, FISHING_BOAT_PIVOT.y); ctx.rotate(geometry.boat.roll); ctx.translate(-FISHING_BOAT_PIVOT.x, -FISHING_BOAT_PIVOT.y);
  layers.filter(layer => layer.id !== "oars").forEach(layer => paintPart(ctx, layer, images));
  paintFishingBoatArms(ctx, geometry.actorRig, frame.appearance, false);
  paintFishingBoatBody(ctx, geometry.actorRig, frame.appearance);
  paintFishingBoatArms(ctx, geometry.actorRig, frame.appearance, true);
  // Front planks cover the seated feet while preserving the original raster hull.
  ctx.save(); ctx.beginPath(); ctx.rect(0, BOAT_ASSEMBLY.foredeck, BOAT_ASSEMBLY.width, BOAT_ASSEMBLY.height); ctx.clip();
  paintPart(ctx, layers[0], images); ctx.restore();
  layers.filter(layer => layer.id === "oars").forEach(layer => paintPart(ctx, layer, images));
  paintFishingHullContact(ctx, geometry.time);
  ctx.restore(); return true;
}

function paintSurfaceGame(ctx: CanvasRenderingContext2D, geometry: Geometry, frame: FishingSceneFrame, visual: FishingSceneVisual) {
  if ((!frame.reel && frame.stage !== "landed") || !["bite", "reeling", "paused", "caught", "landed", "escaped", "pending"].includes(frame.stage)) return;
  const { hook, zone, fish } = geometry;
  if (frame.reel && !["caught", "landed", "escaped"].includes(frame.stage)) {
    const feedback = boatReelFeedback(frame.reel, frame.reel.zoneWidth);
    const color = feedback.mood === "steady" ? "158,235,157" : feedback.mood === "danger" ? "255,133,113" : "246,202,126";
    const halfWidth = Math.max(45, 20 / geometry.scale);
    const glow = ctx.createLinearGradient(zone.x - halfWidth, 0, zone.x + halfWidth, 0);
    glow.addColorStop(0, `rgba(${color},0)`); glow.addColorStop(.5, `rgba(${color},.4)`); glow.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = glow; ctx.fillRect(zone.x - halfWidth, zone.y, halfWidth * 2, zone.height);
    ctx.strokeStyle = `rgba(${color},.95)`; ctx.lineWidth = Math.max(2, 1.7 / geometry.scale);
    for (const y of [zone.y, zone.y + zone.height]) { ctx.beginPath(); ctx.moveTo(zone.x - halfWidth * .8, y); ctx.quadraticCurveTo(zone.x, y - 7, zone.x + halfWidth * .8, y); ctx.stroke(); }
  }
  ctx.save();
  if (frame.stage === "escaped") ctx.globalAlpha *= visual.still ? 0 : 1 - clamp(visual.stageElapsed / 1.2, 0, 1);
  paintSceneFish(ctx, fish, frame, geometry.time, visual.still, visual.stageElapsed); ctx.restore();
  paintFishingCatchEffects(ctx, fish, frame, visual.stageElapsed, visual.still);
  if (frame.stage === "reeling" || frame.stage === "paused") paintFishingRipples(ctx, fish, geometry.time * 1.25, geometry.aligned ? .9 : .5);
  if (geometry.actorRig.effort > .5 && !visual.still && (frame.stage === "reeling" || frame.stage === "paused")) {
    ctx.strokeStyle = "rgba(213,236,226,.45)"; ctx.lineWidth = 1.8;
    for (let i = 0; i < 3; i++) { const y = hook.y + ((geometry.time * 32 + i * 24) % 65); ctx.beginPath(); ctx.moveTo(hook.x - 11 - i * 4, y); ctx.quadraticCurveTo(hook.x, y + 5, hook.x + 11 + i * 4, y); ctx.stroke(); }
  }
}

export function paintFishingScene(ctx: CanvasRenderingContext2D, frame: FishingSceneFrame, images: ReadonlyMap<string, HTMLImageElement>, viewport: FishingSceneViewport, visual: FishingSceneVisual) {
  const geometry = fishingSceneGeometry(viewport.width, viewport.height, frame, visual), { width, height, time } = geometry;
  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0); ctx.clearRect(0, 0, viewport.width, viewport.height);
  ctx.save(); ctx.scale(geometry.scale, geometry.scale);
  paintFishingLandscape(ctx, width, height, time, images.get(FISHING_WATER_TEXTURE), frame.ambience);
  paintFishingAtmosphere(ctx, width, height, time, frame.ambience, [
    { x: geometry.boat.x - 30, y: geometry.boat.y, width: 1000 * geometry.boat.scale + 60, height: 650 * geometry.boat.scale + 30 },
    { x: geometry.float.x - 100, y: geometry.waterTop - 45, width: 200, height: geometry.waterBottom - geometry.waterTop + 90 },
  ]);
  paintSurfaceGame(ctx, geometry, frame, visual);
  paintFishingWake(ctx, { x: geometry.boat.x + geometry.boat.scale * 500, y: geometry.surface + 7 }, geometry.boat.scale * 970, time);
  const boatReady = paintBoat(ctx, geometry, frame, images);
  if (boatReady) {
    drawFishingRod(ctx, { grip: geometry.grip, tip: geometry.tip, reel: geometry.reel, size: FISHING_SCENE_RIG.rod.size * geometry.boat.scale,
      rodId: frame.rodId, tension: geometry.tension, side: 1, crank: time * 4 * geometry.actorRig.effort, detailScale: .68 });
    const caught = frame.stage === "caught" || frame.stage === "landed";
    const endpoint = caught ? geometry.hook : geometry.float;
    const effort = clamp(geometry.actorRig.effort, 0, 1);
    ctx.strokeStyle = `rgba(231,227,196,${.6 + effort * .18})`; ctx.lineWidth = Math.max(1.5 + effort * .5, 1 / geometry.scale);
    if (frame.castKey) {
      ctx.beginPath(); ctx.moveTo(geometry.tip.x, geometry.tip.y);
      ctx.quadraticCurveTo(mix(geometry.tip.x, endpoint.x, .55), mix(geometry.tip.y, endpoint.y, .52) + (34 - effort * 30), endpoint.x, endpoint.y); ctx.stroke();
    }
    if (frame.castKey && !settledStages.has(frame.stage)) {
      const float = geometry.float;
      const bite = fishingBiteMotion(frame.stage, visual.stageElapsed, frame.biteLeadSeconds, visual.still);
      const dipping = geometry.casting ? 0 : bite.dip;
      ctx.save(); ctx.translate(float.x, float.y + dipping); ctx.scale(Math.max(1, .8 / geometry.scale), Math.max(1, .8 / geometry.scale)); ctx.rotate(mix(Math.sin(time * 2) * .08, .13, effort) + bite.tilt);
      ctx.globalAlpha *= 1 - Math.min(.25, dipping / 48);
      ctx.fillStyle = "#d1bc79"; ctx.fillRect(-3, -17, 6, 17); ctx.fillStyle = "#b65f47"; ctx.fillRect(-3, -9, 6, 9);
      ctx.fillStyle = "#eee2b2"; ctx.beginPath(); ctx.ellipse(0, 2, 6, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      if (!geometry.casting) paintFishingRipples(ctx, geometry.landing, time, bite.ripple);
    }
    const splashAge = geometry.castElapsed - FISHING_SCENE_RIG.cast.flightSeconds;
    if (!visual.still && splashAge >= 0 && splashAge < FISHING_SCENE_RIG.cast.splashSeconds) {
      const p = splashAge / FISHING_SCENE_RIG.cast.splashSeconds; ctx.strokeStyle = `rgba(220,239,216,${1 - p})`; ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) { const x = geometry.landing.x + (i - 2) * 15 * p, y = geometry.landing.y - Math.sin(p * Math.PI) * (18 + i % 2 * 18); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (i - 2), y + 5); ctx.stroke(); }
    }
    // Paint the two compact paws after the shaft at the same hull-space pivots.
    ctx.save(); ctx.translate(geometry.boat.x, geometry.boat.y); ctx.scale(geometry.boat.scale, geometry.boat.scale);
    ctx.translate(FISHING_BOAT_PIVOT.x, FISHING_BOAT_PIVOT.y); ctx.rotate(geometry.boat.roll); ctx.translate(-FISHING_BOAT_PIVOT.x, -FISHING_BOAT_PIVOT.y);
    paintFishingBoatPaws(ctx, geometry.actorRig); ctx.restore();
  }
  paintFishingSceneTint(ctx, width, height, frame.ambience);
  ctx.restore();
}
