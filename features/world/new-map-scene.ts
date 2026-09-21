import { loadHabitatImage } from "@/features/mochlik/assets";
import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import type { HabitatScene, SceneCallbacks, SceneOptions } from "@/features/mochlik/scene";
import { WORLD_ART } from "./art";
import { NEW_MAP_FOCUS, NEW_MAP_SIZE, NEW_MAP_SPAWN } from "./presentation";

const PET_SIZE = 36;
const REACTION_SECONDS = .9;

/** Both views paint this scene in logical map coordinates, independently of source resolution. */
export function paintNewMap(context: CanvasRenderingContext2D, image: HTMLImageElement,
  options: SceneOptions, elapsed: number, reacting: boolean) {
  context.save();
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, NEW_MAP_SIZE, NEW_MAP_SIZE);
  const { x, y } = NEW_MAP_SPAWN;
  context.fillStyle = "rgba(18,38,26,.24)";
  context.beginPath(); context.ellipse(x, y - 2, PET_SIZE * .29, 3, 0, 0, Math.PI * 2); context.fill();
  const blink = !options.reducedMotion && elapsed % 6 > 5.8;
  const pose = reacting ? "greet" : blink ? "blink" : "idle";
  const frame = options.reducedMotion ? 0 : Math.floor(elapsed * (reacting ? 7 : 2)) % 4;
  context.imageSmoothingEnabled = false;
  context.drawImage(pixelSprite(pose, "front", frame, options.worldState?.equipment), x - PET_SIZE / 2, y - PET_SIZE, PET_SIZE, PET_SIZE);
  context.restore();
}

/** Temporary stationary presentation; legacy home movement and effects are left dormant. */
export function mountNewMapScene(canvas: HTMLCanvasElement, initial: SceneOptions, callbacks: SceneCallbacks): HabitatScene {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("2D canvas unavailable");
  const ctx = context;
  let options = { ...initial }, art: HTMLImageElement | null = null, disposed = false;
  let frame = 0, previous = 0, elapsed = 0, reaction = 0;
  let reactionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity: "idle" | "greet" | null = null;

  function paintWorld(target: CanvasRenderingContext2D) {
    if (!disposed && art) paintNewMap(target, art, options, elapsed, reaction > 0);
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
  function active() { return !disposed && Boolean(art) && !options.paused && !options.backgrounded && !document.hidden; }
  function cancelReactionTimer() {
    if (reactionTimer !== null) { clearTimeout(reactionTimer); reactionTimer = null; }
  }
  function tick(now: number) {
    frame = 0;
    if (!active() || options.reducedMotion) return;
    if (!previous) previous = now;
    if (now - previous >= 1000 / 30) {
      const step = Math.min((now - previous) / 1000, .05);
      elapsed += step; reaction = Math.max(0, reaction - step); previous = now; draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function resume() {
    if (!active()) return;
    if (options.reducedMotion) {
      if (reaction > 0 && reactionTimer === null) {
        reactionTimer = setTimeout(() => { reactionTimer = null; reaction = 0; if (active()) draw(); }, reaction * 1000);
      }
    } else if (!frame) { previous = 0; frame = requestAnimationFrame(tick); }
  }
  function resize() {
    const next = options.view === "world" ? 1 : Math.min(1024, Math.max(256,
      Math.round((canvas.clientWidth || 256) * Math.min(window.devicePixelRatio || 1, 3))));
    if (canvas.width !== next || canvas.height !== next) { canvas.width = next; canvas.height = next; draw(); }
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  function dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame); frame = 0; cancelReactionTimer(); observer.disconnect(); art = null;
  }
  void loadHabitatImage(WORLD_ART.map).then(image => {
    if (disposed) return;
    if (image.naturalWidth <= 0 || image.naturalHeight !== image.naturalWidth) throw new Error("Map artwork must be square");
    art = image; draw(); callbacks.ready(); resume();
  }).catch(error => { if (!disposed) { dispose(); callbacks.failure(error); } });
  return {
    position: () => ({ x: NEW_MAP_SPAWN.x, y: NEW_MAP_SPAWN.y - PET_SIZE / 2 }),
    configure(next) {
      if (disposed) return;
      options = { ...next }; cancelAnimationFrame(frame); frame = 0; previous = 0; cancelReactionTimer();
      resize(); if (active()) draw(); resume();
    },
    notice() {
      if (disposed) return;
      reaction = REACTION_SECONDS; cancelReactionTimer(); if (active()) draw(); resume();
    },
    hitPet(x, y) {
      const point = { x: NEW_MAP_FOCUS.x + x * NEW_MAP_FOCUS.width, y: NEW_MAP_FOCUS.y + y * NEW_MAP_FOCUS.height };
      return !disposed && Math.abs(point.x - NEW_MAP_SPAWN.x) < PET_SIZE / 2
        && point.y > NEW_MAP_SPAWN.y - PET_SIZE && point.y < NEW_MAP_SPAWN.y;
    },
    setTime() {}, invite() {}, moveTo() {},
    ambience: () => ({ elapsed, ecologyTime: 0, rain: 0, dusk: 0 }),
    paintJourney() {}, paintVisitors() {}, paintLighting() {}, paintWeather() {},
    paintWorld, dispose,
  };
}
