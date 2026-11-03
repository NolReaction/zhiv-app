import { fishingBiteMotion } from "./fishing-scene-bite";
import { fishingBobberMotion } from "./fishing-scene-bobber";
import { paintFishingWaterEvents } from "./fishing-scene-water-events";
import { paintFishingCatchEffects } from "./fishing-scene-catch-effects";
import { paintFishingAtmosphere, paintFishingSceneTint, type FishingSceneExclusion } from "./fishing-scene-atmosphere";
import { fishingIslandLayout, paintFishingIslands } from "./fishing-scene-islands";
import { paintFishingUnderwaterLife } from "./fishing-scene-schools";
import { drawFishingRod } from "@/features/world/activities/fishing/fishing-rod-painter";
import { BOAT_ASSEMBLY, boatArtworkLayers, type BoatArtLayer } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";
import { FISHING_WATER_TEXTURE, paintFishingLandscape, paintFishingBoatDisplacement, paintFishingRipples, paintFishingHullContact } from "./fishing-scene-background";
import { fishingBoatActorRig, paintFishingBoatArms, paintFishingBoatBody, paintFishingBoatPaws } from "./fishing-scene-actor";
import { paintSceneFish } from "./fishing-scene-fish";
import { fishingBoatMotion, transformFishingBoatPoint, FISHING_BOAT_PIVOT } from "./fishing-scene-buoyancy";
import { fishingSceneComposition } from "./fishing-scene-composition";
import { FISHING_SCENE_RIG, type FishingSceneFrame, type FishingScenePoint, type FishingSceneViewport, type FishingSceneVisual } from "./fishing-scene-types";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
const unit = (value: number | undefined, fallback = 5000) => clamp(finite(value, fallback) / 10000, 0, 1);
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const pointMix = (from: FishingScenePoint, to: FishingScenePoint, amount: number) => ({ x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) });
const settledStages = new Set<FishingSceneFrame["stage"]>(["landed", "escaped", "expired"]);

/** Public controls alone determine these anchors. No species, weight or saved draw enters this scene. */
export function fishingSceneGeometry(width: number, height: number, frame: FishingSceneFrame, visual: FishingSceneVisual) {
  const cssWidth = Math.max(1, finite(width, 1600)), cssHeight = Math.max(1, finite(height, 900));
  const viewWidth = clamp(cssWidth / cssHeight * 900, 1000, 1800), scale = cssWidth / viewWidth, viewHeight = cssHeight / scale;
  const time = visual.still ? 0 : finite(visual.elapsed, 0);
  const motion = fishingBoatMotion(time, visual.still);
  const composition = fishingSceneComposition(cssWidth, cssHeight, frame.sceneKey);
  const waterTop = composition.waterTop / scale, waterBottom = composition.waterBottom / scale;
  const surface = composition.surface / scale, boatScale = composition.boatWidth / scale / BOAT_ASSEMBLY.width;
  const boat = { x: composition.boatX / scale, y: surface - BOAT_ASSEMBLY.waterline * boatScale + motion.bob,
    scale: boatScale, roll: motion.roll + composition.variant.roll };
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
  const bobber = fishingBobberMotion(frame, time, visual.still);
  const tension = (visual.pose ? .3 + visual.pose.effort * .85
    : frame.stage === "reeling" || frame.stage === "bite" ? .3 + actorRig.effort * .85 : .12) + bobber.tension;
  const depthRange = Math.max(1, waterBottom - waterTop), progress = unit(frame.reel?.progress, 2500);
  const pull = ["caught", "landed"].includes(frame.stage) ? 1 : progress * .66;
  const hookX = mix(composition.floatX / scale, boat.x + boat.scale * 975 + 18, pull);
  // The float stays on the water. The exact green control zone is now drawn in the dedicated fishing meter.
  const landing = { x: hookX + bobber.x / scale,
    y: clamp(waterTop + depthRange * .53 + bobber.y / scale, waterTop + 10 / scale, waterBottom - 10 / scale) };
  const bite = fishingBiteMotion(frame.stage, visual.stageElapsed, frame.biteLeadSeconds, visual.still);
  const dip = casting ? 0 : bite.dip + bobber.dip;
  const hook = { x: landing.x, y: landing.y + dip / scale };
  const fish = { x: landing.x + 7 / scale, y: landing.y + 9 / scale };
  const flight = clamp((castElapsed - .24) / (FISHING_SCENE_RIG.cast.flightSeconds - .24), 0, 1);
  const float = pointMix(tip, hook, flight);
  const castHeadroom = Math.max(0, Math.min(tip.y, hook.y) - 22 / scale);
  float.y -= Math.sin(flight * Math.PI) * Math.min(140 * boat.scale, castHeadroom);
  if (frame.stage === "landed" && frame.fishId) {
    const lift = visual.still ? 1 : 1 - Math.pow(1 - clamp(visual.stageElapsed / 1.25, 0, 1), 3);
    Object.assign(fish, pointMix(fish, { x: boat.x + boat.scale * 975, y: surface - 74 * boat.scale }, lift));
    Object.assign(hook, fish);
  }
  return { width: viewWidth, height: viewHeight, scale, surface, boat, onBoat, grip, reel, tip, float, landing, hook, fish,
    waterTop, waterBottom, tension, casting, castElapsed, time, composition, actorRig, bobber, actor: { foot: onBoat(FISHING_SCENE_RIG.actor.foot), size: FISHING_SCENE_RIG.actor.size * boat.scale } };
}

type Geometry = ReturnType<typeof fishingSceneGeometry>;

/** Stable envelopes keep land away from every animated hull pose, controls and the full fight corridor. */
export function fishingSceneSceneryExclusions(geometry: Geometry) {
  const { composition, scale, boat, width, height } = geometry;
  const surface = composition.surface / scale;
  const hullY = surface - BOAT_ASSEMBLY.waterline * boat.scale;
  const boatBounds: FishingSceneExclusion = { x: boat.x - 42, y: hullY - 40,
    width: BOAT_ASSEMBLY.width * boat.scale + 84, height: BOAT_ASSEMBLY.height * boat.scale + 80 };
  const hud: FishingSceneExclusion[] = [
    { x: 0, y: 0, width, height: composition.safeTop / scale },
    { x: 0, y: composition.availableBottom / scale, width, height: Math.max(0, height - composition.availableBottom / scale) },
  ];
  const targetX = composition.floatX / scale, landingX = boat.x + boat.scale * 975 + 18;
  const play: FishingSceneExclusion = { x: Math.min(targetX, landingX) - 100, y: geometry.waterTop - 50,
    width: Math.abs(targetX - landingX) + 200, height: geometry.waterBottom - geometry.waterTop + 100 };
  const dockWidth = Math.min(width, 548 / scale);
  const lifeHud = [hud[0], { ...hud[1], x: (width - dockWidth) / 2, width: dockWidth }];
  return { boat: boatBounds, hud, play, islands: [boatBounds, ...hud, play], life: [boatBounds, ...lifeHud] };
}

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

/** Species and full fish artwork appear only after the server has added a confirmed catch. */
function paintFishingLanding(ctx: CanvasRenderingContext2D, geometry: Geometry, frame: FishingSceneFrame, visual: FishingSceneVisual) {
  if (frame.stage !== "landed" || !frame.fishId) return;
  paintSceneFish(ctx, geometry.fish, frame, geometry.time, visual.still, visual.stageElapsed);
  paintFishingCatchEffects(ctx, geometry.fish, frame, visual.stageElapsed, visual.still);
}

export function paintFishingScene(ctx: CanvasRenderingContext2D, frame: FishingSceneFrame, images: ReadonlyMap<string, HTMLImageElement>, viewport: FishingSceneViewport, visual: FishingSceneVisual) {
  const geometry = fishingSceneGeometry(viewport.width, viewport.height, frame, visual), { width, height, time } = geometry;
  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0); ctx.clearRect(0, 0, viewport.width, viewport.height);
  // Water texels stay at one CSS pixel on portrait too; the assembly view must not shrink the surface texture.
  paintFishingLandscape(ctx, viewport.width, viewport.height, time + geometry.composition.variant.currentPhase, images.get(FISHING_WATER_TEXTURE), frame.ambience);
  ctx.save(); ctx.scale(geometry.scale, geometry.scale);
  const exclusions = fishingSceneSceneryExclusions(geometry);
  const islands = fishingIslandLayout(width, height, frame.sceneKey, exclusions.islands);
  paintFishingIslands(ctx, width, height, time, frame.sceneKey, frame.ambience, exclusions.islands);
  // The real hull painted above the approach supplies physical occlusion; the wider land-placement box must not hide a bite.
  paintFishingUnderwaterLife(ctx, width, height, frame, visual, geometry, [...exclusions.life, ...islands], [...exclusions.hud, ...islands]);
  paintFishingAtmosphere(ctx, width, height, time, frame.ambience, [
    ...exclusions.islands, ...islands,
  ]);
  paintFishingWaterEvents(ctx, width, height, time, frame.sceneKey, frame.ambience, [...exclusions.life, exclusions.play, ...islands]);
  paintFishingLanding(ctx, geometry, frame, visual);
  paintFishingBoatDisplacement(ctx, geometry.boat, time, visual.still);
  const boatReady = paintBoat(ctx, geometry, frame, images);
  if (boatReady) {
    drawFishingRod(ctx, { grip: geometry.grip, tip: geometry.tip, reel: geometry.reel, size: FISHING_SCENE_RIG.rod.size * geometry.boat.scale,
      rodId: frame.rodId, tension: geometry.tension, side: 1, crank: time * 4 * geometry.actorRig.effort, detailScale: .68 });
    const caught = frame.stage === "landed" && Boolean(frame.fishId);
    const endpoint = caught ? geometry.hook : geometry.float;
    const effort = clamp(geometry.actorRig.effort, 0, 1);
    ctx.strokeStyle = `rgba(231,227,196,${.6 + effort * .18})`; ctx.lineWidth = Math.max(1.5 + effort * .5, 1 / geometry.scale);
    if (frame.castKey || caught && frame.catchKey) {
      ctx.beginPath(); ctx.moveTo(geometry.tip.x, geometry.tip.y);
      ctx.quadraticCurveTo(mix(geometry.tip.x, endpoint.x, .55), mix(geometry.tip.y, endpoint.y, .52) + (34 - effort * 30), endpoint.x, endpoint.y); ctx.stroke();
    }
    if (frame.castKey && !settledStages.has(frame.stage)) {
      const float = geometry.float;
      const bite = fishingBiteMotion(frame.stage, visual.stageElapsed, frame.biteLeadSeconds, visual.still);
      const dipping = geometry.casting ? 0 : bite.dip + geometry.bobber.dip;
      ctx.save(); ctx.translate(float.x, float.y); ctx.scale(Math.max(1, 1 / geometry.scale), Math.max(1, 1 / geometry.scale)); ctx.rotate(geometry.bobber.tilt + bite.tilt);
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
