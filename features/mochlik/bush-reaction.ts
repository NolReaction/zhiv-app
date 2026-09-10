import type { HabitatState } from "./habitat";
import { BUSH_FOLIAGE, HOME_CANVAS_SIZE, homePixel } from "./home-layout";
import { FOREST_MAP } from "@/features/world/map-manifest";

const bounds = {
  x: Math.min(...BUSH_FOLIAGE.map(point => point.x)),
  y: Math.min(...BUSH_FOLIAGE.map(point => point.y)),
  width: Math.max(...BUSH_FOLIAGE.map(point => point.x)) - Math.min(...BUSH_FOLIAGE.map(point => point.x)),
  height: Math.max(...BUSH_FOLIAGE.map(point => point.y)) - Math.min(...BUSH_FOLIAGE.map(point => point.y)),
};
const center = {
  x: BUSH_FOLIAGE.reduce((sum, point) => sum + point.x, 0) / BUSH_FOLIAGE.length,
  y: BUSH_FOLIAGE.reduce((sum, point) => sum + point.y, 0) / BUSH_FOLIAGE.length,
};
// Each triangle keeps its outer edge fixed. Only the inner canopy flexes, so no
// shifted map edge, painted replacement, or duplicate bush silhouette is visible.
const wedges = BUSH_FOLIAGE.map((a, index) => {
  const b = BUSH_FOLIAGE[(index + 1) % BUSH_FOLIAGE.length];
  const nx = a.y - b.y, ny = b.x - a.x, offset = a.x * b.y - b.x * a.y;
  const divisor = nx * center.x + ny * center.y + offset;
  return { a, b, nx: nx / divisor, ny: ny / divisor, offset: offset / divisor };
});
const leafOrigin = homePixel(FOREST_MAP.bush.inside);
const leafColors = ["#adb65f", "#7e9b44", "#c0c276", "#91ad51", "#a6b35b"];
const pulse = (value: number) => value <= 0 || value >= 1 ? 0 : Math.sin(Math.PI * value) ** 2;

/** Small, deterministic reactions share the pet's clock, including pause/resume. */
export function bushReactionFrame(state: HabitatState, reducedMotion = false) {
  if (reducedMotion || state.layer !== "bush" || state.travel === "away") return { x: 0, y: 0, leaves: -1 };
  const p = state.progress;
  if (state.activity === "jump") {
    const q = (p - .65) / .35, strength = pulse(q);
    return { x: Math.sin(q * Math.PI * 3) * strength * 2.2, y: strength * 1.25, leaves: q };
  }
  if (state.activity === "emerge") {
    const q = p / .65, strength = pulse(q);
    return { x: -Math.sin(q * Math.PI * 3) * strength * 2.4, y: -strength * 1.4, leaves: q };
  }
  if (state.activity === "peek") {
    const strength = pulse(p);
    return { x: Math.sin(p * Math.PI * 4) * strength * .65, y: -strength * .7, leaves: -1 };
  }
  if (state.activity === "hide") {
    const q = state.activityTime / .8, strength = pulse(q) * (1 - Math.min(1, q));
    return { x: Math.sin(q * Math.PI * 4) * strength * 1.4, y: strength * .35, leaves: -1 };
  }
  return { x: 0, y: 0, leaves: -1 };
}

/** Cache only the bush pixels at the current source resolution; never alter assets. */
export function prepareBushFoliage(source: CanvasImageSource, crop: { x: number; y: number; size: number }) {
  const scale = crop.size / HOME_CANVAS_SIZE;
  const texture = document.createElement("canvas");
  texture.width = Math.round(bounds.width * scale); texture.height = Math.round(bounds.height * scale);
  const ctx = texture.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, crop.x + bounds.x * scale, crop.y + bounds.y * scale,
    bounds.width * scale, bounds.height * scale, 0, 0, texture.width, texture.height);
  return texture;
}

export function drawBushReaction(ctx: CanvasRenderingContext2D, texture: HTMLCanvasElement | null,
  state: HabitatState, reducedMotion: boolean) {
  const frame = bushReactionFrame(state, reducedMotion);
  if (frame.x === 0 && frame.y === 0) return;
  if (texture) {
    ctx.save(); ctx.beginPath();
    BUSH_FOLIAGE.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath(); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    for (const wedge of wedges) {
      const moved = { x: center.x + frame.x, y: center.y + frame.y };
      const mid = { x: (wedge.a.x + wedge.b.x + moved.x) / 3, y: (wedge.a.y + wedge.b.y + moved.y) / 3 };
      ctx.save(); ctx.beginPath();
      // Slight internal overlap closes canvas antialias cracks; the outer clip
      // keeps the original perimeter fixed to exactly the same painted pixels.
      [wedge.a, wedge.b, moved].forEach((point, index) => {
        const x = mid.x + (point.x - mid.x) * 1.025, y = mid.y + (point.y - mid.y) * 1.025;
        if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath(); ctx.clip();
      ctx.transform(1 + frame.x * wedge.nx, frame.y * wedge.nx, frame.x * wedge.ny,
        1 + frame.y * wedge.ny, frame.x * wedge.offset, frame.y * wedge.offset);
      ctx.drawImage(texture, bounds.x, bounds.y, bounds.width, bounds.height);
      ctx.restore();
    }
    ctx.restore();
  }
  const q = frame.leaves;
  if (q <= 0 || q >= 1) return;
  ctx.save(); ctx.globalAlpha = pulse(q) * .85;
  for (let index = 0; index < leafColors.length; index++) {
    const spread = index - 2;
    const x = leafOrigin.x + spread * 5 + spread * q * 6 + Math.sin(q * 9 + index) * q * 2;
    const y = leafOrigin.y - 12 - Math.sin(q * Math.PI) * (9 + index * 2) + q * 4;
    ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.rotate(spread * .5 + q * Math.PI * 2);
    ctx.fillStyle = leafColors[index]; ctx.beginPath(); ctx.ellipse(0, 0, 1.6, .65, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
