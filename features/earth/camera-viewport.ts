import type { Map as LibreMap, PaddingOptions } from "maplibre-gl";

export type EarthScreenRect = { left: number; top: number; right: number; bottom: number };
const CLEARANCE = 12;

/** Largest unobstructed rectangle, in map pixels. No assumptions about sheet height. */
export function earthCameraViewport(width: number, height: number, obstacles: readonly EarthScreenRect[]): EarthScreenRect {
  width = Number.isFinite(width) ? Math.max(1, width) : 1;
  height = Number.isFinite(height) ? Math.max(1, height) : 1;
  const margin = Math.min(CLEARANCE, width / 8, height / 8);
  const bounds = { left: margin, top: margin, right: width - margin, bottom: height - margin };
  const clipped = obstacles.filter(rect => Object.values(rect).every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top).map(rect => ({
    left: Math.max(bounds.left, rect.left - margin), right: Math.min(bounds.right, rect.right + margin),
    top: Math.max(bounds.top, rect.top - margin), bottom: Math.min(bounds.bottom, rect.bottom + margin),
  })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
  const xs = [...new Set([bounds.left, bounds.right, ...clipped.flatMap(rect => [rect.left, rect.right])])].sort((a, b) => a - b);
  const ys = [...new Set([bounds.top, bounds.bottom, ...clipped.flatMap(rect => [rect.top, rect.bottom])])].sort((a, b) => a - b);
  let best = bounds, area = 0, distance = Infinity;
  for (let l = 0; l < xs.length - 1; l++) for (let r = l + 1; r < xs.length; r++) {
    for (let t = 0; t < ys.length - 1; t++) for (let b = t + 1; b < ys.length; b++) {
      const rect = { left: xs[l], right: xs[r], top: ys[t], bottom: ys[b] };
      if (clipped.some(block => rect.left < block.right && rect.right > block.left && rect.top < block.bottom && rect.bottom > block.top)) continue;
      const nextArea = (rect.right - rect.left) * (rect.bottom - rect.top);
      const nextDistance = Math.hypot((rect.left + rect.right - width) / 2, (rect.top + rect.bottom - height) / 2);
      if (nextArea > area || nextArea === area && nextDistance < distance) { best = rect; area = nextArea; distance = nextDistance; }
    }
  }
  // If a modal covers everything, keep a finite camera until the modal closes.
  return best;
}

export function earthViewportPadding(width: number, height: number, viewport: EarthScreenRect): Required<PaddingOptions> {
  return { left: viewport.left, top: viewport.top, right: Math.max(0, width - viewport.right), bottom: Math.max(0, height - viewport.bottom) };
}

type ViewportMap = Pick<LibreMap, "getContainer" | "getCenter" | "getPadding" | "isMoving" | "easeTo" | "on" | "off">;

/** Padding moves the camera's focus point, so getCenter remains the visible atlas target. */
export function createEarthCameraViewport(map: ViewportMap) {
  const container = map.getContainer();
  const scope = container.closest("[data-earth-world]") ?? container;
  const owner = container.ownerDocument;
  const window = owner.defaultView!;
  let enabled = false, disposed = false, frame = 0, pending = false;
  let viewport = earthCameraViewport(container.clientWidth, container.clientHeight, []);
  let observed: Element[] = [];
  const resize = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(schedule) : null;
  const mutations = typeof window.MutationObserver === "function" ? new window.MutationObserver(() => { observe(); schedule(); }) : null;

  function blockers() {
    return [...scope.querySelectorAll("[data-earth-camera-blocker]"),
      ...owner.querySelectorAll('[data-earth-camera-blocker="navigation"][data-active-view="earth"]')];
  }
  function observe() {
    const elements = [container, ...blockers()];
    if (elements.length === observed.length && elements.every((element, index) => element === observed[index])) return;
    resize?.disconnect(); observed = elements;
    for (const element of elements) resize?.observe(element);
  }
  function measure() {
    const origin = container.getBoundingClientRect();
    viewport = earthCameraViewport(container.clientWidth, container.clientHeight, blockers().flatMap(element => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || window.getComputedStyle(element).visibility === "hidden") return [];
      return [{ left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top }];
    }));
    return earthViewportPadding(container.clientWidth, container.clientHeight, viewport);
  }
  function refresh(animate = true) {
    if (disposed || !enabled || owner.hidden || !container.clientWidth || !container.clientHeight) return;
    if (animate && map.isMoving()) { pending = true; return; }
    pending = false;
    const padding = measure(), previous = map.getPadding();
    if ((Object.keys(padding) as (keyof PaddingOptions)[]).every(edge => Math.abs(padding[edge] - (previous[edge] ?? 0)) < 1)) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    map.easeTo({ center: map.getCenter(), padding, duration: animate && !reduce ? 320 : 0, essential: false });
  }
  function schedule() {
    if (disposed || !enabled || frame || owner.hidden) return;
    frame = window.requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  function settled() { if (pending) refresh(); }
  map.on("moveend", settled);
  window.addEventListener("resize", schedule);
  observe();
  mutations?.observe(scope, { childList: true, subtree: true });
  return {
    refresh,
    getViewport: () => viewport,
    setEnabled(value: boolean) {
      if (disposed || enabled === value) return;
      enabled = value;
      if (value) { observe(); refresh(false); }
      else { window.cancelAnimationFrame(frame); frame = 0; pending = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false;
      window.cancelAnimationFrame(frame); resize?.disconnect(); mutations?.disconnect(); observed = [];
      window.removeEventListener("resize", schedule); map.off("moveend", settled);
    },
  };
}
