import { loadHabitatImage } from "@/features/mochlik/assets";
import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import type { HabitatScene, SceneCallbacks, SceneOptions } from "@/features/mochlik/scene";
import { NEW_MAP_FOCUS, NEW_MAP_PET_SIZE as PET_SIZE, NEW_MAP_SPAWN, TILED_WORLD } from "./presentation";
import { paintFixedWorld } from "./tiled/renderer";
import { initialPreviewLevels, previewSiteVisual } from "./tiled/preview-state";
import type { PreviewLevels, SiteVisual } from "./tiled/types";
import { drawGroundedHero } from "./grounding";
import { drawForestAtmosphere, forestAtmosphereState, FOREST_BIRD_FLIGHT_DURATION, type ForestAtmosphereOptions } from "./forest-atmosphere";
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
  state: WorldDevState;
  visuals?: Record<string, SiteVisual>;
  animation?: ManualAnimation | null;
  birdElapsed?: number;
};

function reducedMotion(options: SceneOptions, dev?: WorldDevState) {
  return dev?.reducedMotion === "on" || dev?.reducedMotion !== "off" && options.reducedMotion;
}
function atmosphereOptions(options: SceneOptions, timestamp: number, dusk: number, preview?: NewMapPaintPreview): ForestAtmosphereOptions {
  const dev = preview?.state;
  return { elapsed: timestamp / 1000, timestamp, reducedMotion: reducedMotion(options, dev),
    dusk: dev?.timeOfDay === "day" ? 0 : dev?.timeOfDay === "dusk" ? .55 : dev?.timeOfDay === "night" ? 1 : dusk,
    weather: dev?.weather, butterflies: dev?.butterflies, fireflies: dev?.fireflies, birds: dev?.birds,
    birdElapsed: preview?.birdElapsed };
}
function actorFrame(elapsed: number, reacting: boolean, still: boolean, preview?: NewMapPaintPreview) {
  const cycle = elapsed % 48, animation = preview?.animation, chosen = preview?.state.pose;
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
  context.save();
  context.beginPath(); context.rect(0, 0, TILED_WORLD.width, TILED_WORLD.height); context.clip();
  paintFixedWorld(context, TILED_WORLD, { images, visuals: preview?.visuals ?? initialVisuals, actor: null,
    options: { levels: dev?.levels ?? levels, night: false, debug: dev?.debug ?? false, selectedSiteId: null,
      reducedMotion: still, showBuildings: dev?.showBuildings, buildingShadow: dev?.buildingShadow } });
  if (dev?.showHero !== false) drawGroundedHero(context, { ...NEW_MAP_SPAWN, size: PET_SIZE * (dev?.heroScale ?? 1),
    direction: dev?.direction ?? "front", ...actorFrame(elapsed, reacting, still, preview),
    appearance: dev?.equipment ?? options.worldState?.equipment, shadow: dev?.heroShadow });
  drawForestAtmosphere(context, TILED_WORLD, atmosphereOptions(options, timestamp, dusk, preview));
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
  let frame = 0, previous = 0, elapsed = 0, reaction = 0;
  let animation: ManualAnimation | null = null, birdStarted: number | null = null;
  let configuredTimestamp = Number.isFinite(initial.serverNow) ? initial.serverNow! : null;
  let timestamp = configuredTimestamp ?? Date.now(), pendingTimestamp: number | null = null, dusk = Number(initial.dusk);
  let reactionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity: "idle" | "greet" | null = null;

  function preview(): NewMapPaintPreview | undefined {
    return dev ? { state: dev, visuals, animation, birdElapsed: birdStarted === null ? undefined : elapsed - birdStarted } : undefined;
  }
  function paintWorld(target: CanvasRenderingContext2D) {
    if (!disposed && art) paintNewMap(target, art, options, elapsed, reaction > 0, timestamp, dusk, preview());
  }
  function draw() {
    if (disposed || !art) return;
    if (options.view !== "world") {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width / NEW_MAP_FOCUS.width, 0, 0, canvas.height / NEW_MAP_FOCUS.height, 0, 0);
      ctx.translate(-NEW_MAP_FOCUS.x, -NEW_MAP_FOCUS.y);
      paintWorld(ctx);
    }
    const activity = reaction > 0 ? "greet" : "idle";
    if (lastActivity !== activity) { lastActivity = activity; callbacks.activity(activity); }
    callbacks.rendered?.();
  }
  function visible() { return !disposed && !options.backgrounded && !document.hidden; }
  function active() { return visible() && Boolean(art) && !options.paused && !dev?.paused; }
  function cancelReactionTimer() {
    if (reactionTimer !== null) { clearTimeout(reactionTimer); reactionTimer = null; }
  }
  function stop() { cancelAnimationFrame(frame); frame = 0; previous = 0; cancelReactionTimer(); }
  function tick(now: number) {
    frame = 0;
    if (!active() || reducedMotion(options, dev)) return;
    if (!previous) previous = now;
    if (now - previous >= 1000 / 30) {
      const step = Math.min((now - previous) / 1000, .05);
      elapsed += step; timestamp += step * 1000;
      if (birdStarted !== null && elapsed - birdStarted >= FOREST_BIRD_FLIGHT_DURATION) birdStarted = null;
      dusk += (Number(options.dusk) - dusk) * Math.min(1, step * .7);
      if (animation) { animation.elapsed += step; if (animation.elapsed >= REACTION_SECONDS) animation = null; }
      reaction = Math.max(0, reaction - step); previous = now; draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function resume() {
    if (!active()) return;
    applyPendingTime();
    if (reducedMotion(options, dev)) {
      const remaining = Math.max(reaction, animation ? REACTION_SECONDS - animation.elapsed : 0);
      if (remaining > 0 && reactionTimer === null) {
        reactionTimer = setTimeout(() => {
          reactionTimer = null; reaction = 0; animation = null; if (active()) draw();
        }, remaining * 1000);
      }
    } else if (!frame) { previous = 0; frame = requestAnimationFrame(tick); }
  }
  function applyPendingTime() {
    if (pendingTimestamp !== null) { timestamp = pendingTimestamp; pendingTimestamp = null; }
  }
  function resize() {
    const next = options.view === "world" ? 1 : Math.min(1024, Math.max(256,
      Math.round((canvas.clientWidth || 256) * Math.min(window.devicePixelRatio || 1, 3))));
    if (canvas.width !== next || canvas.height !== next) { canvas.width = next; canvas.height = next; draw(); }
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  function dispose() {
    if (disposed) return;
    disposed = true; artworkVersion++; stop(); unsubscribe(); observer.disconnect(); art = null;
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
      art = new Map(images); visuals = next;
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
    if (dev.animation?.id !== before.animation?.id) animation = dev.animation ? { pose: dev.animation.pose, elapsed: 0 } : null;
    if (dev.birdEvent !== before.birdEvent) birdStarted = dev.birdEvent ? elapsed : null;
    stop();
    if (reducedMotion(options, dev)) dusk = Number(options.dusk);
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
      options = { ...next }; stop();
      if (reducedMotion(options, dev)) dusk = Number(options.dusk);
      // Visibility reuses old options; keep any newer setTime sample until resume.
      if (Number.isFinite(next.serverNow) && next.serverNow !== configuredTimestamp) {
        configuredTimestamp = next.serverNow!; pendingTimestamp = configuredTimestamp;
      }
      if (active()) applyPendingTime();
      resize(); if (active()) draw(); resume();
    },
    notice() {
      if (disposed) return;
      reaction = REACTION_SECONDS; cancelReactionTimer(); if (active()) draw(); resume();
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
      const state = forestAtmosphereState(TILED_WORLD, atmosphereOptions(options, timestamp, dusk, preview()));
      return { elapsed, ecologyTime: reducedMotion(options, dev) ? 0 : timestamp / 1000, rain: state.rain, dusk: state.dusk };
    },
    paintJourney() {}, paintVisitors() {}, paintLighting() {}, paintWeather() {},
    paintWorld, dispose,
  };
}
