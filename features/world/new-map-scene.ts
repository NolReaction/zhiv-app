import { loadHabitatImage } from "@/features/mochlik/assets";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { HabitatScene, SceneCallbacks, SceneOptions } from "@/features/mochlik/scene";
import { NEW_MAP_FOCUS, NEW_MAP_PET_SIZE as PET_SIZE, NEW_MAP_SPAWN, TILED_WORLD } from "./presentation";
import { paintFixedWorld } from "./tiled/renderer";
import { initialPreviewLevels, previewSiteAt, previewSiteVisual, previewWorldScene } from "./tiled/preview-state";
import type { FixedWorldScene, PreviewLevels, SiteVisual, WorldPoint } from "./tiled/types";
import { drawGroundedHero } from "./grounding";
import { drawBuildingDetails } from "./building-details";
import { drawForestAtmosphere, forestAtmosphereState, FOREST_BIRD_FLIGHT_DURATION, type ForestAtmosphereOptions } from "./forest-atmosphere";
import { drawForestWater } from "./forest-water";
import { drawForestGroundWeather, updateForestWetness } from "./forest-ground-weather";
import { drawForestGroundImpacts } from "./forest-ground-impacts";
import { drawForestLighting, drawForestLightEmitters, drawForestLighthouseBeams } from "./forest-lighting";
import { forestLifeFrame, type ForestLifeState } from "./forest-life";
import { drawForestLifePartner, drawForestMushrooms } from "./forest-life-painter";
import { drawForestBush, forestBushForegroundActive } from "./forest-bush-painter";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { drawForestGardenGround, drawForestGardenPlants, drawForestGardenProps, forestGardenVisualFrame } from "./forest-garden-painter";
import { drawWaterDebug } from "./dev/water-debug";
import { clearingActivityFrame, clearingNavigationFrame, noticeClearingActivity } from "./clearing-activity";
import { advanceForestDirector, cancelForestDirector, noticeForestDirector, requestForestDirective, requestForestGardenHarvest, requestForestTradeVisit, forestTradeVisitFrame, type ForestDirectorOptions } from "./forest-director";
import { syncForestGardenProduction } from "./forest-garden";
import { faunaInteractionFrame, faunaRenderFrame, residentFaunaEncounter, type ForestFaunaState } from "./forest-fauna";
import { pleskWildlifeHand } from "./plesk-painter";
import { campfireVisitFrame, type CampfireVisit } from "./forest-campfire";
import { drawForestCampfires, drawForestCampfireGlow } from "./forest-campfire-painter";
import { forestBirdFrame } from "./forest-birds";
import { forestBirdwatchFrame, type ForestBirdwatch } from "./forest-birdwatching";
import { advanceBirdReactions, applyBirdReactions } from "./forest-bird-reactions";
import { drawForestBird, type ForestBird } from "./forest-wildlife";
import { drawForestResidents, forestResidentAt, forestResidentFrames } from "./forest-residents";
import { forestPointOccluded, withForestOcclusion } from "./forest-occlusion";
import { drawLivingWorldDebug, type LivingWorldDebugSnapshot } from "./living-world-debug";
import { connectForestSession } from "./forest-session";
import { publishForestObservation } from "./forest-observer";
import { forestSceneFingerprint } from "./forest-memory";
import { applyForestDevScenario } from "./dev/forest-dev-scenarios";
import { forestPersistenceOverridden } from "./forest-dev-memory";
import { WORLD_DEV_ENABLED, worldDevStore, type WorldDevState, type WorldDevLifeAction } from "./dev/world-dev-store";
import { accountSceneLevels, economyJourneyAway, type EconomySceneJourney } from "./economy-scene-state";
import { interactiveMapObjects } from "./site-interactions";
import { forestJourneyActorAway, forestJourneyEnding, forestJourneyFishingFrame, forestJourneyWalking, syncForestJourneyTravel } from "./forest-journey-travel";

import { advancePleskMind, pleskMindFrame, noticePleskMind, requestPleskTrade } from "./plesk-mind";
import { advanceBuilderMind, builderMindFrame, noticeBuilderMind } from "./builder-mind";
import { syncForestConstruction } from "./economy-construction-state";
import { previewForestResidents } from "./dev/forest-resident-preview";
import { drawForestFishingHero } from "./forest-fishing-painter";
import type { ForestFishingFrame } from "./forest-fishing";
import { fishingPropsBounds } from "./fishing-props";
import { forestCookingBounds, type ForestCookingFrame } from "./forest-cooking";
import { drawForestCookingHero, drawForestProductionCooking } from "./forest-cooking-painter";
import { forestProductionFrames, forestProductionJourney, syncForestProduction, type ForestProductionFrame } from "./economy-production-state";
import { drawForestProductionStation } from "./forest-production-painter";
import { startCookingPreview, advanceCookingPreview, cookingPreviewFrame, noticeCookingPreview } from "./dev/forest-cooking-preview";
import { forestTrailDestination } from "./forest-trails";
import { forestJourneyMiningFrame, type ForestMiningFrame } from "./forest-mining";
import { drawForestMiningHero, drawForestMiningWork } from "./forest-mining-painter";
import { advanceForestSocial, cancelForestSocial, noticeForestSocial, forestSocialFrames, forestSocialHolding,
  type ForestSocialEnvironment, type ForestSocialActor, type ForestSpeaker } from "./forest-social";
import { drawForestSpeech, type ForestSpeechCanvasFrame } from "./forest-speech-painter";
import { builderDirection } from "./builder-navigation";
import { forestResidentOccupants } from "./forest-resident-occupancy";

const REACTION_SECONDS = .9;
const levels = initialPreviewLevels(TILED_WORLD);
const visualsFor = (next: PreviewLevels) => Object.fromEntries(TILED_WORLD.sites.map(site => [site.id, previewSiteVisual(site, next)]));
const artworkUrls = (scene: FixedWorldScene, visuals: Record<string, SiteVisual>) => [...new Set([
  ...scene.terrain.map(terrain => terrain.image), ...Object.values(visuals).map(visual => visual.image),
])];

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
export type NewMapPaintPreview = {
  scene?: FixedWorldScene;
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
  productions?: readonly ForestProductionFrame[];
  residents?: readonly ReturnType<typeof forestResidentFrames>[number][];
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
  const dev = preview?.state, still = reducedMotion(options, dev);
  const currentLevels = accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings);
  const world = preview?.scene ?? previewWorldScene(TILED_WORLD, currentLevels);
  const home = world.sites.find(site => site.id === "home");
  const selectedVisuals = preview?.visuals ?? visualsFor(currentLevels);
  const selectedLevels = Object.fromEntries(Object.entries(selectedVisuals).map(([id, visual]) => [id, visual.level]));
  const walking = preview?.clearing;
  const actor = { x: preview?.mining?.x ?? walking?.x ?? NEW_MAP_SPAWN.x, y: preview?.mining?.y ?? walking?.y ?? NEW_MAP_SPAWN.y, size: PET_SIZE * (dev?.heroScale ?? 1) };
  const mining = preview?.mining ? { ...preview.mining, size:actor.size } : null;
  const fishing = preview?.fishing ? { ...preview.fishing, size: actor.size } : null;
  const cooking = !fishing && preview?.cooking ? { ...preview.cooking, size: actor.size } : null;
  const atmosphere = { ...atmosphereOptions(options, timestamp, dusk, preview), elapsed };
  const birds = atmosphere.birdFrame ?? forestBirdFrame(world, { ...atmosphere, ...forestAtmosphereState(world, atmosphere) });
  atmosphere.birdFrame = birds;
  const groundBirds = birds.filter(bird => bird.groundY !== undefined).sort((a, b) => a.groundY! - b.groundY!);
  const life = preview?.life;
  const heroVisible = dev?.showHero !== false && !(preview?.actorAway ?? economyJourneyAway(options.economyJourney, timestamp));
  const automatic = heroVisible && !fishing && !mining && !cooking && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto");
  const motion = automatic && walking ? walking : null;
  // A cancelled carry may wait for clear ground; attention cannot hide its basket.
  const garden = automatic || life?.garden.basket?.held ? forestGardenVisualFrame(life?.garden, actor,
    { pose: motion?.pose ?? "idle", frame: motion?.frame ?? 0, direction: motion?.direction ?? "front" }, still) : null;
  const routine = heroVisible && !fishing && !mining && life?.routine && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto")
    ? forestLifeFrame(life, { ...actor, propSize: PET_SIZE }, elapsed) : null;
  const encounter = heroVisible && !fishing && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto") && preview?.fauna
    ? faunaInteractionFrame(preview.fauna) : null;
  const trading = automatic ? preview?.tradeVisit : null;
  const birdwatch = automatic && !still && preview?.birdwatch ? forestBirdwatchFrame(preview.birdwatch, actor) : null;
  const fire = life?.campfires.find(item => item.id === preview?.campfireVisit?.id);
  const warming = automatic && fire && preview?.campfireVisit ? campfireVisitFrame(preview.campfireVisit, fire, actor, still) : null;
  const behindFires = (life?.campfires ?? []).filter(item => item.position.y < actor.y);
  const frontFires = (life?.campfires ?? []).filter(item => item.position.y >= actor.y);
  const productions = preview?.productions ?? forestProductionFrames(options.economyProduction, world, selectedVisuals, timestamp, elapsed, dev?.showBuildings !== false);
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
    hiddenTerrainIds: foregroundTerrain && foregroundImage?.naturalWidth && foregroundImage.naturalHeight ? [foregroundTerrain.id] : undefined,
    paintGround: ground => {
      const weather = { ...forestAtmosphereState(world, atmosphere), reducedMotion: still };
      const groundExclusions = life?.mushrooms.map(mushroom => ({ x: mushroom.x, y: mushroom.y, radius: PET_SIZE * .14 }));
      drawForestWater(ground, world, { ...weather, waterFish: dev?.waterFish, waterBreeze: dev?.waterBreeze,
        waterSurface: dev?.waterSurface,
        wind: dev?.waterWind === "calm" ? 0 : dev?.waterWind === "breeze" ? .45 : dev?.waterWind === "windy" ? 1 : undefined });
      drawForestGroundImpacts(ground, world, { ...weather, groundExclusions });
      if (dev?.puddles !== false) drawForestGroundWeather(ground, world, { ...atmosphere, wetness: preview?.wetness ?? 0,
        groundExclusions });
      if (life) drawForestMushrooms(ground, life, PET_SIZE);
    },
    options: { levels: selectedLevels, night: false, debug: dev?.debug ?? false, selectedSiteId: null,
      reducedMotion: still, showBuildings: dev?.showBuildings, buildingShadow: dev?.buildingShadow } });
  drawForestCampfires(context, behindFires, elapsed, still);
  paintProduction(false);
  drawForestGardenPlants(context, world, life?.garden);
  drawForestGardenGround(context, life?.garden, actor.size, garden, heroVisible ? actor : undefined);
  // A moving cutout may own the artwork while its actor is still in front.
  // Rustling never promotes leaves over an approaching or emerging body.
  if (!walking?.bush?.occlude) paintBush();
  drawForestResidents(context, world, elapsed, still, actor.y, "behind", preview?.residents);
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
      drawForestGardenProps(actorContext, garden, "behind");
      drawGroundedHero(actorContext, { ...actor, direction: garden?.direction ?? routine?.direction ?? encounter?.direction ?? warming?.direction ?? birdwatch?.direction ?? trading?.direction ?? manualDirection ?? motion?.direction ?? dev?.direction ?? "front",
        ...(garden ? { pose: garden.pose, frame: garden.frame } : routine ?? encounter ?? warming ?? birdwatch ?? trading ?? (motion ? { pose: motion.pose, frame: motion.frame } : actorFrame(elapsed, reacting, still, preview))),
        appearance: dev?.equipment ?? options.worldState?.equipment, shadow: dev?.heroShadow, lift: motion?.lift, compression: motion?.compression,
        rig: garden?.rig ?? routine?.rig });
      if (routine) drawForestLifePartner(actorContext, routine, elapsed);
      drawForestGardenProps(actorContext, garden, "front");
    }, fishing ? fishingPropsBounds(fishing) : cooking ? forestCookingBounds(cooking) : undefined);
    context.restore();
  }
  drawForestResidents(context, world, elapsed, still, actor.y, "front", preview?.residents);
  drawForestGardenGround(context, life?.garden, actor.size, garden, heroVisible ? actor : undefined, "front");
  for (const bird of groundBirds) if (bird.groundY! >= actor.y) drawForestBird(context, bird);
  if (walking?.bush?.occlude) paintBush();
  if (walking?.homeSleeping && home && heroVisible && dev?.showBuildings !== false) {
    drawHomeSleep(context, home.doorway ?? home.entry, elapsed, still);
  }
  drawForestCampfires(context, frontFires, elapsed, still);
  paintProduction(true);
  const lighting = { night: Number(atmosphere.dusk), elapsed, reducedMotion: still,
    showBuildings: dev?.showBuildings, levels: selectedLevels };
  // A confirmed cooking burner may glow during a cold evening without changing
  // the weather-owned fire or making its natural flame paint over the kettle.
  const cookingFires = (life?.campfires ?? []).map(fire => productions.some(frame => frame.fireId === fire.id && frame.phase === "working")
    ? { ...fire, flame: Math.max(fire.flame, .45), embers: Math.max(fire.embers, .4) } : fire);
  drawForestAtmosphere(context, world, { ...atmosphere, groundBirdsPainted: true }, () => { drawForestLighting(context, world, lighting);
    drawForestCampfireGlow(context, cookingFires, elapsed, still, lighting.night, heroVisible ? actor : undefined,
      productions.flatMap(frame => frame.fireId ? [frame.fireId] : [])); });
  drawForestLighthouseBeams(context, world, lighting);
  drawForestLightEmitters(context, world, lighting);
  drawBuildingDetails(context, world, lighting);
  // Station status stays legible above the roof in both daylight and night.
  // The full map's production badge owns this roof whenever an order exists.
  // The circle and an expedition without production retain the animated picks.
  if (dev?.showBuildings !== false && !(options.view === "world" && productions.some(frame => frame.stationId === "quarry"))) {
    const quarryProduction = productions.find(frame => frame.stationId === "quarry" && frame.phase === "working");
    const quarry = quarryProduction && world.sites.find(site => site.id === "quarry");
    const work = mining?.working ? mining : !mining && quarry && quarryProduction ? {
      working:true, workCue:{x:quarry.anchor.x,y:quarry.bounds.y-PET_SIZE*.12},
      size:PET_SIZE, elapsed:quarryProduction.elapsed,
    } : null;
    if (work) drawForestMiningWork(context,work,still);
  }
  if (WORLD_DEV_ENABLED && dev?.debugWater) drawWaterDebug(context, world);
  if (WORLD_DEV_ENABLED && preview?.livingDebug) drawLivingWorldDebug(context, world, preview.livingDebug);
  context.restore();
}

/** Shared Tiled scene; development overrides never enter persisted world state. */
export function mountNewMapScene(canvas: HTMLCanvasElement, initial: SceneOptions, callbacks: SceneCallbacks): HabitatScene {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("2D canvas unavailable");
  const ctx = context;
  let options = { ...initial }, art: ReadonlyMap<string, HTMLImageElement> | null = null, disposed = false;
  let dev = WORLD_DEV_ENABLED ? worldDevStore.getSnapshot() : undefined;
  let world = previewWorldScene(TILED_WORLD, accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings));
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
  let session = connect();
  let state = session.state;

  const explorationNow = () => economicTimestamp + Math.max(0, performance.now() - economicReceivedAt);
  function setEconomicTime(now: number) { economicTimestamp = now; economicReceivedAt = performance.now(); }
  function syncProduction() {
    const owner = options.presenceKey?.startsWith("zhiv:mochlik:presence:") ? options.presenceKey.slice("zhiv:mochlik:presence:".length) : undefined;
    syncForestProduction(state, options.economyProduction, owner);
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
      occupants: residentOccupants() });
  }
  // DEV rehearsals use the same travel/animation controller with a local clock.
  // A confirmed account job always owns the hero and its economic deadline.
  function displayedJourney(): { journey: EconomySceneJourney | null | undefined; now: number } {
    const now = explorationNow();
    // Even an unclaimed expedition keeps its own return animation. Ordinary
    // quarry production borrows the worker only when that slot is empty.
    if (options.economyJourney) return { journey: options.economyJourney, now };
    const mining = forestProductionJourney(state.economyProduction, now);
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
    syncForestJourneyTravel(state, world, journey, now, reducedMotion(options, dev), options.cancelledExplorations);
  }
  function residentFrames() {
    const rehearsal = dev?.residentPreview;
    let natural = state.pleskMind ? pleskMindFrame(state.pleskMind, world, reducedMotion(options, dev)) : null;
    const encounter = residentFaunaEncounter(state.fauna, "plesk");
    if (natural && encounter && !["interrupt", "release"].includes(encounter.phase)) {
      natural = { ...natural, action: natural.carryingFish ? "rest" : "greet", phase: .5, frame: 0, direction: encounter.direction, wildlife: true };
    }
    const plesk = previewForestResidents(world, state.elapsed, reducedMotion(options, dev), rehearsal ?? null,
      rehearsal && rehearsal.id === state.residentPreview?.id ? state.residentPreview.startedAt : state.elapsed, natural ? [natural] : []);
    const builder = builderMindFrame(state.builderMind, world, reducedMotion(options, dev));
    return [...plesk, ...(builder ? [builder] : [])];
  }
  function residentOccupants() {
    return forestResidentOccupants(state, world, { heroVisible: dev?.showHero !== false && !actorAway(), heroScale: dev?.heroScale,
      heroManual: Boolean(state.animation || state.reaction > 0 || dev?.pose && dev.pose !== "auto"),
      fishing: forestJourneyFishingFrame(state, world), mining: forestJourneyMiningFrame(state, world),
      cooking: cookingPreviewFrame(state, dev?.cookingPreview) });
  }
  /** Speech uses the same visible feet as traffic; hidden portals and work
   * animations cannot leave a floating caption at an old clearing coordinate. */
  function socialEnvironment(): ForestSocialEnvironment {
    const occupants = residentOccupants(), body = clearingActivityFrame(state.clearing);
    const fishing = forestJourneyFishingFrame(state, world), cooking = cookingPreviewFrame(state, dev?.cookingPreview);
    const manual = Boolean(state.animation || dev?.pose && dev.pose !== "auto" || dev?.showHero === false || dev?.residentPreview);
    const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
    const actors: ForestSocialActor[] = occupants.map(occupant => {
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
      if (occupant.id === "builder") return { ...occupant, id: "builder", visible: true,
        available: !state.builderMind?.job && !state.builderMind?.constructionPending && !state.builderMind?.blocked
          && !state.builderMind?.noticePending && state.builderMind?.action !== "finish",
        context: occupant.moving ? "walk" : state.builderMind?.job ? state.builderMind.ready ? "ready" : state.builderMind.blocked ? "busy" : "build" : "idle" };
      const action = state.pleskMind?.stage.action;
      return { ...occupant, id: "plesk", visible: true, available: action === "idle" || action === "rest",
        context: residentFaunaEncounter(state.fauna, "plesk") ? "animal" : state.pleskMind?.intent === "fish" ? "fish"
          : state.pleskMind?.intent === "trade" ? "trade" : occupant.moving ? "walk" : "idle" };
    });
    const animalEvents: NonNullable<ForestSocialEnvironment["animalEvents"]>[number][] = [];
    for (const encounter of [state.fauna.encounter, residentFaunaEncounter(state.fauna, "plesk")]) {
      if (encounter?.phase === "perch") animalEvents.push({ id: String(encounter.token),
        speaker: encounter.visitorId === "plesk" ? "plesk" : "mochlik", kind: encounter.kind });
    }
    const bird = state.director.birdwatch;
    if (bird) animalEvents.push({ id: `${bird.birdId}:${Math.round((state.elapsed - bird.elapsed) * 10)}`, speaker: "mochlik", kind: "bird" });
    return { scene: world, builder: state.builderMind, actors, occupants, animalEvents,
      enabled: active() && !manual, ambient: !reducedMotion(options, dev) && dev?.autoLife !== false,
      rain: environment.rain, dusk: environment.dusk };
  }
  function speechFrames(): ForestSpeechCanvasFrame[] {
    if (disposed || !art) return [];
    const frames = forestSocialFrames(state.social);
    if (!frames.length) return [];
    const actors = socialEnvironment().actors;
    return frames.flatMap(frame => {
      const actor = actors.find(actor => actor.id === frame.speaker && actor.visible && actor.canSpeak !== false && actor.context !== "sleep");
      return actor ? [{ ...frame, anchor: { x: actor.position.x, y: actor.position.y - actor.size * .94 } }] : [];
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
    // An explicit tap can end an optional visit. Repeated taps never replace or
    // extend an existing line, nor do they queue a backlog of greetings.
    if (state.social.meeting) cancelForestSocial(state.social, socialEnvironment());
    noticeForestSocial(state.social, speaker, socialEnvironment());
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
    // Keep the request unconsumed until the visible catch/tackle is put away.
    if (request && Number.isSafeInteger(request.requestId) && request.requestId > 0 && (!forestJourneyEnding(state) || leaseBlocked)) {
      const fresh = session.consumeEvent("garden-harvest", request.requestId);
      if (fresh || leaseBlocked && garden.harvest?.request.requestId === request.requestId) {
        if (leaseBlocked) {
          cancelForestDirector(state, "Сбор продолжается без анимации на этом устройстве");
          garden.harvestEvent = { ...request, status: "unavailable", reason: "Сбор продолжается без анимации на этом устройстве" };
          garden.harvest = null;
        } else {
          advanceCookingPreview(state, null);
          state.reaction = 0; state.animation = null;
          requestForestGardenHarvest(state, request, directorOptions());
          if (dev?.paused || options.paused || dev?.showHero === false || dev?.pose && dev.pose !== "auto") {
            cancelForestDirector(state, "Сбор продолжается без анимации");
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
    const connected = connectForestSession(options.presenceKey, world, options.view ?? "circle",
      timestamp, Number(options.dusk), ownerChanged => {
        if (disposed) return;
        if (ownerChanged) stop();
        if (visible()) draw();
        if (ownerChanged) resume();
      }, { persistence: allowPersistence && !forestPersistenceOverridden(dev, levels),
        awaitBuilderConstruction: options.economyConstruction !== undefined });
    if (!allowPersistence || forestPersistenceOverridden(dev, levels)) connected.suspendPersistence();
    return connected;
  }
  function clearingMustContinue() {
    const current = clearingActivityFrame(state.clearing);
    return Boolean(state.pendingLife || state.cookingPreview || state.director.birdwatch || state.director.campfireVisit || state.director.tradeVisit || state.life.garden?.routine || state.clearing.retiring || state.clearing.bushEffect?.bursts.length || forestJourneyWalking(state) || state.journeyTravel?.phase === "fishing" || state.journeyTravel?.mining)
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
    const resident = state.pleskMind ? pleskMindFrame(state.pleskMind, world, false) : null;
    const visitors = resident ? [{ ...resident, hand: pleskWildlifeHand(resident),
      available: !dev?.residentPreview && !state.pleskMind?.noticePending && !state.pleskMind?.tradePending && (!resident.carryingFish || resident.action === "rest")
        && ["idle", "rest", "greet"].includes(resident.action) }] : [];
    return { autoLife: !cooking && dev?.autoLife !== false, blocked: blocked || Boolean(forestSocialHolding(state.social)) || exploring() || forestJourneyWalking(state) || forestJourneyEnding(state)
      || Boolean(cooking && cooking.startedAt !== null), actorAway: actorAway(),
      explicitTravel: !blocked && (forestJourneyWalking(state) || Boolean(cooking && cooking.startedAt === null)), dusk: environment.dusk, rain: environment.rain,
      homeAvailable: dev?.showBuildings !== false, butterflies: dev?.butterflies, fireflies: dev?.fireflies,
      reducedMotion: reducedMotion(options, dev), navigationMode: dev?.navigationMode, heroScale: dev?.heroScale, birds: visibleBirds(), visitors,
      occupants: residentOccupants() };
  }
  function preview(): NewMapPaintPreview {
    syncProduction();
    syncConstruction();
    const path = dev?.debugNavigation ? clearingNavigationFrame(state.clearing) : null;
    const cooking = cookingPreviewFrame(state, dev?.cookingPreview, reducedMotion(options, dev));
    return { scene: world, state: dev, visuals, animation: state.animation, life: state.life, wetness: state.wetness, actorAway: actorAway(),
      residents: residentFrames(), fishing: forestJourneyFishingFrame(state, world, reducedMotion(options, dev)),
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
        ...(forestSocialHolding(state.social) && state.builderMind ? { direction: builderDirection(
          state.builderMind.position.x - state.clearing.position.x, state.builderMind.position.y - state.clearing.position.y) } : {}) },
      birdElapsed: state.birdStarted === null ? undefined : state.elapsed - state.birdStarted,
      birdSeed: state.birdStarted === null ? undefined : state.birdSeed };
  }
  function paintWorld(target: CanvasRenderingContext2D) {
    if (!disposed && art) {
      syncGarden();
      paintNewMap(target, art, options, state.elapsed, state.reaction > 0, state.timestamp, state.dusk, preview());
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
      const size = canvas.clientWidth || 256;
      ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);
      drawForestSpeech(ctx, speechFrames().map(frame => ({ ...frame, anchor: {
        x: (frame.anchor.x - NEW_MAP_FOCUS.x) / NEW_MAP_FOCUS.width * size,
        y: (frame.anchor.y - NEW_MAP_FOCUS.y) / NEW_MAP_FOCUS.height * size } })),
      { width: size, height: size, insets: { left: size * .15, right: size * .15, top: size * .15, bottom: size * .15 },
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
    session.configure(options.view ?? "circle", active(), true);
    if (WORLD_DEV_ENABLED && session.isOwner()) {
      const resident = dev?.residentPreview;
      if (resident && state.residentPreview?.id !== resident.id) {
        state.residentPreview = { id: resident.id, startedAt: state.elapsed };
      }
      if (dev?.scenarioEvent?.kind === "fishing" && !dev.lifeEvent) startFishingPreview(dev.scenarioEvent.id);
    }
    syncExploration(); syncGarden(); syncCooking(); syncProduction(); syncConstruction();
    if (session.isOwner()) advanceForestSocial(state.social, 0, socialEnvironment());
    updateObservation(true);
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
    if (!previous) previous = now;
    if (now - previous >= 1000 / 30) {
      const step = Math.min((now - previous) / 1000, .05);
      state.elapsed += step; state.timestamp += step * 1000;
      if (state.birdStarted !== null && state.elapsed - state.birdStarted >= FOREST_BIRD_FLIGHT_DURATION) state.birdStarted = null;
      state.dusk += (Number(options.dusk) - state.dusk) * Math.min(1, step * .7);
      if (state.animation) { state.animation.elapsed += step; if (state.animation.elapsed >= REACTION_SECONDS) state.animation = null; }
      state.reaction = Math.max(0, state.reaction - step);
      const environment = forestAtmosphereState(world, atmosphereOptions(options, state.timestamp, state.dusk, { state: dev }));
      state.wetness = updateForestWetness(state.wetness, environment.rain, step);
      syncConstruction(); syncExploration(); syncGarden(); syncCooking();
      advanceForestSocial(state.social, step, socialEnvironment());
      advanceBuilder(step);
      if (state.pleskMind) {
        const resident = pleskMindFrame(state.pleskMind, world, false);
        advancePleskMind(state.pleskMind, world, step, { rain: environment.rain, dusk: environment.dusk, occupants: residentOccupants(),
          wildlife: !dev?.residentPreview && Boolean(residentFaunaEncounter(state.fauna, "plesk")
            && !["interrupt", "release"].includes(residentFaunaEncounter(state.fauna, "plesk")!.phase)),
          playerNear: Boolean(resident && !actorAway() && dev?.showHero !== false
            && Math.hypot(resident.x - state.clearing.position.x, resident.y - state.clearing.position.y) < 90) });
      }
      const manual = Boolean(state.animation || state.reaction > 0 || dev?.pose && dev.pose !== "auto" || dev?.showHero === false);
      advanceForestDirector(state, step, directorOptions(manual));
      const stimulus = state.director.stimulus;
      const resident = state.pleskMind ? pleskMindFrame(state.pleskMind, world, false) : null;
      const birdVisitors = [
        ...(actorAway() || dev?.showHero === false || clearingActivityFrame(state.clearing).residing ? []
          : [{ ...state.clearing.position, size: state.clearing.size * (dev?.heroScale ?? 1), moving: clearingActivityFrame(state.clearing).pose === "walk" }]),
        ...(resident ? [{ x: resident.x, y: resident.y, size: resident.size, moving: resident.action === "walk" }] : []),
      ];
      advanceBirdReactions(state.birdReactions, birdBase(), step, stimulus && stimulus.id !== state.lastBirdStimulus
        ? { kind: stimulus.kind === "rustle" ? "bush-rustle" : "footstep", position: stimulus, intensity: stimulus.strength }
        : undefined, world, birdVisitors,
        { rain: environment.rain, dusk: environment.dusk, forced: state.birdStarted !== null || dev?.birds === "on" });
      if (stimulus) state.lastBirdStimulus = stimulus.id;
      previous = now; session.publish();
    }
    if (active() && session.isOwner()) frame = requestAnimationFrame(tick);
  }
  function resume() {
    syncOwner();
    if (!active() || !session.isOwner()) return;
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
  function visibilityChanged() { stop(); syncOwner(); if (visible()) draw(); resume(); }
  document.addEventListener("visibilitychange", visibilityChanged);
  function dispose() {
    if (disposed) return;
    disposed = true; artworkVersion++; stop(); unsubscribe(); observer.disconnect(); art = null;
    document.removeEventListener("visibilitychange", visibilityChanged); session.release({ retain: true });
  }
  function prepareArtwork() {
    const selected = accountSceneLevels(TILED_WORLD, options.worldState?.houseLevel, dev, options.economyBuildings);
    const nextWorld = previewWorldScene(TILED_WORLD, selected);
    const next = visualsFor(selected), urls = artworkUrls(nextWorld, next);
    const key = JSON.stringify(Object.entries(next).map(([id, visual]) => [id, visual.level, visual.image]));
    if (key === requestedKey) return;
    requestedKey = key;
    const version = ++artworkVersion;
    void Promise.all(urls.map(async url => {
      const image = await loadHabitatImage(url);
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error("Invalid world artwork dimensions");
      return [url, image] as const;
    })).then(images => {
      if (disposed || version !== artworkVersion) return;
      const first = art === null;
      // Commit artwork and its geometry together; stale/failed loads retain the
      // previous usable scene, including its navigation and indoor resident.
      if (world !== nextWorld) {
        const changed = forestSceneFingerprint(world) !== forestSceneFingerprint(nextWorld);
        world = nextWorld;
        if (changed) {
          const timestamp = state.timestamp;
          const persistence = !forestPersistenceOverridden(dev, levels);
          stop();
          if (persistence) session.saveMemory(); else session.suspendPersistence();
          const production = state.economyProduction, construction = state.economyConstruction, builder = state.builderMind;
          session.release();
          session = connect(timestamp, persistence); state = session.state;
          const freshBuilder = !state.economyConstruction && (!state.builderMind
            || state.builderMind.elapsed === 0 && !state.builderMind.jobKey);
          // Loaded geometry changes the forest fingerprint, not the economic
          // revision fence. Preserve removals across artwork/camera handoffs.
          syncForestProduction(state, production);
          syncForestConstruction(state, construction);
          // Seed only a new session. Never replace a live camera's builder or
          // share mutable feet/clocks with a background view of old geometry.
          // Targets and route geometry are immutable; progress lives on mind.
          if (builder && freshBuilder) {
            state.builderMind = { ...builder, position: { ...builder.position } };
            if (state.builderMind.socialVisit) cancelForestSocial(state.social, { ...socialEnvironment(), builder: state.builderMind });
          }
        }
      }
      art = new Map(images); visuals = next; syncOwner();
      if (WORLD_DEV_ENABLED) worldDevStore.reportArtError(null);
      if (visible()) draw();
      if (first) callbacks.ready();
      resume();
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
  function notice() {
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
    noticeForestDirector(state, still || manualPose);
    // Static accessibility / explicit DEV poses use a bounded feedback timer.
    if ((still || manualPose) && state.reaction <= 0) state.reaction = REACTION_SECONDS;
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
  return {
    position: () => {
      const actor = clearingActivityFrame(state.clearing);
      return { x: actor.x, y: actor.y - PET_SIZE * (dev?.heroScale ?? 1) / 2 };
    },
    configure(next) {
      if (disposed) return;
      const identityChanged = next.presenceKey !== options.presenceKey;
      options = { ...next }; stop();
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
    notice,
    wakeHomeResident() {
      if (disposed || exploring() || dev?.showHero === false || dev?.showBuildings === false
        || !session.isSimulationAllowed() || !["entering", "home-sleep"].includes(state.clearing.stage)) return false;
      notice();
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
    noticeResident(id) {
      if (disposed || !session.isOwner()) return;
      noticeSpeech(id);
      if (id === "builder") noticeBuilderMind(state.builderMind);
      else if (state.pleskMind && ["idle", "rest"].includes(state.pleskMind.stage.action)) noticePleskMind(state.pleskMind);
      updateObservation(true); session.publish(); resume();
    },
    visitTradingPlace(id) {
      if (disposed || id !== "plesk" || !art || dev?.showBuildings === false || !session.isOwner()
        || reducedMotion(options, dev) || !world.sites.some(site => site.id === "plesk-shop")) return;
      requestPleskTrade(state.pleskMind);
      if (dev?.showHero !== false) requestForestTradeVisit(state, world, directorOptions(Boolean(dev?.pose && dev.pose !== "auto")));
      updateObservation(true); session.publish(); resume();
    },
    inspectPoint(target) {
      if (disposed || !art) return null;
      const resident = residentFrames().find(resident => resident.id === target);
      if (resident) return { x: resident.x, y: resident.y - resident.size / 2 };
      const shore = target === "fishing" ? forestTrailDestination(world, "fishing") : null;
      return shore ? { x: shore.x, y: shore.y - PET_SIZE / 2 } : null;
    },
    hitSite(point) {
      if (disposed || !art || dev?.showBuildings === false) return null;
      return previewSiteAt(world, point)?.id ?? null;
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
