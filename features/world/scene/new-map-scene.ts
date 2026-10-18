import { loadHabitatImage } from "@/features/mochlik/assets";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { HabitatScene, SceneCallbacks, SceneOptions } from "@/features/mochlik/scene";
import { NEW_MAP_FOCUS, NEW_MAP_PET_SIZE as PET_SIZE, NEW_MAP_SPAWN, TILED_WORLD } from "./presentation";
import { paintFixedWorld } from "@/features/world/tiled/renderer";
import { initialPreviewLevels, previewSiteVisual, previewWorldScene } from "@/features/world/tiled/preview-state";
import type { FixedWorldScene, PreviewLevels, SiteVisual, WorldPoint } from "@/features/world/tiled/types";
import { drawGroundedHero } from "./grounding";
import { drawBuildingDetails } from "./building-details";
import { worldFrameDue } from "./frame-timing";
import { drawForestAtmosphere, forestAtmosphereState, FOREST_BIRD_FLIGHT_DURATION, type ForestAtmosphereOptions } from "@/features/world/environment/weather/forest-atmosphere";
import { drawForestWater, forestWaterContactsFrame, isForestWater } from "@/features/world/environment/water/forest-water";
import { createForestWaterDynamics, advanceForestWaterDynamics, disturbForestWater, touchForestWater, type ForestWaterDynamics } from "@/features/world/environment/water/forest-water-dynamics";
import { drawForestWaterDynamics } from "@/features/world/environment/water/forest-water-dynamics-painter";
import { drawForestWaterRefraction } from "@/features/world/environment/water/forest-water-refraction";
import { createForestWaterInteractionTracker } from "@/features/world/environment/water/forest-water-interactions";
import { withForestWaterBuoyancy } from "@/features/world/environment/water/forest-water-buoyancy";
import { forestWaterWind } from "@/features/world/environment/water/forest-water-surface";
import { createForestTreeInteractions, hitForestTree, touchForestTree, advanceForestTreeInteractions, clearForestTreeInteractions,
  type ForestTreeInteractions } from "@/features/world/environment/trees/forest-tree-interactions";
import { drawForestTreeCrownMotion, drawForestTreeLeaves } from "@/features/world/environment/trees/forest-tree-interactions-painter";
import { drawForestGroundWeather, updateForestWetness } from "@/features/world/environment/weather/forest-ground-weather";
import { drawForestGroundImpacts } from "@/features/world/environment/weather/forest-ground-impacts";
import { drawForestLighting, drawForestLightEmitters, drawForestLighthouseBeams, forestLightSources } from "@/features/world/environment/lighting/forest-lighting";
import { worldLightingEditorStore } from "@/features/world/dev/world-lighting-editor-store";
import { createForestShadowFrame, drawForestTestLamp, forestShadowLightHeight } from "@/features/world/environment/lighting/forest-shadow-scene";
import { drawForestDirectionalShadows, drawForestOccludedLighting, drawForestShadowDebug } from "@/features/world/environment/lighting/forest-shadow-painter";
import { forestLifeFrame, type ForestLifeState } from "@/features/world/simulation/forest-life";
import { drawForestLifePartner, drawForestMushrooms } from "@/features/world/simulation/forest-life-painter";
import { drawForestBush, forestBushForegroundActive } from "@/features/world/activities/garden/forest-bush-painter";
import { forestBushArtworkAvailable } from "@/features/world/activities/garden/forest-bush-artwork";
import { drawForestGardenBasket, drawForestGardenPlants, drawForestGardenProps, forestGardenGroundBasket, forestGardenVisualFrame } from "@/features/world/activities/garden/forest-garden-painter";
import { drawWaterDebug } from "@/features/world/dev/water-debug";
import { clearingActivityFrame, clearingNavigationFrame, noticeClearingActivity } from "@/features/world/simulation/clearing-activity";
import { advanceForestDirector, cancelForestDirector, noticeForestDirector, requestForestDirective, requestForestGardenHarvest, requestForestTradeVisit, forestTradeVisitFrame, type ForestDirectorOptions } from "@/features/world/simulation/forest-director";
import { syncForestGardenProduction } from "@/features/world/activities/garden/forest-garden";
import { faunaInteractionFrame, faunaRenderFrame, residentFaunaEncounter, reconcileResidentFaunaEncounters,
  type ForestFaunaState } from "@/features/world/environment/wildlife/forest-fauna";
import { pleskWildlifeHand } from "@/features/world/characters/plesk/plesk-painter";
import { campfireVisitFrame, type CampfireVisit } from "@/features/world/activities/campfire/forest-campfire";
import { drawForestCampfires, drawForestCampfireGlow } from "@/features/world/activities/campfire/forest-campfire-painter";
import { forestBirdFrame } from "@/features/world/environment/wildlife/forest-birds";
import { forestBirdwatchFrame, type ForestBirdwatch } from "@/features/world/activities/forest-birdwatching";
import { advanceBirdReactions, applyBirdReactions } from "@/features/world/environment/wildlife/forest-bird-reactions";
import { drawForestBird, drawForestButterfly, drawForestFirefly, type ForestBird } from "@/features/world/environment/wildlife/forest-wildlife";
import { faunaBehindHero } from "@/features/world/environment/wildlife/forest-fauna-depth";
import { drawForestResidents, forestResidentAt, forestResidentFrames } from "@/features/world/characters/forest-residents";
import { forestPointOccluded, forestVisibleSiteAt, withForestOcclusion } from "./forest-occlusion";
import { drawLivingWorldDebug, type LivingWorldDebugSnapshot } from "@/features/world/dev/living-world-debug";
import { connectForestSession } from "@/features/world/state/forest-session";
import { publishForestObservation } from "@/features/world/state/forest-observer";
import { forestSceneFingerprint } from "@/features/world/state/memory/forest-memory";
import { applyForestDevScenario } from "@/features/world/dev/forest-dev-scenarios";
import { syncForestSceneRehearsal, advanceForestSceneRehearsal } from "@/features/world/dev/forest-scene-rehearsal";
import { forestPersistenceOverridden } from "@/features/world/dev/forest-dev-memory";
import { WORLD_DEV_ENABLED, worldDevStore, type WorldDevState, type WorldDevLifeAction } from "@/features/world/dev/world-dev-store";
import { accountSceneLevels, economyJourneyAway, type EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import { interactiveMapObjects } from "./site-interactions";
import { forestJourneyActorAway, forestJourneyEnding, forestJourneyFishingFrame, forestJourneyWalking, syncForestJourneyTravel } from "@/features/world/activities/journeys/forest-journey-travel";
import { forestJourneyGatheringFrame } from "@/features/world/activities/journeys/forest-supply-journey";
import type { ForestGatheringFrame } from "@/features/world/activities/journeys/forest-gathering";
import { drawForestGatheringBasket, drawForestGatheringHero, forestGatheringBounds } from "@/features/world/activities/journeys/forest-gathering-painter";

import { advancePleskMind, rehydratePleskMind, pleskMindFrame, noticePleskMind, requestPleskTrade, pleskAvailableForLeisure,
  pleskCanPausePassing, pleskCanReceiveVisit, requestPleskSocialVisit, cancelPleskSocialVisit } from "@/features/world/characters/plesk/plesk-mind";
import { advanceBuilderMind, builderMindFrame, builderSleepIndicator, noticeBuilderMind,
  requestBuilderVisit, cancelBuilderVisit } from "@/features/world/characters/builder/builder-mind";
import { syncForestConstruction } from "@/features/world/state/economy/economy-construction-state";
import { previewForestResidents } from "@/features/world/dev/forest-resident-preview";
import { builderPreviewActive, previewForestBuilder } from "@/features/world/dev/forest-builder-preview";
import { drawForestFishingHero } from "@/features/world/activities/fishing/forest-fishing-painter";
import type { ForestFishingFrame } from "@/features/world/activities/fishing/forest-fishing";
import { fishingPropsBounds } from "@/features/world/activities/fishing/fishing-props";
import { forestCookingBounds, type ForestCookingFrame } from "@/features/world/activities/cooking/forest-cooking";
import { drawForestCookingHero, drawForestProductionCooking } from "@/features/world/activities/cooking/forest-cooking-painter";
import { forestProductionFrames, forestProductionJourney, syncForestProduction, type ForestProductionFrame } from "@/features/world/state/economy/economy-production-state";
import { drawForestProductionStation } from "./forest-production-painter";
import { startCookingPreview, advanceCookingPreview, cookingPreviewFrame, noticeCookingPreview } from "@/features/world/dev/forest-cooking-preview";
import { forestTrailDestination } from "@/features/world/navigation/forest-trails";
import { forestJourneyMiningFrame, type ForestMiningFrame } from "@/features/world/activities/mining/forest-mining";
import { drawForestMiningHero, drawForestMiningWork } from "@/features/world/activities/mining/forest-mining-painter";
import { advanceForestSocial, cancelForestSocial, noticeForestSocial, forestSocialFrames, forestSocialHolding, forestSocialPartner, forestSocialWaitingHost, forestSocialFollowupHolding,
  type ForestSocialEnvironment, type ForestSocialActor, type ForestSpeaker } from "@/features/world/characters/social/forest-social";
import { drawForestSpeech, type ForestSpeechCanvasFrame } from "@/features/world/characters/social/forest-speech-painter";
import { loadForestSpeechFont } from "@/features/world/characters/social/forest-speech-font";
import { builderDirection } from "@/features/world/characters/builder/builder-navigation";
import { forestResidentOccupants } from "@/features/world/characters/forest-resident-occupancy";
import { forestLeaftailWindow } from "@/features/world/characters/social/forest-leaftail-window";
import { createForestVillagers, rehydrateForestVillagers, configureForestVillagers, advanceForestVillagers, forestVillagerFrames,
  noticeForestVillager, requestForestVillagerVisit, cancelForestVillagerVisit, settleForestVillagerArrival,
  forestVillagerAvailableForLeisure } from "@/features/world/characters/villagers/villager-mind";
import { advanceVillagerWildlife, createVillagerWildlife, forestVillagerFaunaVisitors, reconcileVillagerWildlife,
  villagerWildlifeAvailable, villagerWildlifeFrame, villagerWildlifeHolds, villagerBirdwatchEvent } from "@/features/world/characters/villagers/villager-wildlife";
import { syncForestResidentAccess } from "@/features/world/state/economy/economy-residents-state";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { audioDevStore } from "@/features/audio/dev/audio-dev-store";
import { createWorldAudioController } from "@/features/world/audio/world-audio-controller";
import { quarryAudioWorking, type WorldAudioCamera } from "@/features/world/audio/world-audio-frame";
import { drawWorldAudioDebug } from "@/features/world/audio/world-audio-debug";
import { worldArtworkUrls } from "./world-artwork";
import { drawResidentHomeIndicator } from "@/features/world/characters/resident-home-effects";
import { drawLopukhWoodpile } from "@/features/world/characters/lopukh/lopukh-woodpile-painter";
import { leaftailBoatArrivalFrame, leaftailBoatArrivalOccupant } from "@/features/world/characters/leaftail/leaftail-boat-arrival";
import { drawLeaftailBoatArrival } from "@/features/world/characters/leaftail/leaftail-boat-painter";
import { residentDiagnosticsStore } from "@/features/world/dev/forest-resident-diagnostics";
import { forestPerformanceProfiler } from "@/features/world/dev/forest-performance-profiler";
import { residentScenePresentation } from "./resident-scene-presentation";
import { residentSceneSocialContext, residentSceneFollowups } from "./resident-scene-social";
import { syncSceneMerchantArrival, advanceSceneMerchantArrival, announceSceneMerchantArrival } from "./resident-scene-arrival";


const REACTION_SECONDS = .9;
const waterInteractionTrackers = new WeakMap<ForestWaterDynamics, ReturnType<typeof createForestWaterInteractionTracker>>();
const waterGeometrySources = new WeakMap<ForestWaterDynamics, FixedWorldScene["water"]>();
const levels = initialPreviewLevels(TILED_WORLD);
const visualsFor = (next: PreviewLevels) => Object.fromEntries(TILED_WORLD.sites.map(site => [site.id, previewSiteVisual(site, next)]));

function pointInPolygon(point: WorldPoint, polygon: WorldPoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Quiet, font-independent sleep cue anchored to the authored doorway. */
function drawHomeSleep(ctx: CanvasRenderingContext2D, door: WorldPoint, elapsed: number, still: boolean) {
  ctx.save(); ctx.fillStyle = "#ecdba7";
  const alpha = ctx.globalAlpha;
  for (let index = 0; index < 2; index++) {
    const phase = still ? .35 + index * .25 : (elapsed * .24 + index * .5) % 1;
    const unit = 1 + index * .3, x = door.x - 4 + index * 5, y = door.y - 23 - phase * 9;
    ctx.globalAlpha = alpha * (still ? .7 : Math.sin(phase * Math.PI) * .8);
    ctx.fillRect(x, y, 4 * unit, unit);
    for (let row = 1; row < 4; row++) ctx.fillRect(x + (3 - row) * unit, y + row * unit, unit, unit);
    ctx.fillRect(x, y + 4 * unit, 4 * unit, unit);
  }
  ctx.restore();
}

type ManualAnimation = { pose: PixelPose; elapsed: number };
function gatheringAtSize(frame: ForestGatheringFrame | null | undefined, size: number): ForestGatheringFrame | null {
  if (!frame) return null;
  const scale = size / frame.size;
  return { ...frame, size, basket: { x: frame.x + (frame.basket.x - frame.x) * scale,
    y: frame.y + (frame.basket.y - frame.y) * scale, size: frame.basket.size * scale } };
}
export type NewMapPaintPreview = {
  scene?: FixedWorldScene;
  water?: ForestWaterDynamics;
  trees?: ForestTreeInteractions;
  state?: WorldDevState;
  visuals?: Record<string, SiteVisual>;
  animation?: ManualAnimation | null;
  birdElapsed?: number;
  birdSeed?: number;
  life?: ForestLifeState;
  clearing?: ReturnType<typeof clearingActivityFrame>;
  wetness?: number;
  fauna?: ForestFaunaState;
  birdFrame?: ForestBird[];
  birdwatch?: ForestBirdwatch | null;
  campfireVisit?: CampfireVisit | null;
  tradeVisit?: ReturnType<typeof forestTradeVisitFrame>;
  livingDebug?: LivingWorldDebugSnapshot;
  actorAway?: boolean;
  fishing?: ForestFishingFrame | null;
  mining?: ForestMiningFrame | null;
  cooking?: ForestCookingFrame | null;
  gathering?: ForestGatheringFrame | null;
  productions?: readonly ForestProductionFrame[];
  residents?: readonly ReturnType<typeof forestResidentFrames>[number][];
  builderSleeping?: ReturnType<typeof builderSleepIndicator>;
  residentPresentation?: ReturnType<typeof residentScenePresentation>;
  merchantBoat?: ReturnType<typeof leaftailBoatArrivalFrame>;
};

function reducedMotion(options: SceneOptions, dev?: WorldDevState) {
  return dev?.reducedMotion === "on" || dev?.reducedMotion !== "off" && options.reducedMotion;
}
function atmosphereOptions(options: SceneOptions, timestamp: number, dusk: number, preview?: NewMapPaintPreview): ForestAtmosphereOptions {
  const dev = preview?.state;
  const effectiveDusk = dev?.timeOfDay === "day" ? 0 : dev?.timeOfDay === "night" ? 1 : dusk;
  const fauna = preview?.fauna ? faunaRenderFrame(preview.fauna, {
    dusk: effectiveDusk, butterflies: dev?.butterflies, fireflies: dev?.fireflies,
  }) : undefined;
  return { elapsed: timestamp / 1000, timestamp, reducedMotion: reducedMotion(options, dev),
    dusk: effectiveDusk,
    weather: dev?.weather, butterflies: dev?.butterflies, fireflies: dev?.fireflies, birds: dev?.birds,
    birdElapsed: preview?.birdElapsed, birdSeed: preview?.birdSeed,
    fauna: fauna ? { ...fauna, butterflies: dev?.butterflies === "off" ? [] : fauna.butterflies,
      fireflies: dev?.fireflies === "off" ? [] : fauna.fireflies } : undefined,
    birdFrame: preview?.birdFrame };
}
function actorFrame(elapsed: number, reacting: boolean, still: boolean, preview?: NewMapPaintPreview) {
  const cycle = elapsed % 48, animation = preview?.animation, chosen = preview?.state?.pose;
  const pose: PixelPose = animation?.pose ?? (chosen && chosen !== "auto" ? chosen : reacting ? "greet" : still ? "idle"
    : cycle >= 19 && cycle < 21 ? "sniff" : cycle >= 37 && cycle < 39 ? "groom"
      : elapsed % 6 > 5.8 ? "blink" : "idle");
  const frame = animation ? still ? 2 : Math.min(3, Math.floor(animation.elapsed / REACTION_SECONDS * 4))
    : still ? 0 : Math.floor(elapsed * (reacting ? 7 : 3)) % 4;
  return { pose, frame };
}

/** Both views paint this scene in logical map coordinates, independently of source resolution. */
export function paintNewMap(context: CanvasRenderingContext2D, images: ReadonlyMap<string, HTMLImageElement>,
  options: SceneOptions, elapsed: number, reacting: boolean, timestamp = options.serverNow ?? 0,
  dusk = Number(options.dusk), preview?: NewMapPaintPreview) {
  const timing = forestPerformanceProfiler.begin("render", options.devRehearsal ? "rehearsal" : "world");
  try { paintNewMapFrame(context, images, options, elapsed, reacting, timestamp, dusk, preview); }
  finally { forestPerformanceProfiler.end(timing); }
}

function paintNewMapFrame(context: CanvasRenderingContext2D, images: ReadonlyMap<string, HTMLImageElement>,
  options: SceneOptions, elapsed: number, reacting: boolean, timestamp: number,
  dusk: number, preview?: NewMapPaintPreview) {
  const dev = preview?.state, still = reducedMotion(options, dev);
  const currentLevels = accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings);
  const authoredWorld = preview?.scene ?? previewWorldScene(TILED_WORLD, currentLevels);
  const world = WORLD_DEV_ENABLED ? worldLightingEditorStore.applyToScene(authoredWorld, currentLevels) : authoredWorld;
  const home = world.sites.find(site => site.id === "home");
  const selectedVisuals = preview?.visuals ?? visualsFor(currentLevels);
  const selectedLevels = Object.fromEntries(Object.entries(selectedVisuals).map(([id, visual]) => [id, visual.level]));
  const walking = preview?.clearing;
  const visibleMining = selectedLevels.quarry > 0 ? preview?.mining : null;
  const actor = { x: visibleMining?.x ?? preview?.gathering?.x ?? walking?.x ?? NEW_MAP_SPAWN.x,
    y: visibleMining?.y ?? preview?.gathering?.y ?? walking?.y ?? NEW_MAP_SPAWN.y, size: PET_SIZE * (dev?.heroScale ?? 1) };
  const mining = visibleMining ? { ...visibleMining, size:actor.size } : null;
  const fishing = preview?.fishing ? withForestWaterBuoyancy({ ...preview.fishing, size: actor.size }, preview.water, still) : null;
  const cooking = !fishing && preview?.cooking ? { ...preview.cooking, size: actor.size } : null;
  const gathering = !mining && !fishing && !cooking ? gatheringAtSize(preview?.gathering, actor.size) : null;
  const atmosphere = { ...atmosphereOptions(options, timestamp, dusk, preview), elapsed };
  const birds = atmosphere.birdFrame ?? forestBirdFrame(world, { ...atmosphere, ...forestAtmosphereState(world, atmosphere) });
  atmosphere.birdFrame = birds;
  const groundBirds = birds.filter(bird => bird.groundY !== undefined).sort((a, b) => a.groundY! - b.groundY!);
  const life = preview?.life;
  const heroVisible = dev?.showHero !== false && !(preview?.actorAway ?? economyJourneyAway(options.economyJourney, timestamp));
  const fauna = atmosphere.fauna;
  const behindButterflies = heroVisible ? fauna?.butterflies.filter(p => faunaBehindHero(p, world, actor.y, walking?.bush)) ?? [] : [];
  const behindFireflies = heroVisible ? fauna?.fireflies.filter(p => faunaBehindHero(p, world, actor.y, walking?.bush)) ?? [] : [];
  if (fauna) atmosphere.fauna = { ...fauna,
    butterflies: fauna.butterflies.filter(p => !behindButterflies.includes(p)),
    fireflies: fauna.fireflies.filter(p => !behindFireflies.includes(p)),
  };
  const automatic = heroVisible && !fishing && !mining && !cooking && !gathering && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto");
  const motion = automatic && walking ? walking : null;
  // A cancelled carry may wait for clear ground; attention cannot hide its basket.
  const garden = automatic || life?.garden.basket?.held ? forestGardenVisualFrame(life?.garden, actor,
    { pose: motion?.pose ?? "idle", frame: motion?.frame ?? 0, direction: motion?.direction ?? "front" }, still) : null;
  const routine = heroVisible && !fishing && !mining && !gathering && life?.routine && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto")
    ? forestLifeFrame(life, { ...actor, propSize: PET_SIZE }, elapsed) : null;
  const encounter = heroVisible && !fishing && !gathering && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto") && preview?.fauna
    ? faunaInteractionFrame(preview.fauna) : null;
  const trading = automatic ? preview?.tradeVisit : null;
  const birdwatch = automatic && !still && preview?.birdwatch ? forestBirdwatchFrame(preview.birdwatch, actor) : null;
  const fire = life?.campfires.find(item => item.id === preview?.campfireVisit?.id);
  const warming = automatic && fire && preview?.campfireVisit ? campfireVisitFrame(preview.campfireVisit, fire, actor, still) : null;
  const behindFires = (life?.campfires ?? []).filter(item => item.position.y < actor.y);
  const frontFires = (life?.campfires ?? []).filter(item => item.position.y >= actor.y);
  const productions = preview?.productions ?? forestProductionFrames(options.economyProduction, world, selectedVisuals, timestamp, elapsed, dev?.showBuildings !== false);
  const residents = preview?.residents ?? forestResidentFrames(world, elapsed, still);
  const depthProps: { y: number; paint: () => void }[] = [];
  const parkedBasket = forestGardenGroundBasket(life?.garden, actor.size, garden);
  if (parkedBasket) depthProps.push({ y: parkedBasket.y, paint: () => withForestOcclusion(context, world, parkedBasket,
    target => drawForestGardenBasket(target, parkedBasket), { x: parkedBasket.x - parkedBasket.size * .55,
      y: parkedBasket.y - parkedBasket.size * .9, width: parkedBasket.size * 1.1, height: parkedBasket.size * 1.1 }) });
  if (gathering && !gathering.held) {
    const basket = gathering.basket;
    depthProps.push({ y: basket.y, paint: () => withForestOcclusion(context, world, basket,
      target => drawForestGatheringBasket(target, gathering), { x: basket.x - basket.size * .6,
        y: basket.y - basket.size, width: basket.size * 1.2, height: basket.size * 1.15 }) });
  }
  // Ground props share the residents' actual feet depth, including objects
  // beside a working hero. Carrying props stay in their owner's hand pass.
  const paintResidentLayer = (layer: "behind" | "front") => {
    let fromY = -Infinity;
    for (const prop of depthProps.filter(prop => (prop.y < actor.y) === (layer === "behind")).sort((a, b) => a.y - b.y)) {
      drawForestResidents(context, world, elapsed, still, actor.y, layer, residents.filter(resident => resident.y >= fromY && resident.y < prop.y));
      prop.paint(); fromY = prop.y;
    }
    drawForestResidents(context, world, elapsed, still, actor.y, layer, residents.filter(resident => resident.y >= fromY));
  };
  const lighting = { night: Number(atmosphere.dusk), elapsed, reducedMotion: still,
    showBuildings: dev?.showBuildings, levels: selectedLevels, quality: dev?.lightQuality };
  // Confirmed production uses the same source as its visible cooking burner.
  const cookingFires = (life?.campfires ?? []).map(fire => productions.some(frame => frame.fireId === fire.id && frame.phase === "working")
    ? { ...fire, flame: Math.max(fire.flame, .45), embers: Math.max(fire.embers, .4) } : fire);
  const testLamp = dev?.lightTestLamp ? { x: dev.lightLampX, y: dev.lightLampY, height: dev.lightLampHeight } : undefined;
  const shadowFrame = dev?.lightShadows !== false && world.shadowReceivers?.length ? createForestShadowFrame(world, {
    ...lighting, lights: forestLightSources(world, lighting), fires: cookingFires,
    azimuth: dev?.lightAzimuth, elevation: dev?.lightElevation, quality: dev?.lightQuality, testLamp,
    buildingShadows: dev?.buildingShadow, geometryRevision: WORLD_DEV_ENABLED ? worldLightingEditorStore.getSnapshot().geometryRevision : 0,
    actors: [
      ...(heroVisible && dev?.heroShadow !== false ? [{ ...(fishing ?? cooking ?? actor), id: "mochlik",
        size: actor.size, opacity: walking?.opacity ?? 1, lift: motion?.lift }] : []),
      ...(preview?.residents ?? []).map(resident => ({ ...resident, opacity: "opacity" in resident ? resident.opacity : 1 })),
    ],
  }) : undefined;
  const paintProduction = (front: boolean) => {
    for (const frame of productions) if ((frame.y >= actor.y) === front) {
      if (frame.stationId === "dryer") drawForestProductionCooking(context, frame, still);
      else drawForestProductionStation(context, frame, still);
    }
  };
  const foregroundBush = heroVisible && walking?.bush && forestBushForegroundActive(walking.bush, still)
    ? world.bushes?.find(bush => bush.id === walking.bush!.id) : undefined;
  const foregroundTerrain = foregroundBush?.imageId && forestBushArtworkAvailable(world, foregroundBush)
    ? world.terrain.find(terrain => terrain.id === foregroundBush.imageId) : undefined;
  const foregroundImage = foregroundTerrain && images.get(foregroundTerrain.image);
  const paintBush = () => {
    if (!walking?.bush || !heroVisible) return;
    const growth = life?.garden?.bushes.find(bush => bush.id === walking.bush!.id)?.growth;
    drawForestBush(context, world, images, { ...walking.bush, ripe: growth === undefined || growth >= .98 }, elapsed, still);
    if (walking.bush.occlude || walking.bush.rustle > 0) drawForestGardenPlants(context, world, life?.garden);
  };
  context.save();
  context.beginPath(); context.rect(0, 0, world.width, world.height); context.clip();
  paintFixedWorld(context, world, { images, visuals: selectedVisuals, actor: null, dusk: Number(atmosphere.dusk),
    bushMoisture: life?.garden?.bushes,
    paintBackdrop: (ground, image, terrain) => {
      if (dev?.waterSurface !== false) drawForestWaterRefraction(ground, world, preview?.water, image, terrain, { reducedMotion: still });
      if (preview?.trees) drawForestTreeCrownMotion(ground, preview.trees, image, terrain, { reducedMotion: still });
    },
    hiddenTerrainIds: foregroundTerrain && foregroundImage?.naturalWidth && foregroundImage.naturalHeight ? [foregroundTerrain.id] : undefined,
    paintGround: ground => {
      const weather = { ...forestAtmosphereState(world, atmosphere), reducedMotion: still };
      const groundExclusions = life?.mushrooms.map(mushroom => ({ x: mushroom.x, y: mushroom.y, radius: PET_SIZE * .14 }));
      drawForestWater(ground, world, { ...weather, waterFish: dev?.waterFish, waterBreeze: dev?.waterBreeze,
        waterSurface: dev?.waterSurface,
        wind: dev?.waterWind === "calm" ? 0 : dev?.waterWind === "breeze" ? .45 : dev?.waterWind === "windy" ? 1 : undefined });
      if (preview?.water && dev?.waterSurface !== false) {
        drawForestWaterDynamics(ground, world, preview.water, { dusk: weather.dusk, reducedMotion: still });
      }
      drawForestGroundImpacts(ground, world, { ...weather, groundExclusions });
      if (dev?.puddles !== false) drawForestGroundWeather(ground, world, { ...atmosphere, wetness: preview?.wetness ?? 0,
        groundExclusions });
      if (shadowFrame) drawForestDirectionalShadows(ground, world, shadowFrame);
      if (life) drawForestMushrooms(ground, life, PET_SIZE);
      for (const pile of preview?.residentPresentation?.woodpiles ?? []) drawLopukhWoodpile(ground, pile);
      if (preview?.merchantBoat) drawLeaftailBoatArrival(ground, preview.merchantBoat, still, { resident: preview.merchantBoat.phase === "sailing" });
    },
    options: { levels: selectedLevels, night: false, debug: dev?.debug ?? false, selectedSiteId: null,
      reducedMotion: still, showBuildings: dev?.showBuildings, buildingShadow: dev?.buildingShadow } });
  drawForestCampfires(context, behindFires, elapsed, still);
  paintProduction(false);
  drawForestGardenPlants(context, world, life?.garden);
  // A moving cutout may own the artwork while its actor is still in front.
  // Rustling never promotes leaves over an approaching or emerging body.
  if (!walking?.bush?.occlude) paintBush();
  // Resting wildlife belongs to the foliage, not an always-on-top air overlay.
  // Paint once before the solid body; takeoff keeps this depth until it clears.
  for (const particle of behindButterflies) drawForestButterfly(context, particle, fauna!.elapsed);
  for (const particle of behindFireflies) drawForestFirefly(context, particle, fauna!.elapsed);
  paintResidentLayer("behind");
  for (const bird of groundBirds) if (bird.groundY! < actor.y) drawForestBird(context, bird);
  if (heroVisible && (walking?.opacity ?? 1) > 0) {
    const manualDirection = dev && !motion?.bush?.occupied && (still || dev.autoLife === false && motion?.pose === "idle") ? dev.direction : undefined;
    context.save(); context.globalAlpha *= walking?.opacity ?? 1;
    withForestOcclusion(context, world, actor, actorContext => {
      if (mining) {
        drawForestMiningHero(actorContext,mining,dev?.equipment ?? options.worldState?.equipment,dev?.heroShadow);
        return;
      }
      if (fishing) {
        drawForestFishingHero(actorContext, fishing, dev?.equipment ?? options.worldState?.equipment, still, dev?.heroShadow);
        return;
      }
      if (cooking) {
        drawForestCookingHero(actorContext, cooking, dev?.equipment ?? options.worldState?.equipment, still, dev?.heroShadow);
        return;
      }
      if (gathering) {
        drawForestGatheringHero(actorContext, gathering, dev?.equipment ?? options.worldState?.equipment, still, dev?.heroShadow);
        return;
      }
      drawForestGardenProps(actorContext, garden, "behind", true);
      drawGroundedHero(actorContext, { ...actor, direction: garden?.direction ?? routine?.direction ?? encounter?.direction ?? warming?.direction ?? birdwatch?.direction ?? trading?.direction ?? manualDirection ?? motion?.direction ?? dev?.direction ?? "front",
        ...(garden ? { pose: garden.pose, frame: garden.frame } : routine ?? encounter ?? warming ?? birdwatch ?? trading ?? (motion ? { pose: motion.pose, frame: motion.frame } : actorFrame(elapsed, reacting, still, preview))),
        appearance: dev?.equipment ?? options.worldState?.equipment, shadow: dev?.heroShadow, lift: motion?.lift, compression: motion?.compression,
        rig: garden?.rig ?? routine?.rig });
      if (routine) drawForestLifePartner(actorContext, routine, elapsed);
      drawForestGardenProps(actorContext, garden, "front", true);
    }, gathering ? forestGatheringBounds(gathering) : fishing ? fishingPropsBounds(fishing) : cooking ? forestCookingBounds(cooking) : undefined);
    context.restore();
  }
  paintResidentLayer("front");
  for (const bird of groundBirds) if (bird.groundY! >= actor.y) drawForestBird(context, bird);
  if (walking?.bush?.occlude) paintBush();
  if (walking?.homeSleeping && home && heroVisible && dev?.showBuildings !== false) {
    drawHomeSleep(context, home.doorway ?? home.entry, elapsed, still);
  }
  if (preview?.builderSleeping && dev?.showBuildings !== false) {
    drawHomeSleep(context, preview.builderSleeping, preview.builderSleeping.phase, still);
  }
  if (dev?.showBuildings !== false) for (const indicator of preview?.residentPresentation?.homes ?? [])
    drawResidentHomeIndicator(context, indicator, still);
  drawForestCampfires(context, frontFires, elapsed, still);
  paintProduction(true);
  if (preview?.trees) drawForestTreeLeaves(context, preview.trees, { dusk: Number(atmosphere.dusk), reducedMotion: still });
  drawForestAtmosphere(context, world, { ...atmosphere, groundBirdsPainted: true }, () => {
    const occludedLighting = shadowFrame ? drawForestOccludedLighting(context, world, shadowFrame) : false;
    if (!occludedLighting) drawForestLighting(context, world, lighting);
    drawForestCampfireGlow(context, cookingFires, elapsed, still, lighting.night, heroVisible ? actor : undefined,
      productions.flatMap(frame => frame.fireId ? [frame.fireId] : []), !occludedLighting); });
  drawForestLighthouseBeams(context, world, lighting);
  drawForestLightEmitters(context, world, lighting);
  drawBuildingDetails(context, world, lighting);
  if (shadowFrame && testLamp) drawForestTestLamp(context, testLamp);
  // Station status stays legible above the roof in both daylight and night.
  // The full map's production badge owns this roof whenever an order exists.
  // The circle and an expedition without production retain the animated picks.
  if (selectedLevels.quarry > 0 && dev?.showBuildings !== false && !(options.view === "world" && productions.some(frame => frame.stationId === "quarry"))) {
    const quarryProduction = productions.find(frame => frame.stationId === "quarry" && frame.phase === "working");
    const quarry = quarryProduction && world.sites.find(site => site.id === "quarry");
    const work = mining?.working ? mining : !mining && quarry && quarryProduction ? {
      working:true, workCue:{x:quarry.anchor.x,y:quarry.bounds.y-PET_SIZE*.12},
      size:PET_SIZE, elapsed:quarryProduction.elapsed,
    } : null;
    if (work) drawForestMiningWork(context,work,still);
  }
  if (WORLD_DEV_ENABLED && dev?.debugWater) drawWaterDebug(context, world);
  if (WORLD_DEV_ENABLED && dev?.lightDebug && !worldLightingEditorStore.getSnapshot().enabled && shadowFrame) drawForestShadowDebug(context, world, shadowFrame);
  if (WORLD_DEV_ENABLED && preview?.livingDebug) drawLivingWorldDebug(context, world, preview.livingDebug);
  context.restore();
}

/** Shared Tiled scene; development overrides never enter persisted world state. */
export function mountNewMapScene(canvas: HTMLCanvasElement, initial: SceneOptions, callbacks: SceneCallbacks): HabitatScene {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("2D canvas unavailable");
  const ctx = context;
  let options = { ...initial }, art: ReadonlyMap<string, HTMLImageElement> | null = null, disposed = false;
  if (WORLD_DEV_ENABLED) worldLightingEditorStore.hydrate();
  let dev = WORLD_DEV_ENABLED ? worldDevStore.getSnapshot() : undefined;
  let world = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings));
  let trees = createForestTreeInteractions(world);
  let visuals = visualsFor(accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings)), requestedKey: string | null = null, artworkVersion = 0;
  let unsubscribe = () => {};
  let frame = 0, previous = 0;
  let configuredTimestamp = Number.isFinite(initial.serverNow) ? initial.serverNow! : null;
  // Economic deadlines use server wall time. Unlike the cosmetic simulation,
  // this clock must accept an earlier authoritative sample after client drift.
  let economicTimestamp = configuredTimestamp ?? Date.now(), economicReceivedAt = performance.now();
  let pendingTimestamp: number | null = null;
  let reactionTimer: ReturnType<typeof setTimeout> | null = null;
  let speechTimer: ReturnType<typeof setTimeout> | null = null, staticSpeechAt: number | null = null;
  let lastActivity: "idle" | "greet" | null = null;
  const audio = createWorldAudioController(getAudioRuntime());
  let audioCamera: WorldAudioCamera | undefined;
  let session = connect();
  let state = session.state;
  const residentDiagnosticsOwner = {};

  function reportResidents() {
    // The arguments themselves sample every actor. Keep that work behind the
    // open-inspector gate, rather than relying on report() to discard it later.
    if (!WORLD_DEV_ENABLED || !residentDiagnosticsStore.isObserved() || options.backgrounded || !session.isOwner() || !active()) return;
    residentDiagnosticsStore.report(state, residentOccupants(), options.presenceKey ?? "forest", true,
      { owner: residentDiagnosticsOwner, paused: false, settings: dev, rehearsal: options.devRehearsal ?? null });
  }

  function ensureWater() {
    // WaterExclusions do not participate in the account-memory fingerprint.
    // A Tiled edit must still replace cosmetic topology in a retained session.
    if (!state.water || waterGeometrySources.get(state.water) !== world.water) {
      state.water = createForestWaterDynamics(world);
      waterGeometrySources.set(state.water, world.water);
    }
    return state.water;
  }

  function waterContacts(emit: boolean, weather?: { rain: number; dusk: number }) {
    if (!state.water) return;
    let tracker = waterInteractionTrackers.get(state.water);
    if (!tracker) { tracker = createForestWaterInteractionTracker(); waterInteractionTrackers.set(state.water, tracker); }
    const still = reducedMotion(options, dev), shown = dev?.waterSurface !== false;
    const environment = weather ?? forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
    const fishing = forestJourneyFishingFrame(state, world, false);
    const plesk = residentFrames().find(resident => resident.id === "plesk") ?? null;
    const splashes = shown && !still ? forestWaterContactsFrame(world, { elapsed: state.elapsed, rain: environment.rain,
      dusk: environment.dusk, reducedMotion: false, waterFish: dev?.waterFish }).splashes : [];
    const impulses = tracker.sample({ epoch: state.clearing, scene: world, elapsed: state.elapsed,
      reducedMotion: still || !shown,
      fishing: [
        { key: "mochlik", token: `${state.journeyTravel?.jobId}:${fishing?.castIndex ?? 0}`, frame: fishing,
          visible: dev?.showHero !== false && !actorAway() },
        { key: "plesk", token: dev?.residentPreview ? `preview:${dev.residentPreview.id}` : `${state.pleskMind?.decisions}`,
          frame: plesk, visible: dev?.showBuildings !== false },
      ], splashes }, emit);
    for (const impulse of impulses) disturbForestWater(state.water, impulse, { strength: impulse.strength, radius: impulse.radius });
  }

  function advanceWater(step: number, environment: { rain: number; dusk: number }) {
    const timing = forestPerformanceProfiler.begin("water", options.devRehearsal ? "rehearsal" : "world");
    try {
    if (!world.water?.surfaces.length || dev?.waterSurface === false) { waterContacts(false); return; }
    const water = ensureWater();
    waterContacts(true, environment);
    const wind = dev?.waterWind === "calm" ? 0 : dev?.waterWind === "breeze" ? .45 : dev?.waterWind === "windy" ? 1 : undefined;
    advanceForestWaterDynamics(water, step, { rain: environment.rain,
      wind: forestWaterWind({ ...environment, elapsed: state.elapsed, wind }) });
    } finally { forestPerformanceProfiler.end(timing); }
  }

  const explorationNow = () => economicTimestamp + (options.devRehearsal ? state.elapsed * 1000
    : Math.max(0, performance.now() - economicReceivedAt));
  function updateAudio(emitEvents = false) {
    const now = explorationNow();
    const dusk = reducedMotion(options, dev) || !session.isSimulationAllowed() ? Number(options.dusk) : state.dusk;
    // Weather follows the painted simulation clock; economy deadlines still
    // use explorationNow() below. Slow frames must not create invisible drops.
    const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, dusk, { state: dev }));
    audio.update(world, state, {
      sceneId: `${options.presenceKey ?? "guest"}:${world.id}`, now,
      ownerPublicId: options.presenceKey?.replace(/^zhiv:mochlik:presence:/, ""),
      dusk: environment.dusk, rain: environment.rain,
      camera: options.view === "world" ? audioCamera : undefined,
      levels: Object.fromEntries(Object.entries(visuals).map(([id, visual]) => [id, visual.level])),
      production: state.economyProduction, construction: state.economyConstruction,
      quarryWorking: quarryAudioWorking(world, state, options.economyJourney, now),
      cookingPreview: dev?.showHero !== false && !actorAway() && !forestJourneyFishingFrame(state, world)
        ? cookingPreviewFrame(state, dev?.cookingPreview, reducedMotion(options, dev)) : null,
      fires: state.life.campfires, showBuildings: dev?.showBuildings,
    }, { scope: options.view === "world" ? "world" : "music", visible: active(), observationOwner: session.isObservationOwner(), emitEvents,
      showHero: dev?.showHero !== false, actorAway: actorAway(), reducedMotion: reducedMotion(options, dev), waterFish: dev?.waterFish });
  }
  function setEconomicTime(now: number) { economicTimestamp = now; economicReceivedAt = performance.now(); }
  function syncProduction() {
    const owner = options.presenceKey?.startsWith("zhiv:mochlik:presence:") ? options.presenceKey.slice("zhiv:mochlik:presence:".length) : undefined;
    syncForestProduction(state, options.economyProduction, owner);
  }
  const announcedArrivals = new WeakSet<object>();
  function syncVillagers() {
    const owner = options.presenceKey?.startsWith("zhiv:mochlik:presence:") ? options.presenceKey.slice("zhiv:mochlik:presence:".length) : undefined;
    syncForestResidentAccess(state, options.economyResidents, owner);
    if (!session.isOwner()) return;
    const villagers = state.villagers ??= createForestVillagers(world), access = state.economyResidents;
    const presentingArrival = Boolean(options.view === "world" && active() && options.residentArrival?.enabled);
    const merchantReady = syncSceneMerchantArrival(state, world, options, active(), reducedMotion(options, dev), residentOccupants());
    // A completed construction also changes its collision silhouette. Wait for
    // the matching artwork before planning any resident's first approach.
    const quarryReady = (access?.buildings.quarry ?? 0) < 1 || (visuals.quarry?.level ?? 0) > 0;
    configureForestVillagers(villagers, world, { buildings: access?.buildings ?? {}, confirmed: Boolean(access && quarryReady),
      production: access?.production, now: explorationNow(), arrivalSeen: options.residentArrival?.seen ?? villagers.arrivalCompleted,
      allowArrival: presentingArrival && quarryReady, leaftailReady: merchantReady });
    const boat = state.leaftailBoat;
    if (boat?.completed && options.merchantArrival?.enabled && !options.merchantArrival.seen) {
      const presenceKey = options.presenceKey;
      announceSceneMerchantArrival(state, options.merchantArrival.onComplete, () => !disposed && options.presenceKey === presenceKey
        && state.leaftailBoat === boat && active() && session.isOwner() && options.view === "world" && options.merchantArrival?.enabled === true);
    }
    reconcileWildlife();
    if (reducedMotion(options, dev) && presentingArrival) settleForestVillagerArrival(villagers, residentOccupants());
    if (villagers.arrivalCompleted && presentingArrival && options.residentArrival && !options.residentArrival.seen && !announcedArrivals.has(villagers)) {
      const presenceKey = options.presenceKey;
      announcedArrivals.add(villagers);
      queueMicrotask(() => {
        if (!disposed && options.presenceKey === presenceKey && state.villagers === villagers && active() && session.isOwner()
          && options.view === "world" && options.residentArrival?.enabled) options.residentArrival.onComplete();
        else announcedArrivals.delete(villagers);
      });
    }
  }
  function advanceVillagers(dt: number, rain: number, dusk: number) {
    syncVillagers();
    if (!state.villagers) return;
    const wildlife = state.villagerWildlife ??= createVillagerWildlife();
    const actors = villagerWildlifeActors().filter(actor => !options.devRehearsal
      || !["watch-birds", "butterfly"].includes(options.devRehearsal.scenario) || actor.id === options.devRehearsal.actor);
    if (actors.length || wildlife.birdwatch) advanceVillagerWildlife(wildlife, dt, { actors,
      birds: wildlife.birdwatch || actors.some(villagerWildlifeAvailable) ? visibleBirds() : [], fauna: state.fauna,
      rain, dusk, enabled: options.devRehearsal ? options.devRehearsal.scenario === "watch-birds" : dev?.autoLife !== false,
      reservedBirdIds: state.director.birdwatch ? [state.director.birdwatch.birdId] : [] });
    const meeting = state.social.meeting;
    advanceForestVillagers(state.villagers, world, dt, { rain, dusk, now: explorationNow(),
      production: state.economyResidents?.production, occupants: residentOccupants(),
      arrivalActive: Boolean(options.view === "world" && options.residentArrival?.enabled && active() && session.isOwner()),
      wildlifeHolds: villagerWildlifeHolds(wildlife, state.fauna),
      socialPartners: meeting ? { [meeting.host]: meeting.guest, [meeting.guest]: meeting.host } : undefined,
      socialHolds: (["lopukh", "kamneshmyg", "leaftail"] as const).filter(socialResidentHeld) });
    syncVillagers();
  }
  function socialResidentHeld(id: ForestSpeaker) {
    return Boolean(forestSocialPartner(state.social, id) || forestSocialWaitingHost(state.social) === id || forestSocialFollowupHolding(state.social, id));
  }
  function villagerWildlifeActors() {
    return state.villagers ? forestVillagerFrames(state.villagers).map(frame => {
      const mind = state.villagers!.residents[frame.id];
      return { ...frame, available: forestVillagerAvailableForLeisure(mind), job: mind.job,
        inside: mind.doorPhase !== "outside", social: Boolean(mind.socialVisit || socialResidentHeld(frame.id)), noticed: mind.noticePending };
    }) : [];
  }
  function faunaVisitors() {
    const resident = state.pleskMind ? pleskMindFrame(state.pleskMind, world, false) : null;
    const plesk = resident ? [{ ...resident, hand: pleskWildlifeHand(resident),
      available: pleskAvailableForLeisure(state.pleskMind) && !socialResidentHeld("plesk") && !dev?.residentPreview && !state.pleskMind?.noticePending && !state.pleskMind?.tradePending
        && (!resident.carryingFish || resident.action === "rest") && ["idle", "rest", "greet"].includes(resident.action) }] : [];
    const visitors = [...plesk, ...forestVillagerFaunaVisitors(villagerWildlifeActors(), state.villagerWildlife)];
    return options.devRehearsal?.scenario === "butterfly" ? visitors.filter(visitor => visitor.id === options.devRehearsal!.actor) : visitors;
  }
  function reconcileWildlife() {
    // Authority/touch can change at dt=0. Release invalid reservations without
    // moving an insect, advancing its clock or taking over another camera.
    reconcileVillagerWildlife(state.villagerWildlife, villagerWildlifeActors(), state.fauna);
    const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
    reconcileResidentFaunaEncounters(state.fauna, faunaVisitors(), { rain: environment.rain, dusk: environment.dusk,
      butterflies: dev?.butterflies, fireflies: dev?.fireflies });
  }
  function syncConstruction() {
    const owner = options.presenceKey?.startsWith("zhiv:mochlik:presence:") ? options.presenceKey.slice("zhiv:mochlik:presence:".length) : undefined;
    syncForestConstruction(state, options.economyConstruction, owner);
    if (session.isObservationOwner()) advanceBuilder(0);
  }
  function advanceBuilder(dt: number) {
    if (state.builderMind?.constructionPending) {
      // The first economy response can also replace default building art. Wait
      // for that geometry to commit before selecting the cold-entry work stop;
      // otherwise a worker can briefly appear beside the wrong building level.
      const selected = accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings);
      if (TILED_WORLD.sites.some(site => previewSiteVisual(site, selected)?.level !== visuals[site.id]?.level)) return;
    }
    advanceBuilderMind(state.builderMind, world, dt, { now: explorationNow(), construction: state.economyConstruction,
      occupants: residentOccupants(), socialHold: socialResidentHeld("builder"),
      night: Number(atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }).dusk) >= .65 });
  }
  // DEV rehearsals use the same travel/animation controller with a local clock.
  // A confirmed account job always owns the hero and its economic deadline.
  function displayedJourney(): { journey: EconomySceneJourney | null | undefined; now: number } {
    const now = explorationNow();
    // Even an unclaimed expedition keeps its own return animation. Ordinary
    // quarry production borrows the worker only when that slot is empty.
    if (options.economyJourney) return { journey: options.economyJourney, now };
    const mining = state.economyResidents && (state.economyResidents.buildings.quarry ?? 0) >= 1
      ? null : forestProductionJourney(state.economyProduction, now);
    if (mining) return { journey: mining, now };
    if (!WORLD_DEV_ENABLED || !state.fishingPreview) return { journey: null, now };
    const rehearsal = state.fishingPreview;
    return { now: state.elapsed * 1000, journey: { id: `dev-fishing:${rehearsal.id}`, routeId: "shore",
      startedAt: new Date(rehearsal.startedAt * 1000).toISOString(),
      finishesAt: new Date((rehearsal.startedAt + 120) * 1000).toISOString(), label: "Проверка рыбалки у берега" } };
  }
  const exploring = () => { const { journey, now } = displayedJourney(); return economyJourneyAway(journey, now); };
  const actorAway = () => { const { journey, now } = displayedJourney(); return forestJourneyActorAway(state, journey, now); };
  function syncExploration() {
    if (!session.isOwner()) return;
    syncProduction();
    if (economyJourneyAway(options.economyJourney, explorationNow())) state.fishingPreview = undefined;
    const { journey, now } = displayedJourney();
    syncForestJourneyTravel(state, world, journey, now, reducedMotion(options, dev), options.cancelledExplorations,
      (visuals.quarry?.level ?? 0) > 0);
  }
  function residentFrames() {
    const rehearsal = dev?.residentPreview;
    let natural = state.pleskMind ? pleskMindFrame(state.pleskMind, world, reducedMotion(options, dev)) : null;
    const encounter = residentFaunaEncounter(state.fauna, "plesk");
    if (natural && encounter && !["interrupt", "release"].includes(encounter.phase)) {
      natural = { ...natural, action: natural.carryingFish ? "rest" : "greet", phase: .5, frame: 0, direction: encounter.direction, wildlife: true };
    }
    const partner = socialPartnerPosition("plesk");
    if (natural && partner && !rehearsal) natural = { ...natural, direction: builderDirection(partner.x - natural.x, partner.y - natural.y) };
    const plesk = previewForestResidents(world, state.elapsed, reducedMotion(options, dev), rehearsal ?? null,
      rehearsal && rehearsal.id === state.residentPreview?.id ? state.residentPreview.startedAt : state.elapsed, natural ? [natural] : []);
    const builderRehearsal = dev?.builderPreview;
    let builder = previewForestBuilder(builderMindFrame(state.builderMind, world, reducedMotion(options, dev)),
      state.elapsed, reducedMotion(options, dev), builderRehearsal ?? null,
      builderRehearsal && builderRehearsal.id === state.builderPreview?.id ? state.builderPreview.startedAt : state.elapsed);
    if (builder && !builderRehearsal && forestSocialFollowupHolding(state.social, "builder"))
      builder = { ...builder, action: "inspect", phase: Math.min(1, (state.social.followup?.age ?? 0) / 3) };
    const wildlifeActors = villagerWildlifeActors();
    const villagers = state.villagers ? forestVillagerFrames(state.villagers, reducedMotion(options, dev)).map(resident => {
      if (forestSocialFollowupHolding(state.social, resident.id))
        return { ...resident, action: "inspect" as const, phase: Math.min(1, (state.social.followup?.age ?? 0) / 3) };
      const partner = socialPartnerPosition(resident.id);
      if (partner) return { ...resident, direction: builderDirection(partner.x - resident.x, partner.y - resident.y) };
      const actor = wildlifeActors.find(actor => actor.id === resident.id);
      const wildlife = actor && villagerWildlifeAvailable(actor) ? villagerWildlifeFrame(state.villagerWildlife, state.fauna, resident) : null;
      return wildlife ? { ...resident, ...wildlife } : resident;
    }) : [];
    const boat = state.leaftailBoat && leaftailBoatArrivalFrame(state.leaftailBoat);
    return [...plesk, ...(builder ? [builder] : []), ...villagers, ...(boat && boat.phase !== "sailing" ? [boat.resident] : [])];
  }
  function socialPartnerPosition(speaker: ForestSpeaker): WorldPoint | undefined {
    const partner = forestSocialPartner(state.social, speaker);
    if (partner === "leaftail" && state.villagers?.residents.leaftail.doorPhase === "inside") return forestLeaftailWindow(world)?.position;
    return partner === "mochlik" ? state.clearing.position : partner === "builder" ? state.builderMind?.position
      : partner === "plesk" ? state.pleskMind?.position : partner ? state.villagers?.residents[partner]?.position : undefined;
  }
  function residentOccupants() {
    const timing = forestPerformanceProfiler.begin("occupancy", options.devRehearsal ? "rehearsal" : "world");
    try {
    const occupants = forestResidentOccupants(state, world, { heroVisible: dev?.showHero !== false && !actorAway(), heroScale: dev?.heroScale,
      heroManual: Boolean(state.animation || state.reaction > 0 || dev?.pose && dev.pose !== "auto"),
      fishing: forestJourneyFishingFrame(state, world), mining: forestJourneyMiningFrame(state, world),
      gathering: gatheringAtSize(forestJourneyGatheringFrame(state, world), state.clearing.size * (dev?.heroScale ?? 1)),
      cooking: cookingPreviewFrame(state, dev?.cookingPreview) });
    const arriving = state.leaftailBoat && leaftailBoatArrivalOccupant(state.leaftailBoat);
    if (arriving) occupants.push(arriving);
    return occupants;
    } finally { forestPerformanceProfiler.end(timing); }
  }
  /** Speech uses the same visible feet as traffic; hidden portals and work
   * animations cannot leave a floating caption at an old clearing coordinate. */
  function socialEnvironment(): ForestSocialEnvironment {
    const occupants = residentOccupants(), body = clearingActivityFrame(state.clearing);
    const fishing = forestJourneyFishingFrame(state, world), cooking = cookingPreviewFrame(state, dev?.cookingPreview);
    const builderRehearsal = builderPreviewActive(dev?.builderPreview, state.elapsed,
      dev?.builderPreview?.id === state.builderPreview?.id ? state.builderPreview?.startedAt : state.elapsed);
    const manual = Boolean(state.animation || dev?.pose && dev.pose !== "auto" || dev?.showHero === false || dev?.residentPreview || builderRehearsal);
    const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
    const actors: ForestSocialActor[] = occupants.filter(occupant => !occupant.groundFootprint).map(occupant => {
      if (occupant.id === "mochlik") {
        const available = !manual && !exploring() && !forestJourneyWalking(state) && !forestJourneyEnding(state)
          && !cooking && !state.pendingLife && !state.pendingAttention && state.reaction <= 0
          && !state.life.routine && !state.life.garden?.routine && !state.life.garden?.basket?.held
          && !state.fauna.encounter && !state.director.birdwatch && !state.director.campfireVisit && !state.director.tradeVisit
          && ["home", "clearing", "activity"].includes(state.clearing.stage) && ["idle", "blink", "wonder", "scratch", "stretch"].includes(body.pose);
        return { ...occupant, id: "mochlik", visible: !body.residing, available,
          canSpeak: !manual && !body.bush?.occupied && (body.lift ?? 0) <= 0 && (fishing || cooking ? true : body.opacity > .9),
          context: fishing ? "fish" : cooking ? "cook" : body.pose === "sleep" ? "sleep"
            : state.fauna.encounter || state.director.birdwatch ? "animal" : occupant.moving ? "walk" : available ? "idle" : "busy" };
      }
      if (occupant.id === "builder") return { ...occupant, id: "builder", visible: true, canPausePassing: false,
        canSpeak: !builderRehearsal && state.builderMind?.sleepPhase === "awake",
        available: state.builderMind?.sleepPhase === "awake" && !state.builderMind?.job && !state.builderMind?.constructionPending && !state.builderMind?.blocked
          && !state.builderMind?.noticePending && state.builderMind?.action !== "finish",
        context: occupant.moving ? "walk" : state.builderMind?.job ? state.builderMind.ready ? "ready" : state.builderMind.blocked ? "busy" : "build" : "idle" };
      if (occupant.id === "lopukh" || occupant.id === "kamneshmyg" || occupant.id === "leaftail") {
        const mind = state.villagers?.residents[occupant.id], arriving = occupant.id === "kamneshmyg" && state.villagers?.arrivalPhase !== "complete";
        const wildlife = villagerWildlifeHolds(state.villagerWildlife, state.fauna).includes(occupant.id);
        const outside = mind?.doorPhase === "outside";
        const passing = Boolean(mind && !mind.job && mind.intent === "wander" && mind.route && !mind.socialVisit);
        return { ...occupant, id: occupant.id, visible: Boolean(mind?.available && outside), canSpeak: !arriving && outside,
          canPausePassing: passing, socialNeed: mind?.socialNeed,
          available: Boolean(mind?.available && outside && !mind.job && !mind.noticePending && !arriving && !wildlife
            && (passing || mind.socialVisit || socialResidentHeld(occupant.id) || ["idle", "rest", "inspect"].includes(mind.action))),
          context: arriving ? "arrive" : wildlife ? "animal" : occupant.id === "lopukh" && ["haul", "unload"].includes(mind?.woodwork?.phase ?? "") ? "busy"
            : occupant.moving ? "walk" : mind?.action === "work"
            ? occupant.id === "kamneshmyg" ? "mine" : occupant.id === "lopukh" ? "chop" : "trade"
            : mind?.action === "trade" ? "trade" : "idle" };
      }
      return { ...occupant, id: "plesk", visible: true, canSpeak: state.pleskMind?.home.phase === "outside",
        canPausePassing: pleskCanPausePassing(state.pleskMind), canReceiveVisit: pleskCanReceiveVisit(state.pleskMind),
        socialNeed: state.pleskMind?.needs.social,
        available: Boolean(state.pleskMind?.home.phase === "outside" && !state.pleskMind.noticePending && !state.pleskMind.tradePending
          && !residentFaunaEncounter(state.fauna, "plesk") && (pleskAvailableForLeisure(state.pleskMind)
            || pleskCanPausePassing(state.pleskMind) || pleskCanReceiveVisit(state.pleskMind) || socialResidentHeld("plesk")
            || ["approach", "wait"].includes(state.pleskMind.socialVisit?.phase ?? ""))),
        context: residentFaunaEncounter(state.fauna, "plesk") ? "animal" : state.pleskMind?.intent === "fish" ? "fish"
          : state.pleskMind?.intent === "trade" ? "trade" : occupant.moving ? "walk" : "idle" };
    });
    const merchant = state.villagers?.residents.leaftail;
    const window = merchant?.available && merchant.doorPhase === "inside" && !merchant.noticePending
      && dev?.showBuildings !== false ? forestLeaftailWindow(world) : null;
    if (window) actors.push({ id: "leaftail", ...window, visible: true, available: true, canSpeak: true,
      window: true, context: "trade", canReceiveVisit: true, socialNeed: merchant?.socialNeed });
    const animalEvents: NonNullable<ForestSocialEnvironment["animalEvents"]>[number][] = [];
    for (const encounter of [state.fauna.encounter, ...(state.fauna.visitorEncounters ?? [])]) {
      const speaker = encounter?.visitorId ?? "mochlik";
      if (encounter?.phase === "perch" && ["mochlik", "plesk", "lopukh", "kamneshmyg", "leaftail"].includes(speaker))
        animalEvents.push({ id: String(encounter.token), speaker: speaker as ForestSpeaker, kind: encounter.kind });
    }
    const bird = state.director.birdwatch;
    if (bird) animalEvents.push({ id: `${bird.birdId}:${Math.round((state.elapsed - bird.elapsed) * 10)}`, speaker: "mochlik", kind: "bird" });
    const villagerBird = villagerBirdwatchEvent(state.villagerWildlife);
    if (villagerBird) animalEvents.push(villagerBird);
    return { scene: world, builder: state.builderMind, actors, occupants, animalEvents,
      context: { events: state.residentSceneFacts?.events }, ...residentSceneFollowups(state, world, occupants),
      requestVisit: (guest, host, nearby) => guest === "builder" ? requestBuilderVisit(state.builderMind, world, host, nearby)
        : guest === "plesk" ? requestPleskSocialVisit(state.pleskMind, world, host, nearby)
          : Boolean(state.villagers && (guest === "lopukh" || guest === "kamneshmyg" || guest === "leaftail")
            && requestForestVillagerVisit(state.villagers, world, guest, host, nearby)),
      cancelVisit: guest => {
        if (guest === "builder") cancelBuilderVisit(state.builderMind);
        else if (guest === "plesk") cancelPleskSocialVisit(state.pleskMind);
        else if (state.villagers && (guest === "lopukh" || guest === "kamneshmyg" || guest === "leaftail")) cancelForestVillagerVisit(state.villagers, guest);
      },
      visitStatus: guest => {
        if (guest === "builder") return state.builderMind?.socialVisit ? state.builderMind.route ? "approach" : "arrived" : null;
        if (guest === "plesk") return state.pleskMind?.socialVisit?.phase === "approach" ? "approach"
          : state.pleskMind?.socialVisit?.phase === "wait" ? "arrived" : null;
        const mind = guest === "lopukh" || guest === "kamneshmyg" || guest === "leaftail" ? state.villagers?.residents[guest] : null;
        return mind?.socialVisit ? mind.route ? "approach" : "arrived" : null;
      },
      enabled: active() && !manual, ambient: !reducedMotion(options, dev) && (Boolean(options.devRehearsal) || dev?.autoLife !== false),
      rain: environment.rain, dusk: environment.dusk };
  }
  function speechFrames(): ForestSpeechCanvasFrame[] {
    if (disposed || !art) return [];
    const frames = forestSocialFrames(state.social);
    if (!frames.length) return [];
    const actors = socialEnvironment().actors;
    return frames.flatMap(frame => {
      const actor = actors.find(actor => actor.id === frame.speaker && actor.visible && actor.canSpeak !== false && actor.context !== "sleep");
      return actor ? [{ ...frame, anchor: actor.speechAnchor ?? { x: actor.position.x, y: actor.position.y - actor.size * .94 } }] : [];
    });
  }
  function advanceStaticSpeech() {
    if (!reducedMotion(options, dev) || !active() || !session.isOwner()) return;
    const now = performance.now();
    if (staticSpeechAt !== null) advanceForestSocial(state.social, Math.max(0, now - staticSpeechAt) / 1000,
      { ...socialEnvironment(), ambient: false });
    staticSpeechAt = now;
  }
  function noticeSpeech(speaker: ForestSpeaker) {
    if (!active() || !session.isOwner()) return;
    advanceStaticSpeech();
    // A greeting never cancels a meeting, visit or promised followup. The speech
    // director already protects the current line and bounds repeated taps.
    noticeForestSocial(state.social, speaker, socialEnvironment());
    updateAudio(true);
  }
  function stopFishingPreview() {
    if (!state.fishingPreview) return false;
    state.fishingPreview = undefined; syncExploration();
    return true;
  }
  function syncCooking() {
    if (!session.isOwner()) return;
    const selection = dev?.cookingPreview;
    const context = { blocked: exploring() || forestJourneyWalking(state) || forestJourneyEnding(state) || dev?.showHero === false,
      still: reducedMotion(options, dev) };
    if (selection && session.consumeEvent("cooking-preview", selection.id)) startCookingPreview(state, selection, context);
    advanceCookingPreview(state, selection, context);
  }

  function syncGarden() {
    // One visible camera supplies account presentation to the shared session.
    // A background circle may still receive the preceding React snapshot while
    // the world is taking over; it must not overwrite an accepted delivery.
    if (options.economyGarden === undefined || !session.isObservationOwner()) return;
    const garden = state.life.garden, request = options.gardenHarvestRequest;
    if (session.isOwner()) {
      const unmanagedHarvest = garden.production === undefined && (garden.routine?.kind === "harvest-berries" || state.pendingLife === "harvest-berries");
      const managedWork = garden.production !== undefined && (garden.routine?.kind === "harvest-berries" || state.pendingLife === "harvest-berries");
      const interrupted = (garden.harvest || managedWork) && (!garden.harvest
        || garden.harvest.request.jobId !== options.economyGarden?.jobId
        || !request || request.requestId !== garden.harvest.request.requestId);
      if (unmanagedHarvest || interrupted) cancelForestDirector(state, "Урожай синхронизирован с хозяйством");
    }
    syncForestGardenProduction(garden, options.economyGarden, explorationNow());
    // Observation ownership identifies the visible surface even when another
    // browser owns the simulation lease. Background cameras must never veto a
    // live delivery, but an unavailable lease must not leave the UI waiting.
    // A camera handoff can briefly reload the same lease. That is a pause, not
    // permission to finish a live crop before its basket reaches the ground.
    const leaseMode = state.memory.sync?.mode;
    const leaseBlocked = active() && !session.isSimulationAllowed() && (leaseMode === "other-device" || leaseMode === "error");
    if (!session.isOwner() && !leaseBlocked) return;
    // A returned server job can still have a cosmetic walk/tackle ending. That
    // must not delay berry collection or replace the journey's physical route.
    if (request && Number.isSafeInteger(request.requestId) && request.requestId > 0) {
      const fresh = session.consumeEvent("garden-harvest", request.requestId);
      if (fresh || leaseBlocked && garden.harvest?.request.requestId === request.requestId) {
        if (leaseBlocked) {
          cancelForestDirector(state, "Сбор продолжается без анимации на этом устройстве");
          garden.harvestEvent = { ...request, status: "unavailable", reason: "Сбор продолжается без анимации на этом устройстве" };
          garden.harvest = null;
        } else {
          requestForestGardenHarvest(state, request, { ...directorOptions(),
            actorAway: actorAway() || forestJourneyWalking(state) || forestJourneyEnding(state) });
          if (garden.harvest?.request.requestId === request.requestId) {
            advanceCookingPreview(state, null);
            state.reaction = 0; state.animation = null;
            if (dev?.paused || options.paused || dev?.showHero === false || dev?.pose && dev.pose !== "auto") {
              cancelForestDirector(state, "Сбор продолжается без анимации");
            }
          }
        }
      }
    }
    const event = garden.harvestEvent;
    if (event && options.onGardenHarvestEvent && session.consumeEvent(
      event.status === "started" ? "garden-harvest-started" : "garden-harvest-result", event.requestId)) {
      const deliver = options.onGardenHarvestEvent;
      // A snapshot may arrive inside React configuration. Emit outside that
      // stack, once for the shared session rather than once per camera.
      // A camera can unmount during this microtask (world → circle). The
      // account controller still receives its completed, already-authorized
      // request; disposing a canvas must not swallow the delivery event.
      queueMicrotask(() => deliver(event));
    }
  }

  function connect(timestamp = Number.isFinite(options.serverNow) ? options.serverNow! : Date.now(), allowPersistence = true) {
    const timing = forestPerformanceProfiler.begin("ai", options.devRehearsal ? "rehearsal" : "world");
    try {
    const connected = connectForestSession(options.presenceKey, world, options.view ?? "circle",
      timestamp, Number(options.dusk), ownerChanged => {
        if (disposed) return;
        if (ownerChanged) stop();
        updateAudio();
        if (visible()) draw();
        if (ownerChanged) resume();
      }, { persistence: allowPersistence && !options.devRehearsal && !forestPersistenceOverridden(dev, levels),
        sync: options.devRehearsal ? false : undefined,
        awaitBuilderConstruction: options.economyConstruction !== undefined });
    if (!allowPersistence || options.devRehearsal || forestPersistenceOverridden(dev, levels)) connected.suspendPersistence();
    return connected;
    } finally { forestPerformanceProfiler.end(timing); }
  }
  function clearingMustContinue() {
    const current = clearingActivityFrame(state.clearing);
    const gathering = forestJourneyGatheringFrame(state, world);
    return Boolean(state.pendingLife || state.cookingPreview || state.director.birdwatch || state.director.campfireVisit || state.director.tradeVisit || state.life.garden?.routine || state.clearing.retiring || state.clearing.bushEffect?.bursts.length || forestJourneyWalking(state) || state.journeyTravel?.phase === "fishing" || state.journeyTravel?.mining || gathering && gathering.action !== "ready")
      || current.attention || dev?.showBuildings === false && current.residing;
  }
  function birdBase() {
    const atmosphere = atmosphereOptions(options, state.timestamp, state.dusk, { state: dev,
      birdElapsed: state.birdStarted === null ? undefined : state.elapsed - state.birdStarted,
      birdSeed: state.birdStarted === null ? undefined : state.birdSeed });
    const environment = forestAtmosphereState(world, atmosphere);
    return forestBirdFrame(world, { ...atmosphere, elapsed: state.elapsed, dusk: environment.dusk, rain: environment.rain });
  }
  function visibleBirds() {
    return applyBirdReactions(state.birdReactions, birdBase(), dev?.birds !== "off" && !reducedMotion(options, dev));
  }
  function directorOptions(blocked = false): ForestDirectorOptions {
    const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
    const cooking = state.cookingPreview;
    const visitors = faunaVisitors();
    const watchedBird = state.villagerWildlife?.birdwatch?.watch.birdId;
    return { autoLife: !options.devRehearsal && !cooking && dev?.autoLife !== false, blocked: blocked || Boolean(forestSocialHolding(state.social)) || exploring() || forestJourneyWalking(state) || forestJourneyEnding(state) || Boolean(forestJourneyGatheringFrame(state, world))
      || Boolean(cooking && cooking.startedAt !== null), actorAway: actorAway(),
      explicitTravel: !blocked && (forestJourneyWalking(state) || Boolean(cooking && cooking.startedAt === null)
        || Boolean(options.devRehearsal && state.clearing.requestedPoint)), dusk: environment.dusk, rain: environment.rain,
      homeAvailable: dev?.showBuildings !== false, butterflies: dev?.butterflies, fireflies: dev?.fireflies,
      tutorialActive: Boolean(options.tutorialActive && !options.devRehearsal),
      reducedMotion: reducedMotion(options, dev), navigationMode: dev?.navigationMode, heroScale: dev?.heroScale,
      birds: visibleBirds().filter(bird => !watchedBird || bird.id !== watchedBird), visitors,
      occupants: residentOccupants() };
  }
  function preview(): NewMapPaintPreview {
    syncProduction();
    syncConstruction();
    syncVillagers();
    const path = dev?.debugNavigation ? clearingNavigationFrame(state.clearing) : null;
    const cooking = cookingPreviewFrame(state, dev?.cookingPreview, reducedMotion(options, dev));
    const partner = socialPartnerPosition("mochlik");
    return { scene: world, water: dev?.waterSurface === false ? undefined : state.water, trees, state: dev, visuals, animation: state.animation, life: state.life, wetness: state.wetness, actorAway: actorAway(),
      residents: residentFrames().map(resident => resident.id === "plesk"
        ? withForestWaterBuoyancy(resident, dev?.waterSurface === false ? undefined : state.water, reducedMotion(options, dev)) : resident),
      fishing: forestJourneyFishingFrame(state, world, reducedMotion(options, dev)),
      gathering: gatheringAtSize(forestJourneyGatheringFrame(state, world, reducedMotion(options, dev)), state.clearing.size * (dev?.heroScale ?? 1)),
      builderSleeping: builderSleepIndicator(state.builderMind, world),
      residentPresentation: residentScenePresentation(state, world),
      merchantBoat: state.leaftailBoat ? leaftailBoatArrivalFrame(state.leaftailBoat) : null,
      mining: forestJourneyMiningFrame(state,world,reducedMotion(options,dev)),
      cooking: cooking ? { ...cooking, direction: dev?.direction ?? cooking.direction } : null,
      productions: forestProductionFrames(state.economyProduction, world, visuals, explorationNow(), state.elapsed, dev?.showBuildings !== false),
      fauna: state.fauna, birdFrame: visibleBirds(), birdwatch: state.director.birdwatch, campfireVisit: state.director.campfireVisit, tradeVisit: forestTradeVisitFrame(state),
      livingDebug: dev?.debugNavigation || dev?.debugFauna ? {
        debugNavigation: dev.debugNavigation, debugFauna: dev.debugFauna, nav: state.clearing.navigation,
        position: state.clearing.position, path: path?.path, target: path?.target, activity: path?.activity,
        reason: `${state.director.reason}${path?.reason ? ` · ${path.reason}` : ""}`,
        fauna: state.fauna.entities, encounter: state.fauna.encounter } : undefined,
      clearing: { ...clearingActivityFrame(state.clearing, { still: reducedMotion(options, dev) || dev?.autoLife === false && !clearingMustContinue() }),
        ...(partner ? { direction: builderDirection(partner.x - state.clearing.position.x, partner.y - state.clearing.position.y) } : {}) },
      birdElapsed: state.birdStarted === null ? undefined : state.elapsed - state.birdStarted,
      birdSeed: state.birdStarted === null ? undefined : state.birdSeed };
  }
  function paintWorld(target: CanvasRenderingContext2D) {
    if (!disposed && art) {
      syncGarden();
      paintNewMap(target, art, options, state.elapsed, state.reaction > 0, state.timestamp, state.dusk, preview());
      if (WORLD_DEV_ENABLED && audioDevStore.getSnapshot().showSources) drawWorldAudioDebug(target, world, audio.getFrame());
    }
  }
  function draw() {
    if (disposed || !art) return;
    updateObservation();
    if (options.view !== "world") {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / NEW_MAP_FOCUS.width, 0, 0, canvas.height / NEW_MAP_FOCUS.height, 0, 0);
      ctx.translate(-NEW_MAP_FOCUS.x, -NEW_MAP_FOCUS.y);
      paintWorld(ctx);
      const size = canvas.clientWidth || 256, verticalInset = size * .15;
      // An inscribed rectangle leaves more room beside the head than equal
      // insets while keeping every corner inside the circular canvas clip.
      const radius = size / 2, verticalEdge = Math.max(0, radius - verticalInset - 8);
      const horizontalInset = Math.max(0, radius - Math.sqrt(Math.max(0, radius * radius - verticalEdge * verticalEdge)) - 8);
      ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);
      drawForestSpeech(ctx, speechFrames().map(frame => ({ ...frame, anchor: {
        x: (frame.anchor.x - NEW_MAP_FOCUS.x) / NEW_MAP_FOCUS.width * size,
        y: (frame.anchor.y - NEW_MAP_FOCUS.y) / NEW_MAP_FOCUS.height * size } })),
      { width: size, height: size, insets: { left: horizontalInset, right: horizontalInset, top: verticalInset, bottom: verticalInset },
        reducedMotion: reducedMotion(options, dev), night: options.dusk });
    }
    const activity = !exploring() && (state.reaction > 0 || state.pendingAttention || clearingActivityFrame(state.clearing).attention) ? "greet" : "idle";
    if (lastActivity !== activity) { lastActivity = activity; callbacks.activity(activity); }
    callbacks.rendered?.();
  }
  function visible() { return !disposed && !options.backgrounded && !document.hidden; }
  function active() { return visible() && Boolean(art) && !options.paused && !dev?.paused; }
  function updateObservation(force = false) {
    if (!art || !session.isObservationOwner()) return;
    publishForestObservation(options.presenceKey, state, { force,
      exploration: forestJourneyWalking(state) || state.journeyTravel?.phase === "fishing" ? state.director.reason
        : exploring() ? options.economyJourney?.label || "Мохлик исследует окрестности и вернётся после завершения поручения." : null,
      paused: !active() || !session.isSimulationAllowed() || reducedMotion(options, dev) || dev?.autoLife === false && !clearingMustContinue(),
      manual: Boolean(state.animation || state.cookingPreview || dev?.pose && dev.pose !== "auto" || dev?.showHero === false) });
  }
  function startFishingPreview(id: number) {
    if (!session.consumeEvent("fishing-preview", id) || economyJourneyAway(options.economyJourney, explorationNow())) return;
    // A rehearsal always demonstrates the approach, including after mounting.
    if (state.explorationId === undefined) state.explorationId = null;
    state.fishingPreview = { id, startedAt: state.elapsed };
  }
  function syncOwner() {
    const timing = forestPerformanceProfiler.begin("ai", options.devRehearsal ? "rehearsal" : "world");
    try {
    session.configure(options.view ?? "circle", active(), true);
    if (WORLD_DEV_ENABLED && session.isOwner()) {
      const resident = dev?.residentPreview;
      if (resident && state.residentPreview?.id !== resident.id) {
        state.residentPreview = { id: resident.id, startedAt: state.elapsed };
      }
      const builder = dev?.builderPreview;
      if (builder && state.builderPreview?.id !== builder.id) {
        state.builderPreview = { id: builder.id, startedAt: state.elapsed };
      }
      if (dev?.scenarioEvent?.kind === "fishing" && !dev.lifeEvent) startFishingPreview(dev.scenarioEvent.id);
    }
    syncProduction(); syncConstruction(); syncVillagers(); syncExploration(); syncGarden(); syncCooking();
    if (WORLD_DEV_ENABLED && options.devRehearsal && art && session.isOwner()) {
      const feedback = syncForestSceneRehearsal(state, world, options.devRehearsal, rehearsalEnvironment());
      if (feedback) worldDevStore.reportScene(feedback.id, feedback.phase, feedback.message);
    }
    if (session.isOwner()) {
      residentSceneSocialContext(state, explorationNow());
      advanceForestSocial(state.social, 0, socialEnvironment());
      reportResidents();
    }
    updateObservation(true);
    updateAudio();
    } finally { forestPerformanceProfiler.end(timing); }
  }
  function rehearsalEnvironment() {
    return { social: socialEnvironment(), occupants: residentOccupants(), birds: visibleBirds(), now: explorationNow(),
      paused: !active() || !session.isOwner(), reducedMotion: reducedMotion(options, dev), director: directorOptions() };
  }
  function cancelReactionTimer() {
    if (reactionTimer !== null) { clearTimeout(reactionTimer); reactionTimer = null; }
  }
  function stop() {
    advanceStaticSpeech();
    cancelAnimationFrame(frame); frame = 0; previous = 0; cancelReactionTimer();
    if (speechTimer !== null) { clearTimeout(speechTimer); speechTimer = null; }
    staticSpeechAt = null;
  }
  function tick(now: number) {
    frame = 0;
    if (!active() || !session.isOwner() || reducedMotion(options, dev)) return;
    if (options.devRehearsal && state.devSceneRehearsal && ["complete", "blocked", "stopped"].includes(state.devSceneRehearsal.preview.phase)) return;
    if (!previous) previous = now;
    if (worldFrameDue(now, previous)) {
      const step = Math.min((now - previous) / 1000, .05);
      state.elapsed += step; state.timestamp += step * 1000;
      if (state.birdStarted !== null && state.elapsed - state.birdStarted >= FOREST_BIRD_FLIGHT_DURATION) state.birdStarted = null;
      state.dusk += (Number(options.dusk) - state.dusk) * Math.min(1, step * .7);
      if (state.animation) { state.animation.elapsed += step; if (state.animation.elapsed >= REACTION_SECONDS) state.animation = null; }
      state.reaction = Math.max(0, state.reaction - step);
      const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
      state.wetness = updateForestWetness(state.wetness, environment.rain, step);
      const aiTiming = forestPerformanceProfiler.begin("ai", options.devRehearsal ? "rehearsal" : "world");
      try {
      syncConstruction(); syncVillagers(); syncExploration(); syncGarden(); syncCooking();
      residentSceneSocialContext(state, explorationNow());
      advanceForestSocial(state.social, step, socialEnvironment());
      advanceSceneMerchantArrival(state, step, residentOccupants());
      advanceVillagers(step, environment.rain, environment.dusk);
      advanceBuilder(step);
      if (state.pleskMind) {
        const resident = pleskMindFrame(state.pleskMind, world, false);
        advancePleskMind(state.pleskMind, world, step, { rain: environment.rain, dusk: environment.dusk, occupants: residentOccupants(),
          socialHold: socialResidentHeld("plesk"),
          socialPartnerId: state.social.meeting?.host === "plesk" ? state.social.meeting.guest
            : state.social.meeting?.guest === "plesk" ? state.social.meeting.host : undefined,
          wildlife: !dev?.residentPreview && Boolean(residentFaunaEncounter(state.fauna, "plesk")
            && !["interrupt", "release"].includes(residentFaunaEncounter(state.fauna, "plesk")!.phase)),
          playerNear: Boolean(resident && !actorAway() && dev?.showHero !== false
            && Math.hypot(resident.x - state.clearing.position.x, resident.y - state.clearing.position.y) < 90) });
      }
      const manual = Boolean(state.animation || state.reaction > 0 || dev?.pose && dev.pose !== "auto" || dev?.showHero === false);
      advanceForestDirector(state, step, directorOptions(manual));
      } finally { forestPerformanceProfiler.end(aiTiming); }
      const stimulus = state.director.stimulus;
      const resident = state.pleskMind ? pleskMindFrame(state.pleskMind, world, false) : null;
      const birdVisitors = [
        ...(actorAway() || dev?.showHero === false || clearingActivityFrame(state.clearing).residing ? []
          : [{ ...state.clearing.position, size: state.clearing.size * (dev?.heroScale ?? 1), moving: clearingActivityFrame(state.clearing).pose === "walk" }]),
        ...(resident && (resident.opacity ?? 1) > .05 ? [{ x: resident.x, y: resident.y, size: resident.size, moving: resident.action === "walk" }] : []),
        ...(state.villagers ? forestVillagerFrames(state.villagers).filter(frame => (frame.opacity ?? 1) > .05).map(frame => ({ x: frame.x, y: frame.y,
          size: frame.size, moving: Boolean(state.villagers?.residents[frame.id].route) })) : []),
      ];
      advanceBirdReactions(state.birdReactions, birdBase(), step, stimulus && stimulus.id !== state.lastBirdStimulus
        ? { kind: stimulus.kind === "rustle" ? "bush-rustle" : "footstep", position: stimulus, intensity: stimulus.strength,
          foliage: stimulus.foliage }
        : undefined, world, birdVisitors,
        { rain: environment.rain, dusk: environment.dusk, forced: state.birdStarted !== null || dev?.birds === "on" });
      if (stimulus) state.lastBirdStimulus = stimulus.id;
      advanceWater(step, environment);
      advanceForestTreeInteractions(trees, step);
      if (WORLD_DEV_ENABLED && options.devRehearsal) {
        const feedback = advanceForestSceneRehearsal(state, world, step, rehearsalEnvironment());
        if (feedback) worldDevStore.reportScene(feedback.id, feedback.phase, feedback.message);
      }
      updateAudio(true);
      reportResidents();
      previous = now; session.publish();
    }
    if (active() && session.isOwner()) frame = requestAnimationFrame(tick);
  }
  function resume() {
    syncOwner();
    if (!active() || !session.isOwner() || reducedMotion(options, dev)) clearForestTreeInteractions(trees);
    if (!active() || !session.isOwner()) return;
    waterContacts(false);
    applyPendingTime();
    if (reducedMotion(options, dev)) {
      advanceStaticSpeech();
      const speech = forestSocialFrames(state.social)[0];
      if (speech && speechTimer === null) {
        const social = state.social;
        speechTimer = setTimeout(() => {
          speechTimer = null;
          if (!active() || !session.isOwner()) return;
          advanceStaticSpeech();
          // This is the captured line's expiry, not a recurring simulation
          // timer. Hydration/new speech cannot be expired by an old callback.
          if (state.social === social && social.current?.id === speech.id) {
            advanceForestSocial(social, Math.max(0, speech.duration - social.current.elapsed) + 1e-6,
              { ...socialEnvironment(), ambient: false });
          }
          session.publish(); resume();
        }, Math.max(1, (speech.duration - speech.elapsed) * 1000));
      }
      const remaining = Math.max(state.reaction, state.animation ? REACTION_SECONDS - state.animation.elapsed : 0);
      if (remaining > 0 && reactionTimer === null) {
        reactionTimer = setTimeout(() => {
          reactionTimer = null;
          if (!active() || !session.isOwner()) return;
          state.reaction = 0; state.animation = null; session.publish();
        }, remaining * 1000);
      }
    } else if (!frame) { previous = 0; frame = requestAnimationFrame(tick); }
  }
  function applyPendingTime() {
    if (pendingTimestamp !== null && session.isOwner()) { state.timestamp = Math.max(state.timestamp, pendingTimestamp); pendingTimestamp = null; }
  }
  function resize() {
    const next = options.view === "world" ? 1 : Math.min(1024, Math.max(256,
      Math.round((canvas.clientWidth || 256) * Math.min(window.devicePixelRatio || 1, 3))));
    if (canvas.width !== next || canvas.height !== next) { canvas.width = next; canvas.height = next; draw(); }
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  const unsubscribeLightingEditor = WORLD_DEV_ENABLED ? worldLightingEditorStore.subscribe(() => { if (visible()) draw(); }) : () => {};
  const unsubscribeAudioDebug = WORLD_DEV_ENABLED ? audioDevStore.subscribe(() => { if (visible()) draw(); }) : () => {};
  function visibilityChanged() { stop(); syncOwner(); if (visible()) draw(); resume(); }
  document.addEventListener("visibilitychange", visibilityChanged);
  function dispose() {
    if (disposed) return;
    disposed = true; artworkVersion++; stop(); clearForestTreeInteractions(trees); unsubscribe(); unsubscribeAudioDebug(); unsubscribeLightingEditor(); audio.dispose(); observer.disconnect(); art = null;
    residentDiagnosticsStore.clear(options.presenceKey ?? "forest", residentDiagnosticsOwner);
    document.removeEventListener("visibilitychange", visibilityChanged); session.release({ retain: !options.devRehearsal });
  }
  function prepareArtwork() {
    const selected = accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings);
    const nextWorld = previewWorldScene(TILED_WORLD, selected);
    const next = visualsFor(selected), urls = worldArtworkUrls(nextWorld, next);
    const key = JSON.stringify([options.view ?? "circle", Object.entries(next).map(([id, visual]) => [id, visual.level, visual.image])]);
    if (key === requestedKey) return;
    requestedKey = key;
    const version = ++artworkVersion;
    // A first circle needs only its visible artwork. Full-map entry and every
    // later geometry replacement still require a complete atomic scene.
    const required = art === null && options.view !== "world" ? worldArtworkUrls(nextWorld, next, nextWorld.focus) : urls;
    const background = urls.filter(url => !required.includes(url));
    const load = async (url: string, priority: "high" | "low" = "high") => {
      const image = await loadHabitatImage(url, priority);
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error("Invalid world artwork dimensions");
      return [url, image] as const;
    };
    void Promise.all(required.map(url => load(url))).then(images => {
      if (disposed || version !== artworkVersion) return;
      const first = art === null;
      // Commit artwork and its geometry together; stale/failed loads retain the
      // previous usable scene, including its navigation and indoor resident.
      if (world !== nextWorld) {
        const changed = forestSceneFingerprint(world) !== forestSceneFingerprint(nextWorld);
        world = nextWorld;
        trees = createForestTreeInteractions(world);
        if (changed) {
          const timestamp = state.timestamp;
          const persistence = !forestPersistenceOverridden(dev, levels);
          stop();
          if (persistence) session.saveMemory(); else session.suspendPersistence();
          const production = state.economyProduction, construction = state.economyConstruction, builder = state.builderMind, plesk = state.pleskMind,
            residents = state.economyResidents, villagers = state.villagers, merchant = state.leaftailBoat, facts = state.residentSceneFacts;
          session.release();
          session = connect(timestamp, persistence); state = session.state;
          const freshBuilder = !state.economyConstruction && (!state.builderMind
            || state.builderMind.elapsed === 0 && !state.builderMind.jobKey);
          const freshVillagers = !state.villagers?.confirmed;
          // Loaded geometry changes the forest fingerprint, not the economic
          // revision fence. Preserve removals across artwork/camera handoffs.
          syncForestProduction(state, production);
          syncForestConstruction(state, construction);
          syncForestResidentAccess(state, residents);
          if (plesk && session.created) state.pleskMind = rehydratePleskMind(world, plesk);
          if (villagers && freshVillagers) {
            state.villagers = rehydrateForestVillagers(world, villagers, explorationNow());
            if (merchant && !state.leaftailBoat) state.leaftailBoat = { ...merchant, position: { ...merchant.position } };
            if (facts && !state.residentSceneFacts) state.residentSceneFacts = { ...facts, buildings: { ...facts.buildings }, jobs: new Map(facts.jobs), events: facts.events.map(event => ({ ...event })) };
          }
          // Seed only a new session. Never replace a live camera's builder or
          // share mutable feet/clocks with a background view of old geometry.
          // Targets and route geometry are immutable; progress lives on mind.
          if (builder && freshBuilder) {
            state.builderMind = { ...builder, position: { ...builder.position },
              idleAvoid: builder.idleAvoid ? { ...builder.idleAvoid } : null };
            if (state.builderMind.socialVisit) cancelForestSocial(state.social, { ...socialEnvironment(), builder: state.builderMind });
          }
        }
      }
      const committed = new Map(images);
      art = committed; visuals = next; syncOwner();
      if (WORLD_DEV_ENABLED) worldDevStore.reportArtError(null);
      if (visible()) draw();
      if (first) callbacks.ready();
      resume();
      if (disposed || version !== artworkVersion || !background.length) return;
      // Start optional downloads only after ready. A failed remote building
      // cannot take down the usable circle; a full-map mount retries through
      // the shared image cache, which removes failed requests.
      void Promise.allSettled(background.map(url => load(url, "low"))).then(results => {
        if (disposed || version !== artworkVersion) return;
        for (const result of results) if (result.status === "fulfilled") committed.set(...result.value);
        if (visible()) draw();
      });
    }).catch(error => {
      if (disposed || version !== artworkVersion) return;
      requestedKey = null;
      if (art) {
        if (WORLD_DEV_ENABLED) worldDevStore.reportArtError("Не удалось загрузить рисунок здания. Предыдущий вид сохранён; выберите другой уровень и повторите.");
      } else { dispose(); callbacks.failure(error); }
    });
  }
  function requestLife(kind: WorldDevLifeAction) {
    if (exploring() || forestJourneyEnding(state)) return;
    state.reaction = 0;
    requestForestDirective(state, kind, directorOptions());
  }
  if (WORLD_DEV_ENABLED) unsubscribe = worldDevStore.subscribe(() => {
    if (disposed) return;
    const before = dev!;
    dev = worldDevStore.getSnapshot();
    if (forestPersistenceOverridden(dev, levels)) session.suspendPersistence();
    if (session.consumeControls(dev)) {
      if ((dev.animation?.id !== before.animation?.id && dev.animation || dev.pose !== before.pose && dev.pose !== "auto")
        && clearingActivityFrame(state.clearing).bush?.occupied) noticeClearingActivity(state.clearing, { still: true });
      if (dev.animation?.id !== before.animation?.id) {
        if (!dev.animation) state.animation = null;
        else if (session.consumeEvent("pose", dev.animation.id)) state.animation = { pose: dev.animation.pose, elapsed: 0 };
        cancelForestDirector(state);
      }
      if (dev.birdEvent !== before.birdEvent) {
        if (!dev.birdEvent) state.birdStarted = null;
        else if (session.consumeEvent("birds", dev.birdEvent)) { state.birdStarted = state.elapsed; state.birdSeed += 1; }
      }
      if (dev.pose !== before.pose || dev.autoLife === false && before.autoLife || dev.showHero === false
        || state.fauna.encounter?.kind === "butterfly" && dev.butterflies === "off"
        || (state.fauna.encounter?.kind === "firefly" || state.pendingLife === "firefly") && dev.fireflies === "off"
        || state.pendingLife === "butterfly" && dev.butterflies === "off") {
        cancelForestDirector(state);
      }
      if (dev.residentPreview?.id !== before.residentPreview?.id) {
        if (!dev.residentPreview) state.residentPreview = undefined;
        else if (session.consumeEvent("resident", dev.residentPreview.id)) {
          state.residentPreview = { id: dev.residentPreview.id, startedAt: state.elapsed };
        }
      }
      if (dev.builderPreview?.id !== before.builderPreview?.id) {
        if (!dev.builderPreview) state.builderPreview = undefined;
        else if (session.consumeEvent("builder-preview", dev.builderPreview.id)) {
          state.builderPreview = { id: dev.builderPreview.id, startedAt: state.elapsed };
        }
      }
      if (dev.lifeEvent?.id !== before.lifeEvent?.id) {
        if (!dev.lifeEvent) { cancelForestDirector(state); }
        else if (session.consumeEvent("life", dev.lifeEvent.id)) {
          const stopped = stopFishingPreview();
          if (!(stopped && dev.lifeEvent.kind === "idle")) requestLife(dev.lifeEvent.kind);
        }
      }
      if (dev.scenarioEvent?.id !== before.scenarioEvent?.id && dev.scenarioEvent
        && session.consumeEvent("scenario", dev.scenarioEvent.id)) {
        const kind = dev.scenarioEvent.kind;
        if (kind === "fishing") {
          startFishingPreview(dev.scenarioEvent.id); syncExploration();
        } else if (kind !== "plesk") {
          stopFishingPreview();
          // DEV scenery cannot cancel a confirmed journey or its safe return.
          if (!exploring() && !forestJourneyWalking(state) && !forestJourneyEnding(state)) applyForestDevScenario(state, kind, directorOptions());
        }
      } else if (!dev.scenarioEvent && before.scenarioEvent) {
        stopFishingPreview();
        if (!forestJourneyWalking(state) && !forestJourneyEnding(state)) cancelForestDirector(state);
        state.birdStarted = null;
      }
    }
    stop(); syncOwner();
    if (reducedMotion(options, dev)) state.dusk = Number(options.dusk);
    if (active()) applyPendingTime();
    if (visible()) draw();
    if (dev.levels !== before.levels || dev.previewBuildings !== before.previewBuildings) prepareArtwork();
    resume();
  });
  prepareArtwork();
  void loadForestSpeechFont().then(loaded => {
    // A still scene has no RAF: repaint once when its actual glyph metrics arrive.
    if (loaded && visible()) draw();
  });
  function notice(preserveActivity = true) {
    if (disposed || !session.isSimulationAllowed()) return;
    noticeSpeech("mochlik");
    if (active()) session.publish();
    resume();
    if (exploring() || forestJourneyEnding(state) || !session.isSimulationAllowed()) return;
    if (noticeCookingPreview(state, dev?.cookingPreview)) {
      if (active()) session.publish();
      resume(); return;
    }
    const still = reducedMotion(options, dev), manualPose = Boolean(state.animation || dev?.pose && dev.pose !== "auto");
    const preservedActivity = noticeForestDirector(state, still || manualPose, { preserveActivity });
    // Static accessibility / explicit DEV poses use a bounded feedback timer.
    if (!preservedActivity && (still || manualPose) && state.reaction <= 0) state.reaction = REACTION_SECONDS;
    if (active()) session.publish(); resume();
  }
  function hitVisiblePet(x: number, y: number) {
    if (disposed || actorAway() || dev?.showHero === false) return false;
    const point = { x: NEW_MAP_FOCUS.x + x * NEW_MAP_FOCUS.width, y: NEW_MAP_FOCUS.y + y * NEW_MAP_FOCUS.height };
    const size = PET_SIZE * (dev?.heroScale ?? 1), actor = clearingActivityFrame(state.clearing);
    const bush = actor.bush?.occlude && world.bushes?.find(item => item.id === actor.bush!.id);
    if (bush && pointInPolygon(point, bush.points)) return false;
    if (forestPointOccluded(world, actor.y, point)) return false;
    const feetY = actor.y - (actor.lift ?? 0);
    return actor.opacity > 0 && Math.abs(point.x - actor.x) < size / 2
      && point.y > feetY - size && point.y < feetY;
  }
  const lightingWorld = () => WORLD_DEV_ENABLED ? worldLightingEditorStore.applyToScene(world,
    accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings)) : world;
  return {
    lightingReceivers: () => lightingWorld().shadowReceivers ?? [],
    lightingCasters: () => lightingWorld().shadowCasters ?? [],
    lightingLights: () => {
      const edited = lightingWorld();
      const disabled = new Set(edited.lights?.filter(light => light.enabled === false).map(light => light.id));
      // Disabled authored lamps retain their effective artwork anchor in the editor.
      const inspectable = disabled.size ? { ...edited, lights: edited.lights?.map(light => disabled.has(light.id) ? { ...light, enabled: true } : light) } : edited;
      const sources = forestLightSources(inspectable, { showBuildings: dev?.showBuildings,
        levels: accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings) })
        .map(light => ({ ...light, height: forestShadowLightHeight(edited, light), ...(disabled.has(light.id) ? { enabled: false } : {}) }));
      if (WORLD_DEV_ENABLED) worldLightingEditorStore.setLightProjections(sources.map(light => ({ id: light.id, position: light.position, height: light.height })));
      return sources;
    },
    disturbTree(point) {
      if (disposed || !active() || !session.isOwner() || options.view !== "world" || !hitForestTree(trees, point)
        || dev?.showBuildings !== false && forestVisibleSiteAt(world, point)) return false;
      const contact = touchForestTree(trees, point, { now: performance.now() / 1000, reducedMotion: reducedMotion(options, dev) });
      if (contact) { audio.touchTree(contact.point); session.publish(); }
      return true;
    },
    disturbWater(point) {
      if (disposed || !active() || !session.isOwner() || reducedMotion(options, dev)
        || dev?.waterSurface === false || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || !isForestWater(world, point) || forestVisibleSiteAt(world, point)
        || forestPointOccluded(world, point.y, point)) return false;
      if (!touchForestWater(ensureWater(), point)) return false;
      audio.touchWater(point);
      session.publish();
      return true;
    },
    setAudioCamera(camera) {
      if (disposed || audioCamera && audioCamera.x === camera.x && audioCamera.y === camera.y
        && audioCamera.zoom === camera.zoom && audioCamera.viewportWidth === camera.viewportWidth
        && audioCamera.viewportHeight === camera.viewportHeight) return;
      audioCamera = { ...camera };
      updateAudio();
    },
    position: () => {
      const actor = clearingActivityFrame(state.clearing);
      return { x: actor.x, y: actor.y - PET_SIZE * (dev?.heroScale ?? 1) / 2 };
    },
    configure(next) {
      if (disposed) return;
      const identityChanged = next.presenceKey !== options.presenceKey;
      options = { ...next }; stop();
      if (identityChanged) clearForestTreeInteractions(trees);
      if (Number.isFinite(next.serverNow) && (identityChanged || next.serverNow !== configuredTimestamp)) setEconomicTime(next.serverNow!);
      if (identityChanged) { session.release(); session = connect(); state = session.state; pendingTimestamp = null; }
      syncOwner();
      if (reducedMotion(options, dev)) state.dusk = Number(options.dusk);
      // Visibility reuses old options; keep any newer setTime sample until resume.
      if (Number.isFinite(next.serverNow) && next.serverNow !== configuredTimestamp) {
        configuredTimestamp = next.serverNow!; pendingTimestamp = configuredTimestamp;
      }
      if (active()) applyPendingTime();
      prepareArtwork(); resize(); if (active()) draw(); resume();
    },
    notice: () => notice(),
    wakeHomeResident() {
      if (disposed || exploring() || dev?.showHero === false || dev?.showBuildings === false
        || !session.isSimulationAllowed() || !["entering", "home-sleep"].includes(state.clearing.stage)) return false;
      // A deliberate home wake reverses an unfinished entry; body taps keep its route.
      notice(false);
      return true;
    },
    hitPet(x, y) {
      const point = { x: NEW_MAP_FOCUS.x + x * NEW_MAP_FOCUS.width, y: NEW_MAP_FOCUS.y + y * NEW_MAP_FOCUS.height };
      const actor = clearingActivityFrame(state.clearing);
      if (disposed || actorAway() || dev?.showHero === false) return false;
      const home = world.sites.find(site => site.id === "home");
      if (actor.residing && home && dev?.showBuildings !== false && pointInPolygon(point, home.hitArea)) return true;
      const bush = actor.bush?.occupied && world.bushes?.find(item => item.id === actor.bush!.id);
      if (bush && pointInPolygon(point, bush.points)) return true;
      return hitVisiblePet(x, y);
    },
    hitVisiblePet,
    hitResident(x, y) {
      if (disposed || !art) return null;
      const point = { x, y }, still = reducedMotion(options, dev);
      const residents = residentFrames(), id = forestResidentAt(world, state.elapsed, still, point, residents);
      const resident = residents.find(resident => resident.id === id);
      if (!resident) return null;
      const actor = clearingActivityFrame(state.clearing);
      if (actor.y > resident.y && hitVisiblePet((x - NEW_MAP_FOCUS.x) / NEW_MAP_FOCUS.width,
        (y - NEW_MAP_FOCUS.y) / NEW_MAP_FOCUS.height)) return null;
      return id;
    },
    merchantArrivalPoint() {
      const frame = state.leaftailBoat && leaftailBoatArrivalFrame(state.leaftailBoat);
      return frame ? { x: frame.resident.x, y: frame.resident.y, size: frame.phase === "sailing" ? 64 : frame.resident.size } : null;
    },
    residentArrivalPoint() {
      const resident = residentFrames().find(resident => resident.id === "kamneshmyg" && "arriving" in resident && resident.arriving);
      return resident ? { x: resident.x, y: resident.y, size: resident.size } : null;
    },
    noticeResident(id) {
      if (disposed || !session.isOwner()) return;
      noticeSpeech(id);
      const encounter = residentFaunaEncounter(state.fauna, id);
      const meeting = state.social.meeting, followup = state.social.followup;
      const held = socialResidentHeld(id) || Boolean(meeting && (meeting.guest === id || meeting.host === id))
        || Boolean(followup && (followup.speaker === id || followup.host === id))
        || Boolean(encounter && !["interrupt", "release"].includes(encounter.phase))
        || Boolean((id === "lopukh" || id === "kamneshmyg" || id === "leaftail")
          && villagerWildlifeHolds(state.villagerWildlife, state.fauna).includes(id));
      if (!held) {
        if (id === "builder") noticeBuilderMind(state.builderMind, { preserveActivity: true });
        else if (id === "plesk") noticePleskMind(state.pleskMind, { preserveActivity: true });
        else if (state.villagers && (id === "lopukh" || id === "kamneshmyg" || id === "leaftail")) noticeForestVillager(state.villagers, id, { preserveActivity: true });
      }
      reconcileWildlife();
      updateObservation(true); session.publish(); resume();
    },
    visitTradingPlace(id) {
      if (disposed || id !== "plesk" || !art || dev?.showBuildings === false || !session.isOwner()
        || reducedMotion(options, dev) || !world.sites.some(site => site.id === "plesk-shop")) return;
      cancelForestSocial(state.social, socialEnvironment());
      requestPleskTrade(state.pleskMind);
      if (dev?.showHero !== false) requestForestTradeVisit(state, world, directorOptions(Boolean(dev?.pose && dev.pose !== "auto")));
      updateObservation(true); session.publish(); resume();
    },
    inspectPoint(target) {
      if (disposed || !art) return null;
      if (target === "leaftail") {
        const arrival = state.leaftailBoat && leaftailBoatArrivalFrame(state.leaftailBoat);
        if (arrival) return { x: arrival.resident.x, y: arrival.resident.y - arrival.resident.size / 2 };
      }
      const resident = residentFrames().find(resident => resident.id === target);
      if (resident) return { x: resident.x, y: resident.y - resident.size / 2 };
      const builderHome = target === "builder" ? world.sites.find(site => site.id === "builder-home") : null;
      if (builderHome) return builderHome.anchor;
      const shore = target === "fishing" ? forestTrailDestination(world, "fishing") : null;
      return shore ? { x: shore.x, y: shore.y - PET_SIZE / 2 } : null;
    },
    hitSite(point) {
      if (disposed || !art || dev?.showBuildings === false) return null;
      return forestVisibleSiteAt(world, point)?.id ?? null;
    },
    siteAnchor(siteId) {
      if (disposed || !art || dev?.showBuildings === false) return null;
      return world.sites.find(site => site.id === siteId)?.anchor ?? null;
    },
    mapObjects() {
      return disposed || !art ? [] : interactiveMapObjects(world, { showBuildings: dev?.showBuildings });
    },
    setTime(now) {
      if (disposed || !Number.isFinite(now)) return;
      const wasExploring = exploring();
      setEconomicTime(now);
      pendingTimestamp = now; if (active()) applyPendingTime();
      syncExploration();
      updateAudio();
      if (wasExploring !== exploring() && visible()) draw();
    },
    invite() {}, moveTo() {},
    ambience: () => {
      const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
      return { elapsed: state.elapsed, ecologyTime: reducedMotion(options, dev) ? 0 : state.timestamp / 1000,
        rain: environment.rain, dusk: environment.dusk };
    },
    paintJourney() {}, paintVisitors() {}, paintLighting() {}, paintWeather() {},
    paintWorld, speechFrames, dispose,
  };
}
