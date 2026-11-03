import { boatArtworkLayers } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";
import { paintFishingScene } from "./fishing-scene-painter";
import { fishingBoatActorPose } from "./fishing-scene-actor";
import { FISHING_WATER_TEXTURE } from "./fishing-scene-background";
import type { FishingSceneFrame, FishingSceneViewport } from "./fishing-scene-types";

const frameInterval = 1000 / 30;

/** Owns presentation clocks and resources only. It cannot submit input or award a catch. */
export function mountFishingScene(canvas: HTMLCanvasElement, initial: FishingSceneFrame): { update(frame: FishingSceneFrame): void; dispose(): void } {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return { update() {}, dispose() {} };
  const ctx = context;
  let frame = initial, disposed = false, inView = true, contextLost = false;
  let raf = 0, lastClock: number | null = null, lastPaint: number | null = null;
  let elapsed = 0, castElapsed = initial.castKey && initial.stage === "casting" ? 0 : 2, stageElapsed = initial.stage === "casting" ? 0 : 2, dirty = true;
  let pose = fishingBoatActorPose(initial.stage, castElapsed, initial.held, elapsed, false, stageElapsed);
  let viewport: FishingSceneViewport = { width: 0, height: 0, dpr: 1 };
  const images = new Map<string, HTMLImageElement>(), pending = new Map<string, HTMLImageElement>();
  const failed = new Set<string>(), seenCasts = new Set(initial.castKey ? [initial.castKey] : []);
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const present = () => !disposed && !document.hidden && inView && !contextLost && viewport.width > 0 && viewport.height > 0;
  const animated = () => present() && !media?.matches && frame.stage !== "paused";
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; lastClock = null; lastPaint = null; }
  function paint() {
    if (!present()) return;
    paintFishingScene(ctx, frame, images, viewport, { elapsed, castElapsed, stageElapsed,
      still: Boolean(media?.matches),
      pose: media?.matches ? fishingBoatActorPose(frame.stage, castElapsed, frame.held, 0, true, stageElapsed) : { ...pose } });
    dirty = false;
  }
  function tick(time: number) {
    raf = 0;
    if (!animated()) { lastClock = null; if (dirty) paint(); return; }
    // Hidden tabs and a resumed event loop never invent missed visual motion.
    const dt = lastClock === null ? 0 : Math.min(.1, Math.max(0, (time - lastClock) / 1000));
    lastClock = time; elapsed += dt; castElapsed += dt; stageElapsed += dt;
    const target = fishingBoatActorPose(frame.stage, castElapsed, frame.held, elapsed, false, stageElapsed);
    const blend = 1 - Math.exp(-dt / .12);
    pose = { angle: pose.angle + (target.angle - pose.angle) * blend,
      effort: pose.effort + (target.effort - pose.effort) * blend, lean: pose.lean + (target.lean - pose.lean) * blend };
    const continuing = animated();
    if (lastPaint === null || time - lastPaint >= frameInterval || !continuing) {
      paint();
      lastPaint = lastPaint === null ? time : time - ((time - lastPaint) % frameInterval);
    }
    if (continuing) raf = requestAnimationFrame(tick);
    else { lastClock = null; lastPaint = null; }
  }
  function redraw() {
    if (disposed) return;
    dirty = true;
    if (!animated()) { stop(); paint(); }
    else if (!raf) raf = requestAnimationFrame(tick);
  }
  function loadParts() {
    if (disposed) return;
    const parts = boatArtworkLayers({ repaired: frame.boat.repaired,
      upgrades: frame.boat.upgrades.filter(id => id === "oars" || id === "crate") });
    for (const src of [FISHING_WATER_TEXTURE, ...parts.map(part => part.src)]) {
      if (images.has(src) || pending.has(src) || failed.has(src)) continue;
      const image = new Image(); pending.set(src, image); image.decoding = "async";
      const complete = (ok: boolean) => {
        image.onload = null; image.onerror = null;
        if (disposed) return;
        pending.delete(src);
        if (ok && image.naturalWidth > 0 && image.naturalHeight > 0) images.set(src, image);
        else failed.add(src);
        redraw();
      };
      image.onload = () => complete(true); image.onerror = () => complete(false); image.src = src;
    }
  }
  function resize() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(0, rect.width), height = Math.max(0, rect.height);
    const ratio = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const dpr = Math.max(1, Math.min(2, ratio));
    viewport = { width, height, dpr };
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    redraw();
  }
  function visibility() { stop(); if (present()) { resize(); loadParts(); } }
  function retry() { if (disposed) return; failed.clear(); loadParts(); redraw(); }
  function motionChanged() { stop(); redraw(); }
  function lost(event: Event) { event.preventDefault(); contextLost = true; stop(); }
  function restored() { contextLost = false; resize(); }
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    if (disposed) return;
    const entry = entries.find(item => item.target === canvas);
    if (!entry) return;
    inView = entry.isIntersecting; visibility();
  });
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("resize", resize); window.addEventListener("online", retry); window.addEventListener("focus", retry);
  media?.addEventListener?.("change", motionChanged);
  canvas.addEventListener("contextlost", lost); canvas.addEventListener("contextrestored", restored);
  resizeObserver?.observe(canvas); intersectionObserver?.observe(canvas);
  resize(); loadParts();
  return {
    update(next: FishingSceneFrame) {
      if (disposed) return;
      // Pausing freezes an existing beat; resuming must not play another strike.
      if (next.stage !== frame.stage && next.stage !== "paused" && frame.stage !== "paused") stageElapsed = 0;
      if (next.castKey && !seenCasts.has(next.castKey)) {
        seenCasts.add(next.castKey); castElapsed = 0;
        if (seenCasts.size > 64) seenCasts.delete(seenCasts.values().next().value!);
      }
      // Restored or explicitly paused attempts already have their line in the water.
      if (next.stage === "soaking") castElapsed = Math.max(castElapsed, 1.2);
      if (next.stage === "paused" || next.stage === "bite") castElapsed = Math.max(castElapsed, 2);
      frame = next; loadParts(); redraw();
    },
    dispose() {
      if (disposed) return;
      disposed = true; stop(); resizeObserver?.disconnect(); intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", resize); window.removeEventListener("online", retry); window.removeEventListener("focus", retry);
      media?.removeEventListener?.("change", motionChanged);
      canvas.removeEventListener("contextlost", lost); canvas.removeEventListener("contextrestored", restored);
      for (const image of pending.values()) { image.onload = null; image.onerror = null; image.src = ""; }
      pending.clear(); images.clear(); failed.clear(); seenCasts.clear();
    },
  };
}
