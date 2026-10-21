const PAN_PADDING_CSS = 32;
const MAX_PAN_PIXELS = 4 * 1024 * 1024;
const STYLE_KEYS = ["position", "left", "top", "width", "height", "transform"] as const;

type PanGeometry = {
  normalWidth: number; normalHeight: number; width: number; height: number;
  padX: number; padY: number; ratioX: number; ratioY: number;
};

/** Reuses the displayed canvas itself; no extra raster, copy, or lower DPR. */
export function createMapPanSurface(canvas: HTMLCanvasElement) {
  const originalStyle = STYLE_KEYS.map(key => canvas.style[key] ?? "");
  let geometry: PanGeometry | null = null, active = false;
  const restoreStyle = () => STYLE_KEYS.forEach((key, index) => { canvas.style[key] = originalStyle[index]; });
  const backing = (width: number, height: number) => {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };
  function reset() {
    if (!active) return;
    active = false; restoreStyle();
    if (geometry) backing(geometry.normalWidth, geometry.normalHeight);
  }
  return {
    get active() { return active; },
    get geometry() { return geometry; },
    configure(view: { width: number; height: number }, normalWidth: number, normalHeight: number) {
      if (active) { active = false; restoreStyle(); }
      backing(normalWidth, normalHeight);
      const ratioX = normalWidth / view.width, ratioY = normalHeight / view.height;
      // Whole backing pixels keep the original viewport at the same raster phase.
      const padX = Math.ceil(PAN_PADDING_CSS * ratioX), padY = Math.ceil(PAN_PADDING_CSS * ratioY);
      const width = normalWidth + padX * 2, height = normalHeight + padY * 2;
      geometry = Number.isFinite(ratioX + ratioY) && ratioX > 0 && ratioY > 0
        && width * height <= MAX_PAN_PIXELS
        ? { normalWidth, normalHeight, width, height, padX, padY, ratioX, ratioY } : null;
    },
    activate() {
      if (!geometry) return false;
      if (active) return true;
      const { width, height, padX, padY, ratioX, ratioY } = geometry;
      active = true;
      backing(width, height);
      canvas.style.position = "absolute";
      canvas.style.left = `${-padX / ratioX}px`; canvas.style.top = `${-padY / ratioY}px`;
      canvas.style.width = `${width / ratioX}px`; canvas.style.height = `${height / ratioY}px`;
      canvas.style.transform = "translate(0px, 0px)";
      return true;
    },
    present(dx: number, dy: number) {
      if (!active || !geometry || !Number.isFinite(dx + dy)
        || Math.abs(dx) > geometry.padX / geometry.ratioX
        || Math.abs(dy) > geometry.padY / geometry.ratioY) return false;
      canvas.style.transform = `translate(${dx}px, ${dy}px)`;
      return true;
    },
    reset,
    dispose() { reset(); geometry = null; },
  };
}
