import type { Map as LibreMap } from "maplibre-gl";

type TouchPitchMap = Pick<LibreMap, "getCanvasContainer" | "getPitch" | "getMinPitch" | "getMaxPitch" | "setPitch" | "stop" | "touchPitch">;
type Point = { x: number; y: number };
type Gesture = { ids: [number, number]; start: [Point, Point]; pitch: number; claimed: boolean };
const point = (touch: Touch): Point => ({ x: touch.clientX, y: touch.clientY });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);

/**
 * MapLibre's native pitch accepts fingers side by side only. Extend that one
 * missing orientation; pinch, rotation and horizontal-finger pitch stay native.
 * All work belongs to real touch events, without a second animation loop.
 */
export function createEarthTouchPitch(map: TouchPitchMap) {
  const canvas = map.getCanvasContainer();
  const owner = canvas.ownerDocument;
  let enabled = false, disposed = false;
  let gesture: Gesture | null = null;

  function finish() {
    const claimed = gesture?.claimed;
    gesture = null;
    if (claimed) map.stop();
  }
  function available() { return enabled && !disposed && !owner.hidden && map.touchPitch.isEnabled(); }
  function consume(event: TouchEvent) { event.preventDefault(); event.stopImmediatePropagation(); }
  function start(event: TouchEvent) {
    if (!available()) { finish(); return; }
    // A browser can drop touchend when a retained tab is covered. A fresh first
    // finger starts a new sequence rather than inheriting the previous claim.
    if (gesture?.claimed && event.touches.length !== 1) { event.stopImmediatePropagation(); return; }
    finish();
    if (event.touches.length !== 2) return;
    const a = event.touches[0], b = event.touches[1];
    const first = point(a), second = point(b);
    if (Math.abs(first.y - second.y) <= Math.abs(first.x - second.x) || distance(first, second) < 20) return;
    gesture = { ids: [a.identifier, b.identifier], start: [first, second], pitch: map.getPitch(), claimed: false };
  }
  function move(event: TouchEvent) {
    if (!gesture) return;
    if (!available()) { finish(); return; }
    if (event.touches.length !== 2) {
      if (gesture.claimed) consume(event);
      else finish();
      return;
    }
    const a = Array.from(event.touches).find(touch => touch.identifier === gesture!.ids[0]);
    const b = Array.from(event.touches).find(touch => touch.identifier === gesture!.ids[1]);
    if (!a || !b) { if (gesture.claimed) consume(event); else finish(); return; }
    const first = point(a), second = point(b), [initialA, initialB] = gesture.start;
    const dxA = first.x - initialA.x, dxB = second.x - initialB.x;
    const dyA = first.y - initialA.y, dyB = second.y - initialB.y;
    const dy = (dyA + dyB) / 2;
    if (!gesture.claimed) {
      const scale = Math.abs(Math.log2(distance(first, second) / distance(initialA, initialB)));
      const turn = Math.abs(Math.atan2(Math.sin(angle(first, second) - angle(initialA, initialB)),
        Math.cos(angle(first, second) - angle(initialA, initialB))));
      // Once a pinch/rotation/pan is clear, leave its whole sequence to the SDK.
      if (scale >= .1 || turn >= Math.PI / 15) { finish(); return; }
      if (Math.hypot(dxA, dyA) < 6 || Math.hypot(dxB, dyB) < 6) return;
      if (dyA * dyB <= 0 || Math.abs(dyA) < Math.abs(dxA) * 1.4 || Math.abs(dyB) < Math.abs(dxB) * 1.4) { finish(); return; }
      if (Math.abs(dy) < 8) return;
      gesture.claimed = true;
      // Public stop also clears queued native pan/inertia before this sequence
      // takes over. No native handlers or SDK prototypes are replaced.
      map.stop();
    }
    consume(event);
    const pitch = Math.max(map.getMinPitch(), Math.min(map.getMaxPitch(), gesture.pitch - dy * .5));
    if (Number.isFinite(pitch) && pitch !== map.getPitch()) map.setPitch(pitch, { originalEvent: event });
  }
  function end(event: TouchEvent) {
    if (!gesture) return;
    if (gesture.claimed) {
      consume(event);
      if (event.touches.length) return;
    }
    finish();
  }
  function cancel(event: TouchEvent) { if (gesture?.claimed) consume(event); finish(); }
  function visibility() { if (owner.hidden) finish(); }
  // Safari's native double-tap path requires a passive touchstart listener.
  canvas.addEventListener("touchstart", start, { capture: true, passive: true });
  canvas.addEventListener("touchmove", move, { capture: true, passive: false });
  canvas.addEventListener("touchend", end, { capture: true, passive: false });
  canvas.addEventListener("touchcancel", cancel, { capture: true, passive: false });
  owner.addEventListener("visibilitychange", visibility);
  return {
    setEnabled(value: boolean) { if (disposed) return; enabled = value; if (!value) finish(); },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; finish();
      canvas.removeEventListener("touchstart", start, true);
      canvas.removeEventListener("touchmove", move, true);
      canvas.removeEventListener("touchend", end, true);
      canvas.removeEventListener("touchcancel", cancel, true);
      owner.removeEventListener("visibilitychange", visibility);
    },
  };
}
