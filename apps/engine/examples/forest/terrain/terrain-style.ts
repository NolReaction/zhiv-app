import { hash, sampleGround, TRAILS, type Point } from "./layout";
import { terrainAppearance, type TerrainMaterial, type TerrainState } from "./terrain-data";
import type { WaterContour } from "@/packages/engine/src/terrain/contours";

type Bounds = { x: number; y: number; width: number; height: number };
function trace(ctx: CanvasRenderingContext2D, points: readonly Point[], closed = false, offsetY = 0) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1] + offsetY);
  for (let index = 1; index < points.length; index++) ctx.lineTo(points[index][0], points[index][1] + offsetY);
  if (closed) ctx.closePath();
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, angle = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2);
  ctx.fill();
}

/** Every mark is addressed by world coordinates; the guard band preserves marks crossing chunks. */
function drawGround(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, baseTrails: boolean, material?: Exclude<TerrainMaterial, "water">) {
  ctx.fillStyle = material === "path" ? "#c0a368" : material === "sand" ? "#d2b17a" : "#536c34";
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

  if (material !== "path" && material !== "sand") for (let gy = Math.floor(bounds.y / 96) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 96) + 2; gy++) {
    for (let gx = Math.floor(bounds.x / 96) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 96) + 2; gx++) {
      const x = gx * 96 + hash(gx, gy, seed) * 48, y = gy * 96 + hash(gx, gy, seed + 1) * 48;
      const sample = sampleGround(x, y, baseTrails);
      const radius = 74 + hash(gx, gy, seed + 2) * 57;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, sample.clearing > 0.25 ? "#8b9b44a8" : hash(gx, gy, seed + 3) > 0.45 ? "#7787357c" : "#284e3470");
      gradient.addColorStop(1, "#63753200");
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [extra, color] of [[25, "#75833c70"], [15, "#99954c80"], [7, "#b59f61a8"], [0, "#c0a368"], [-10, "#c9ae76a0"]] as const) {
    ctx.strokeStyle = color;
    for (const trail of !material && baseTrails ? TRAILS : []) {
      trace(ctx, trail.points);
      ctx.lineWidth = trail.width + extra;
      ctx.stroke();
    }
  }

  // Soil flecks vary in size, direction and tone instead of exposing a repeated tile.
  const grass = ["#8a984558", "#a1aa505e", "#364f3054", "#6c883a73", "#aec05d53"];
  const soil = ["#e2c58d99", "#a588526b", "#9e8b5677", "#d4b97eaa"];
  for (let gy = Math.floor(bounds.y / 11) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 11) + 2; gy++) {
    for (let gx = Math.floor(bounds.x / 11) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 11) + 2; gx++) {
      const r = hash(gx, gy, seed + 11), r2 = hash(gx, gy, seed + 12);
      const x = gx * 11 + r * 11, y = gy * 11 + r2 * 11;
      const sample = sampleGround(x, y, baseTrails);
      const onPath = material === "path" || material === "sand" || (!material && sample.path > 0.45);
      const palette = material === "sand" ? ["#f2cf9499", "#bd9b696b", "#c19d6477", "#e7c48caa"] : onPath ? soil : grass;
      ctx.fillStyle = palette[Math.floor(hash(gx, gy, seed + 13) * palette.length)];
      ellipse(ctx, x, y, 0.9 + r * 2.4, 0.6 + r2 * 1.1, (r - 0.5) * 2.5);
      if (!onPath && r > 0.66) {
        ctx.fillStyle = r2 > 0.55 ? "#a6b35380" : "#8b9e4680";
        ctx.beginPath();
        ctx.moveTo(x + 1, y + 1);
        ctx.quadraticCurveTo(x - 2, y - 1, x - 2 - r * 1.5, y - 2 - r2 * 2);
        ctx.quadraticCurveTo(x + 1, y - 2, x + 2, y + 1);
        ctx.fill();
        if (r > 0.78) {
          ctx.fillStyle = "#374f327a";
          ellipse(ctx, x + 3, y + 3, 3 + r2 * 2, 1);
        }
      } else if (onPath && r > 0.93) {
        ctx.fillStyle = "#8c805f";
        ellipse(ctx, x, y, 2, 1.3);
        ctx.fillStyle = "#e8d6a6";
        ellipse(ctx, x - 0.4, y - 0.7, 1.4, 0.7);
      }
      if (sample.path > 0.02 && sample.path < 0.58 && r2 > 0.38) {
        // Small clumps break up the road outline at the transition to grass.
        ctx.fillStyle = "#8b9448b3";
        ellipse(ctx, x, y, 1.7 + r * 4.5, 1 + r2 * 2, r * 3);
      }
    }
  }
}

export function waterPath(ctx: CanvasRenderingContext2D, contours: readonly WaterContour[], offsetY = 0) {
  ctx.beginPath();
  for (const contour of contours) {
    const points = contour.points;
    ctx.moveTo(points[0][0], points[0][1] + offsetY);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1] + offsetY);
    ctx.closePath();
  }
}

export function drawWaterTexture(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds) {
  const water = ctx.createLinearGradient(0, 900, 0, 1900);
  water.addColorStop(0, "#187d92"); water.addColorStop(.35, "#12869b"); water.addColorStop(1, "#12617c");
  ctx.fillStyle = water; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  for (let gy = Math.floor(bounds.y / 18) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 18) + 2; gy++) {
    for (let gx = Math.floor(bounds.x / 37) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 37) + 2; gx++) {
      const r = hash(gx, gy, seed + 30), x = gx * 37 + r * 22, y = gy * 18 + hash(gx, gy, seed + 31) * 12;
      ctx.strokeStyle = r > .55 ? "#6bb9bd45" : "#064d7042"; ctx.lineWidth = r > .75 ? 1.2 : .7;
      ctx.beginPath(); ctx.moveTo(x - 13, y); ctx.bezierCurveTo(x - 6, y - 3, x - 1, y + 3, x + 5, y);
      ctx.bezierCurveTo(x + 12, y - 3, x + 14, y, x + 23, y - 1); ctx.stroke();
      if (r > .87) { ctx.strokeStyle = "#a2d3c250"; ctx.beginPath(); ctx.moveTo(x - 6, y - 1); ctx.lineTo(x + 1, y - 1); ctx.stroke(); }
    }
  }
}

export function drawShore(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, contours: readonly WaterContour[], state: TerrainState) {
  const settings = terrainAppearance(state), stone = settings.shoreStyle === "stone", height = settings.shoreHeight;
  if (settings.shoreStyle === "none") return;
  ctx.save(); waterPath(ctx, contours); ctx.clip("evenodd");
  if (height > 0) {
    waterPath(ctx, contours, height * .8); ctx.strokeStyle = "#103f4b45"; ctx.lineWidth = height + 7; ctx.stroke();
    for (const contour of contours) {
      for (let i = 0; i < contour.points.length; i++) {
        const a = contour.points[i], b = contour.points[(i + 1) % contour.points.length];
        if (Math.max(a[0], b[0]) < bounds.x - 3 || Math.min(a[0], b[0]) > bounds.x + bounds.width + 3
          || Math.max(a[1], b[1]) + height < bounds.y - 3 || Math.min(a[1], b[1]) > bounds.y + bounds.height + 3) continue;
        const normal = (contour.normals[i][1] + contour.normals[(i + 1) % contour.normals.length][1]) * .5;
        const light = Math.round(75 + Math.max(-1, Math.min(1, normal)) * 18);
        ctx.fillStyle = stone ? `rgb(${light},${light + 21},${light + 9})` : `rgb(${light + 40},${light + 25},${light - 8})`;
        // One shared vertical drop and shared vertices leave no cracks or random steps.
        ctx.beginPath(); ctx.moveTo(a[0], a[1] - .7); ctx.lineTo(b[0], b[1] - .7);
        ctx.lineTo(b[0], b[1] + height); ctx.lineTo(a[0], a[1] + height); ctx.closePath(); ctx.fill();
      }
    }
  }
  waterPath(ctx, contours); ctx.strokeStyle = stone ? "#71b4a52c" : "#83b9a43b"; ctx.lineWidth = stone ? 9 : 15; ctx.stroke();
  if (stone && height > 0) {
    ctx.strokeStyle = "#334f4999"; ctx.lineWidth = .8;
    for (const contour of contours) {
      // Arc distance is re-anchored at stable world regions, so a local edit does
      // not shift mortar marks along the rest of a connected lake.
      const zoneFor = (point: Point) => `${Math.floor(point[0] / 128)}:${Math.floor(point[1] / 128)}`;
      let zone = zoneFor(contour.points[0]), distance = 0, count = 0;
      // Include the wrapped prefix when the canonical loop start lies inside
      // a region. Moving that start cannot move mortar marks in another chunk.
      for (let i = contour.points.length - 1; i >= 0 && zoneFor(contour.points[i]) === zone; i--) {
        const a = contour.points[i], b = contour.points[(i + 1) % contour.points.length];
        distance += Math.hypot(b[0] - a[0], b[1] - a[1]); count++;
      }
      if (count === contour.points.length) distance = 0;
      const [initialX, initialY] = zone.split(":").map(Number);
      let next = 8 + hash(initialX, initialY, seed + 50) * 14;
      if (next < distance) next += Math.ceil((distance - next) / 22) * 22;
      for (let i = 0; i < contour.points.length; i++) {
        const a = contour.points[i], b = contour.points[(i + 1) % contour.points.length];
        const zx = Math.floor(a[0] / 128), zy = Math.floor(a[1] / 128), key = `${zx}:${zy}`;
        if (key !== zone) { zone = key; distance = 0; next = 8 + hash(zx, zy, seed + 50) * 14; }
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (next <= distance + length) {
          const t = length ? (next - distance) / length : 0, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          if (x >= bounds.x - 2 && x <= bounds.x + bounds.width + 2 && y + height >= bounds.y && y <= bounds.y + bounds.height) {
            ctx.beginPath(); ctx.moveTo(x, y + 1); ctx.lineTo(x, y + height - .5); ctx.stroke();
          }
          next += 22;
        }
        distance += length;
      }
    }
  }
  ctx.restore();
  waterPath(ctx, contours); ctx.strokeStyle = stone ? "#c1bd8ed0" : "#b9ae7b8c"; ctx.lineWidth = stone ? 3 : 5; ctx.lineJoin = "round"; ctx.stroke();
  if (stone) { waterPath(ctx, contours); ctx.strokeStyle = "#405e4f99"; ctx.lineWidth = .7; ctx.stroke(); }
}

/** Base chunks contain no baked shoreline: the effective water field supplies it. */
export function drawTerrain(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, baseTrails = true): void {
  ctx.save(); ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height); ctx.clip();
  drawGround(ctx, seed, bounds, baseTrails); ctx.restore();
}

/** Repainted grass shares gradients, clearing palette, blades and fleck shadows. */
export function drawTerrainMaterial(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, material: TerrainMaterial, baseTrails = true): void {
  ctx.save(); ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height); ctx.clip();
  if (material === "water") drawWaterTexture(ctx, seed, bounds);
  else drawGround(ctx, seed, bounds, baseTrails, material);
  ctx.restore();
}


export function drawWaterOverlay(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, contours: readonly WaterContour[], state: TerrainState) {
  const appearance = terrainAppearance(state);
  if (appearance.shoreStyle !== "none") { waterPath(ctx, contours); ctx.strokeStyle = appearance.shoreStyle === "stone" ? "#a9a16b70" : "#b5a77088"; ctx.lineWidth = appearance.shoreStyle === "stone" ? 7 : 15; ctx.lineJoin = "round"; ctx.stroke(); }
  ctx.save(); waterPath(ctx, contours); ctx.clip("evenodd"); drawWaterTexture(ctx, seed, bounds); ctx.restore();
  drawShore(ctx, seed, bounds, contours, state);
}
