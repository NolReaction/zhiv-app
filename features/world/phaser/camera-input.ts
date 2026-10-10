import type Phaser from "phaser";
import type { FixedWorldScene, WorldBounds, WorldPoint } from "@/features/world/tiled/types";

type InputCallbacks = {
  tap(point: WorldPoint): void;
  beginDrag(point: WorldPoint): boolean;
  moveDrag(delta: WorldPoint): void;
  endDrag(): void;
  cancelDrag(): void;
};

/** Native pointer events keep mouse, pen and two-finger gestures on one canvas. */
export function createPhaserCameraInput(
  scene: Phaser.Scene,
  parent: HTMLElement,
  world: FixedWorldScene,
  callbacks: InputCallbacks,
) {
  const canvas = scene.game.canvas;
  const camera = scene.cameras.main;
  const pointers = new Map<number, WorldPoint>();
  let cssWidth = 1, cssHeight = 1, density = 1, zoom = 1;
  let center = { x: world.focus.x + world.focus.width / 2, y: world.focus.y + world.focus.height / 2 };
  let start = { x: 0, y: 0 }, previous = { x: 0, y: 0 };
  let editing = false, moved = false, suppressTap = false;
  let pinchDistance = 0;
  let pinchMidpoint: WorldPoint | null = null;
  let disposed = false;

  function limits(value: number) {
    const minimum = Math.max(0.15, Math.min(cssWidth / world.width, cssHeight / world.height) * 0.8);
    return Math.max(minimum, Math.min(6, value));
  }
  function applyCamera() {
    const halfWidth = cssWidth / zoom / 2, halfHeight = cssHeight / zoom / 2;
    center.x = halfWidth >= world.width / 2 ? world.width / 2 : Math.max(halfWidth, Math.min(world.width - halfWidth, center.x));
    center.y = halfHeight >= world.height / 2 ? world.height / 2 : Math.max(halfHeight, Math.min(world.height - halfHeight, center.y));
    camera.setZoom(zoom * density).centerOn(center.x, center.y);
  }
  function toWorld(point: WorldPoint): WorldPoint {
    // This camera has no rotation or follow effects. Avoid the previous frame's matrix during a gesture.
    return { x: center.x + (point.x - cssWidth / 2) / zoom, y: center.y + (point.y - cssHeight / 2) / zoom };
  }
  function screenPoint(event: MouseEvent | PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * cssWidth / bounds.width, y: (event.clientY - bounds.top) * cssHeight / bounds.height };
  }
  function zoomAt(value: number, point = { x: cssWidth / 2, y: cssHeight / 2 }) {
    const before = toWorld(point);
    zoom = limits(value);
    const after = toWorld(point);
    center.x += before.x - after.x;
    center.y += before.y - after.y;
    applyCamera();
  }
  function cancelEdit() {
    if (editing) callbacks.cancelDrag();
    editing = false;
  }
  function pinch() {
    const [a, b] = [...pointers.values()];
    return { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function pointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const point = screenPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) {
      start = previous = point;
      moved = suppressTap = false;
      editing = event.button === 0 && callbacks.beginDrag(toWorld(point));
    } else if (pointers.size >= 2) {
      cancelEdit();
      suppressTap = true;
      const gesture = pinch();
      pinchDistance = gesture.distance;
      pinchMidpoint = gesture.midpoint;
    }
  }
  function pointerMove(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    const point = screenPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size >= 2) {
      const gesture = pinch();
      if (pinchMidpoint) {
        center.x -= (gesture.midpoint.x - pinchMidpoint.x) / zoom;
        center.y -= (gesture.midpoint.y - pinchMidpoint.y) / zoom;
      }
      zoomAt(zoom * gesture.distance / pinchDistance, gesture.midpoint);
      pinchDistance = gesture.distance;
      pinchMidpoint = gesture.midpoint;
      return;
    }
    if (Math.hypot(point.x - start.x, point.y - start.y) > 6) moved = true;
    if (moved && editing) callbacks.moveDrag({ x: (point.x - start.x) / zoom, y: (point.y - start.y) / zoom });
    else if (moved || suppressTap) {
      center.x -= (point.x - previous.x) / zoom;
      center.y -= (point.y - previous.y) / zoom;
      applyCamera();
    }
    previous = point;
  }
  function pointerUp(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    if (pointers.size === 1) {
      if (editing && moved) callbacks.endDrag();
      else {
        cancelEdit();
        if (!moved && !suppressTap && event.button === 0) callbacks.tap(toWorld(screenPoint(event)));
      }
      editing = false;
    }
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pinchMidpoint = null;
    if (pointers.size >= 2) {
      const gesture = pinch();
      pinchDistance = gesture.distance;
      pinchMidpoint = gesture.midpoint;
    } else if (pointers.size === 1) {
      previous = start = [...pointers.values()][0];
      suppressTap = true;
      moved = false;
    }
  }
  function cancelPointers() {
    cancelEdit();
    const captured = [...pointers.keys()];
    pointers.clear();
    for (const id of captured) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    pinchMidpoint = null;
    suppressTap = true;
  }
  function lostCapture(event: PointerEvent) {
    if (pointers.has(event.pointerId)) cancelPointers();
  }
  function wheel(event: WheelEvent) {
    event.preventDefault();
    cancelPointers();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * cssHeight : event.deltaY;
    zoomAt(zoom * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0015), screenPoint(event));
  }
  function focus(bounds: WorldBounds) {
    cancelPointers();
    center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    zoom = limits(Math.min(cssWidth / Math.max(1, bounds.width), cssHeight / Math.max(1, bounds.height)) * 0.84);
    applyCamera();
  }
  function keyDown(event: KeyboardEvent) {
    if (document.activeElement !== canvas || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const step = 36 / zoom;
    if (["arrowleft", "a"].includes(key)) center.x -= step;
    else if (["arrowright", "d"].includes(key)) center.x += step;
    else if (["arrowup", "w"].includes(key)) center.y -= step;
    else if (["arrowdown", "s"].includes(key)) center.y += step;
    else if (["+", "="].includes(key)) zoomAt(zoom * 1.2);
    else if (["-", "_"].includes(key)) zoomAt(zoom / 1.2);
    else if (key === "0") focus({ x: 0, y: 0, width: world.width, height: world.height });
    else if (key === "escape") cancelPointers();
    else return;
    event.preventDefault();
    applyCamera();
  }
  function resize() {
    if (disposed) return;
    const bounds = parent.getBoundingClientRect();
    cssWidth = Math.max(1, bounds.width);
    cssHeight = Math.max(1, bounds.height);
    density = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    scene.scale.resize(Math.round(cssWidth * density), Math.round(cssHeight * density));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    camera.setViewport(0, 0, Math.round(cssWidth * density), Math.round(cssHeight * density));
    zoom = limits(zoom);
    applyCamera();
  }
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Карта Phaser. Стрелки или WASD двигают камеру, плюс и минус меняют масштаб, ноль показывает весь лес.");
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", cancelPointers);
  canvas.addEventListener("lostpointercapture", lostCapture);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("keydown", keyDown);
  window.addEventListener("blur", cancelPointers);
  const observer = new ResizeObserver(resize);
  observer.observe(parent);
  resize();

  return {
    get zoom() { return zoom; },
    focus,
    zoomBy(factor: number) { if (Number.isFinite(factor) && factor > 0) zoomAt(zoom * factor); },
    cancel: cancelPointers,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPointers();
      observer.disconnect();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", cancelPointers);
      canvas.removeEventListener("lostpointercapture", lostCapture);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", keyDown);
      window.removeEventListener("blur", cancelPointers);
    },
  };
}
