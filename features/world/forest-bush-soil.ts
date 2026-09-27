import type { WorldBounds, WorldPoint } from "./tiled/types";

export type ForestBushSoil = {
  bounds: WorldBounds; center: WorldPoint; radiusX: number; radiusY: number; wateringPoint: WorldPoint;
};
type SoilTexture = { dry: HTMLCanvasElement; wet: HTMLCanvasElement };
const shapes = new WeakMap<readonly WorldPoint[], ForestBushSoil | null>();
const textures = new WeakMap<ForestBushSoil, SoilTexture>();
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Root bed sits under the lower leaves; the watering lip is reachable without aiming into the crown. */
export function forestBushSoilGeometry(points: readonly WorldPoint[], entry?: WorldPoint): ForestBushSoil | null {
  if (!shapes.has(points)) {
    if (points.length < 3 || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) {
      shapes.set(points, null);
    } else {
      const xs = points.map(point => point.x), ys = points.map(point => point.y);
      const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
      if (width <= 0 || height <= 0) shapes.set(points, null);
      else {
        const radiusX = width * .43, radiusY = Math.min(width, height) * .125;
        const center = { x: x + width * .5, y: y + height - radiusY * .2 };
        const padding = Math.min(width, height) * .055;
        shapes.set(points, { center, radiusX, radiusY,
          bounds: { x: center.x - radiusX - padding, y: center.y - radiusY - padding,
            width: (radiusX + padding) * 2, height: (radiusY + padding) * 2 },
          wateringPoint: { x: center.x, y: center.y + radiusY * .62 } });
      }
    }
  }
  const shape = shapes.get(points)!;
  if (!shape || !entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return shape;
  // The front lip stays outside the low leaves, even when the entry was authored far to one side.
  const side = Math.max(-.48, Math.min(.48, (entry.x - shape.center.x) / shape.radiusX));
  return { ...shape, wateringPoint: { x: shape.center.x + shape.radiusX * side,
    y: shape.center.y + shape.radiusY * (.68 - Math.abs(side) * .1) } };
}

function outline(ctx: CanvasRenderingContext2D, shape: ForestBushSoil, expansion = 1) {
  ctx.beginPath();
  for (let i = 0; i < 48; i++) {
    const angle = i * Math.PI / 24;
    const radius = expansion * (1 + Math.sin(angle * 5 + .4) * .033 + Math.cos(angle * 9 - .7) * .022);
    const x = shape.center.x + Math.cos(angle) * shape.radiusX * radius;
    const y = shape.center.y + Math.sin(angle) * shape.radiusY * radius;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

function textureFor(shape: ForestBushSoil): SoilTexture | null {
  const previous = textures.get(shape);
  if (previous) return previous;
  if (typeof document === "undefined") return null;
  // The visible bed tucks behind the lower crown. Keep the authored watering lip
  // stable so a visual adjustment cannot move the hand or the stream's destination.
  const bed = { ...shape, center: { x: shape.center.x, y: shape.center.y - shape.radiusY * .28 },
    radiusX: shape.radiusX * .80, radiusY: shape.radiusY * .95 };
  const { center, radiusX, radiusY } = bed, { bounds } = shape;
  const scale = Math.min(3, 256 / Math.max(bounds.width, bounds.height));
  const surface = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    return canvas;
  };
  const dry = surface(), wet = surface(), dryCtx = dry.getContext("2d"), wetCtx = wet.getContext("2d");
  if (!dryCtx || !wetCtx) return null;
  for (const [ctx, damp] of [[dryCtx, false], [wetCtx, true]] as const) {
    ctx.scale(scale, scale); ctx.translate(-bounds.x, -bounds.y);
    // Warm olive edges blend into the painted grass; the interior remains visibly earthy.
    ctx.filter = `blur(${radiusY * .11 * scale}px)`;
    outline(ctx, bed, 1.055); ctx.fillStyle = damp ? "rgba(49,42,21,.5)" : "rgba(85,78,32,.35)"; ctx.fill();
    ctx.filter = "none";
    ctx.save(); outline(ctx, bed); ctx.clip();
    const fill = ctx.createLinearGradient(center.x, center.y - radiusY, center.x, center.y + radiusY);
    fill.addColorStop(0, damp ? "#3d3823" : "#69603a");
    fill.addColorStop(.65, damp ? "#514228" : "#927247");
    fill.addColorStop(1, damp ? "#605034" : "#a18a50");
    ctx.fillStyle = fill; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    // Stable small clods and broken root lines are baked once, shared by both cameras.
    for (let i = 0; i < 96; i++) {
      const angle = i * 2.3999632297, distance = Math.sqrt((i + .5) / 96);
      const x = center.x + Math.cos(angle) * radiusX * distance;
      const y = center.y + Math.sin(angle) * radiusY * distance;
      ctx.fillStyle = i % 3 ? (damp ? "rgba(31,29,15,.18)" : "rgba(66,52,28,.24)")
        : damp ? "rgba(177,162,112,.16)" : "rgba(194,173,110,.27)";
      ctx.beginPath(); ctx.ellipse(x, y, radiusY * (.05 + i % 4 * .018), radiusY * (.025 + i % 3 * .015), -.3, 0, Math.PI * 2); ctx.fill();
    }
    // Short woody roots emerge from underneath the cutout and join the soil.
    // Most of each root is covered by leaves; the few exposed tips break the
    // detached "ball over an oval" silhouette without a second foliage sprite.
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let i = 0; i < 3; i++) {
      const side = i - 1, startX = center.x + side * radiusX * .14;
      const middleX = center.x + side * radiusX * .46, endX = center.x + side * radiusX * .82;
      const endY = center.y + radiusY * (side ? .55 : .8);
      ctx.strokeStyle = damp ? "#403c24" : "#645333"; ctx.lineWidth = radiusY * .27;
      ctx.beginPath(); ctx.moveTo(startX, center.y - radiusY * .85);
      ctx.lineTo(middleX, center.y + radiusY * .08); ctx.lineTo(endX, endY); ctx.stroke();
      ctx.strokeStyle = damp ? "rgba(140,124,66,.45)" : "rgba(184,157,84,.55)"; ctx.lineWidth = radiusY * .07;
      ctx.beginPath(); ctx.moveTo(startX - radiusY * .04, center.y - radiusY * .8);
      ctx.lineTo(middleX - radiusY * .04, center.y); ctx.lineTo(endX, endY - radiusY * .04); ctx.stroke();
    }
    ctx.restore();
    // Interrupt the edge with tiny grass-coloured chips instead of a clean ellipse border.
    for (let i = 0; i < 25; i++) {
      const angle = i * 2.3999632297;
      const x = center.x + Math.cos(angle) * radiusX * (.96 + i % 3 * .017);
      const y = center.y + Math.sin(angle) * radiusY * (.96 + i % 3 * .017);
      ctx.fillStyle = i % 2 ? "rgba(113,121,42,.48)" : "rgba(133,133,48,.38)";
      ctx.beginPath(); ctx.ellipse(x, y, radiusY * .07, radiusY * .027, angle, 0, Math.PI * 2); ctx.fill();
    }
    // Fade through the grass at the ragged edge, avoiding a sticker-like opaque oval.
    ctx.save(); ctx.translate(center.x, center.y); ctx.scale(radiusX, radiusY);
    ctx.globalCompositeOperation = "destination-in";
    const edge = ctx.createRadialGradient(0, 0, .63, 0, 0, 1.09);
    edge.addColorStop(0, "#000"); edge.addColorStop(.5, "rgba(0,0,0,.88)"); edge.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = edge; ctx.fillRect(-1.2, -1.4, 2.4, 2.8); ctx.restore();
  }
  const texture = { dry, wet }; textures.set(shape, texture); return texture;
}

/** Existing moisture drives a slow visual dry-down; no new state, clocks or puddles. */
export function drawForestBushSoil(ctx: CanvasRenderingContext2D, points: readonly WorldPoint[], moisture = .32) {
  const shape = forestBushSoilGeometry(points), texture = shape && textureFor(shape);
  if (!shape || !texture) return;
  const { bounds } = shape, wet = unit((moisture - .12) / .88);
  ctx.save();
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * .82;
  ctx.drawImage(texture.dry, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.globalAlpha = alpha * .82 * wet;
  if (wet > 0) ctx.drawImage(texture.wet, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}
