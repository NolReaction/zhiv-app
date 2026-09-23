import { loadHabitatImage } from "@/features/mochlik/assets";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { HabitatScene, SceneCallbacks, SceneOptions } from "@/features/mochlik/scene";
import { NEW_MAP_FOCUS, NEW_MAP_PET_SIZE as PET_SIZE, NEW_MAP_SPAWN, TILED_WORLD } from "./presentation";
import { paintFixedWorld } from "./tiled/renderer";
import { initialPreviewLevels, previewSiteVisual } from "./tiled/preview-state";
import type { PreviewLevels, SiteVisual } from "./tiled/types";
import { drawGroundedHero } from "./grounding";
import { drawForestAtmosphere, forestAtmosphereState, FOREST_BIRD_FLIGHT_DURATION, type ForestAtmosphereOptions } from "./forest-atmosphere";
import { drawForestWater } from "./forest-water";
import { drawForestGroundWeather, updateForestWetness } from "./forest-ground-weather";
import { drawForestGroundImpacts } from "./forest-ground-impacts";
import { drawForestLighting, drawForestLightEmitters } from "./forest-lighting";
import { advanceForestLife, cancelForestLife, forestLifeFrame, triggerForestLife, type ForestLifeState } from "./forest-life";
import { drawForestLifePartner, drawForestMushrooms } from "./forest-life-painter";
import { connectForestSession } from "./forest-session";
import { WORLD_DEV_ENABLED, worldDevStore, type WorldDevState } from "./dev/world-dev-store";

const REACTION_SECONDS = .9;
const levels = initialPreviewLevels(TILED_WORLD);
const visualsFor = (next: PreviewLevels) => Object.fromEntries(TILED_WORLD.sites.map(site => [site.id, previewSiteVisual(site, next)]));
const initialVisuals = visualsFor(levels);
const artworkUrls = (visuals: Record<string, SiteVisual>) => [...new Set([
  ...TILED_WORLD.terrain.map(terrain => terrain.image), ...Object.values(visuals).map(visual => visual.image),
])];

type ManualAnimation = { pose: PixelPose; elapsed: number };
export type NewMapPaintPreview = {
  state?: WorldDevState;
  visuals?: Record<string, SiteVisual>;
  animation?: ManualAnimation | null;
  birdElapsed?: number;
  birdSeed?: number;
  life?: ForestLifeState;
  wetness?: number;
};

function reducedMotion(options: SceneOptions, dev?: WorldDevState) {
  return dev?.reducedMotion === "on" || dev?.reducedMotion !== "off" && options.reducedMotion;
}
function atmosphereOptions(options: SceneOptions, timestamp: number, dusk: number, preview?: NewMapPaintPreview): ForestAtmosphereOptions {
  const dev = preview?.state;
  return { elapsed: timestamp / 1000, timestamp, reducedMotion: reducedMotion(options, dev),
    dusk: dev?.timeOfDay === "day" ? 0 : dev?.timeOfDay === "night" ? 1 : dusk,
    weather: dev?.weather, butterflies: dev?.butterflies, fireflies: dev?.fireflies, birds: dev?.birds,
    birdElapsed: preview?.birdElapsed, birdSeed: preview?.birdSeed };
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
  const actor = { ...NEW_MAP_SPAWN, size: PET_SIZE * (dev?.heroScale ?? 1) };
  const atmosphere = { ...atmosphereOptions(options, timestamp, dusk, preview), elapsed };
  const life = preview?.life;
  const routine = life?.routine && !still && !reacting && !preview?.animation && (!dev?.pose || dev.pose === "auto")
    ? forestLifeFrame(life, actor, elapsed) : null;
  context.save();
  context.beginPath(); context.rect(0, 0, TILED_WORLD.width, TILED_WORLD.height); context.clip();
  paintFixedWorld(context, TILED_WORLD, { images, visuals: preview?.visuals ?? initialVisuals, actor: null,
    paintGround: ground => {
      const weather = { ...forestAtmosphereState(TILED_WORLD, atmosphere), reducedMotion: still };
      const groundExclusions = life?.mushrooms.map(mushroom => ({ x: mushroom.x, y: mushroom.y, radius: PET_SIZE * .14 }));
      drawForestWater(ground, TILED_WORLD, weather);
      drawForestGroundImpacts(ground, TILED_WORLD, { ...weather, groundExclusions });
      if (dev?.puddles !== false) drawForestGroundWeather(ground, TILED_WORLD, { ...atmosphere, wetness: preview?.wetness ?? 0,
        groundExclusions });
      if (life) drawForestMushrooms(ground, life, PET_SIZE);
    },
    options: { levels: dev?.levels ?? levels, night: false, debug: dev?.debug ?? false, selectedSiteId: null,
      reducedMotion: still, showBuildings: dev?.showBuildings, buildingShadow: dev?.buildingShadow } });
  if (dev?.showHero !== false) {
    drawGroundedHero(context, { ...actor, direction: routine?.direction ?? dev?.direction ?? "front",
      ...(routine ?? actorFrame(elapsed, reacting, still, preview)),
      appearance: dev?.equipment ?? options.worldState?.equipment, shadow: dev?.heroShadow });
    if (routine) drawForestLifePartner(context, routine, elapsed);
  }
  const lighting = { night: Number(atmosphere.dusk), elapsed, reducedMotion: still,
    showBuildings: dev?.showBuildings, levels: dev?.levels ?? levels };
  drawForestAtmosphere(context, TILED_WORLD, atmosphere, () => drawForestLighting(context, TILED_WORLD, lighting));
  drawForestLightEmitters(context, TILED_WORLD, lighting);
  context.restore();
}

/** Shared Tiled scene; development overrides never enter persisted world state. */
export function mountNewMapScene(canvas: HTMLCanvasElement, initial: SceneOptions, callbacks: SceneCallbacks): HabitatScene {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("2D canvas unavailable");
  const ctx = context;
  let options = { ...initial }, art: ReadonlyMap<string, HTMLImageElement> | null = null, disposed = false;
  let dev = WORLD_DEV_ENABLED ? worldDevStore.getSnapshot() : undefined;
  let visuals = initialVisuals, requestedKey: string | null = null, artworkVersion = 0;
  let unsubscribe = () => {};
  let frame = 0, previous = 0;
  let configuredTimestamp = Number.isFinite(initial.serverNow) ? initial.serverNow! : null;
  let pendingTimestamp: number | null = null;
  let reactionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity: "idle" | "greet" | null = null;
  let session = connect();
  let state = session.state;

  function connect() {
    return connectForestSession(options.presenceKey, TILED_WORLD, options.view ?? "circle",
      Number.isFinite(options.serverNow) ? options.serverNow! : Date.now(), Number(options.dusk), ownerChanged => {
        if (disposed) return;
        if (ownerChanged) stop();
        if (visible()) draw();
        if (ownerChanged) resume();
      });
  }
  function preview(): NewMapPaintPreview {
    return { state: dev, visuals, animation: state.animation, life: state.life, wetness: state.wetness,
      birdElapsed: state.birdStarted === null ? undefined : state.elapsed - state.birdStarted,
      birdSeed: state.birdStarted === null ? undefined : state.birdSeed };
  }
  function paintWorld(target: CanvasRenderingContext2D) {
    if (!disposed && art) paintNewMap(target, art, options, state.elapsed, state.reaction > 0, state.timestamp, state.dusk, preview());
  }
  function draw() {
    if (disposed || !art) return;
    if (options.view !== "world") {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / NEW_MAP_FOCUS.width, 0, 0, canvas.height / NEW_MAP_FOCUS.height, 0, 0);
      ctx.translate(-NEW_MAP_FOCUS.x, -NEW_MAP_FOCUS.y);
      paintWorld(ctx);
    }
    const activity = state.reaction > 0 ? "greet" : "idle";
    if (lastActivity !== activity) { lastActivity = activity; callbacks.activity(activity); }
    callbacks.rendered?.();
  }
  function visible() { return !disposed && !options.backgrounded && !document.hidden; }
  function active() { return visible() && Boolean(art) && !options.paused && !dev?.paused; }
  function syncOwner() { session.configure(options.view ?? "circle", active()); }
  function cancelReactionTimer() {
    if (reactionTimer !== null) { clearTimeout(reactionTimer); reactionTimer = null; }
  }
  function stop() { cancelAnimationFrame(frame); frame = 0; previous = 0; cancelReactionTimer(); }
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
      const environment = forestAtmosphereState(TILED_WORLD, atmosphereOptions(options, state.timestamp, state.dusk, preview()));
      state.wetness = updateForestWetness(state.wetness, environment.rain, step);
      const manual = Boolean(state.animation || state.reaction > 0 || dev?.pose && dev.pose !== "auto" || dev?.showHero === false);
      advanceForestLife(state.life, step, { autoLife: !manual && dev?.autoLife !== false,
        dusk: environment.dusk, rain: environment.rain, butterflies: dev?.butterflies, fireflies: dev?.fireflies });
      previous = now; session.publish();
    }
    if (active() && session.isOwner()) frame = requestAnimationFrame(tick);
  }
  function resume() {
    syncOwner();
    if (!active() || !session.isOwner()) return;
    applyPendingTime();
    if (reducedMotion(options, dev)) {
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
    document.removeEventListener("visibilitychange", visibilityChanged); session.release();
  }
  function prepareArtwork() {
    const next = visualsFor(dev?.levels ?? levels), urls = artworkUrls(next);
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
  if (WORLD_DEV_ENABLED) unsubscribe = worldDevStore.subscribe(() => {
    if (disposed) return;
    const before = dev!;
    dev = worldDevStore.getSnapshot();
    if (session.consumeControls(dev)) {
      if (dev.animation?.id !== before.animation?.id) {
        if (!dev.animation) state.animation = null;
        else if (session.consumeEvent("pose", dev.animation.id)) state.animation = { pose: dev.animation.pose, elapsed: 0 };
        cancelForestLife(state.life);
      }
      if (dev.birdEvent !== before.birdEvent) {
        if (!dev.birdEvent) state.birdStarted = null;
        else if (session.consumeEvent("birds", dev.birdEvent)) { state.birdStarted = state.elapsed; state.birdSeed += 1; }
      }
      if (dev.pose !== before.pose || dev.autoLife === false && before.autoLife || dev.showHero === false
        || state.life.routine?.kind === "butterfly" && dev.butterflies === "off"
        || state.life.routine?.kind === "firefly" && dev.fireflies === "off") cancelForestLife(state.life);
      if (dev.lifeEvent?.id !== before.lifeEvent?.id) {
        if (!dev.lifeEvent) cancelForestLife(state.life);
        else if (session.consumeEvent("life", dev.lifeEvent.id)) triggerForestLife(state.life, dev.lifeEvent.kind);
      }
    }
    stop(); syncOwner();
    if (reducedMotion(options, dev)) state.dusk = Number(options.dusk);
    if (active()) applyPendingTime();
    if (visible()) draw();
    if (dev.levels !== before.levels) prepareArtwork();
    resume();
  });
  prepareArtwork();
  return {
    position: () => ({ x: NEW_MAP_SPAWN.x, y: NEW_MAP_SPAWN.y - PET_SIZE * (dev?.heroScale ?? 1) / 2 }),
    configure(next) {
      if (disposed) return;
      const identityChanged = next.presenceKey !== options.presenceKey;
      options = { ...next }; stop();
      if (identityChanged) { session.release(); session = connect(); state = session.state; pendingTimestamp = null; }
      syncOwner();
      if (reducedMotion(options, dev)) state.dusk = Number(options.dusk);
      // Visibility reuses old options; keep any newer setTime sample until resume.
      if (Number.isFinite(next.serverNow) && next.serverNow !== configuredTimestamp) {
        configuredTimestamp = next.serverNow!; pendingTimestamp = configuredTimestamp;
      }
      if (active()) applyPendingTime();
      resize(); if (active()) draw(); resume();
    },
    notice() {
      if (disposed) return;
      cancelForestLife(state.life); state.reaction = REACTION_SECONDS; cancelReactionTimer();
      if (active()) session.publish(); resume();
    },
    hitPet(x, y) {
      const point = { x: NEW_MAP_FOCUS.x + x * NEW_MAP_FOCUS.width, y: NEW_MAP_FOCUS.y + y * NEW_MAP_FOCUS.height };
      const size = PET_SIZE * (dev?.heroScale ?? 1);
      return !disposed && dev?.showHero !== false && Math.abs(point.x - NEW_MAP_SPAWN.x) < size / 2
        && point.y > NEW_MAP_SPAWN.y - size && point.y < NEW_MAP_SPAWN.y;
    },
    setTime(now) {
      if (disposed || !Number.isFinite(now)) return;
      pendingTimestamp = now; if (active()) applyPendingTime();
    },
    invite() {}, moveTo() {},
    ambience: () => {
      const environment = forestAtmosphereState(TILED_WORLD, atmosphereOptions(options, state.timestamp, state.dusk, preview()));
      return { elapsed: state.elapsed, ecologyTime: reducedMotion(options, dev) ? 0 : state.timestamp / 1000,
        rain: environment.rain, dusk: environment.dusk };
    },
    paintJourney() {}, paintVisitors() {}, paintLighting() {}, paintWeather() {},
    paintWorld, dispose,
  };
}
