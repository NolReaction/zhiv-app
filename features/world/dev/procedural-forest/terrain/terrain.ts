import { hash, sampleGround, SHORELINE, TRAILS } from "./layout";
import type { Point } from "./layout";
import { CELL_SIZE, readTerrainMaterial, type TerrainMaterial, type TerrainPreview, type TerrainState } from "./terrain-data";

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
function drawGround(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, baseTrails: boolean) {
  ctx.fillStyle = "#536c34";
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

  for (let gy = Math.floor(bounds.y / 96) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 96) + 2; gy++) {
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
    for (const trail of baseTrails ? TRAILS : []) {
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
      if (sample.water > 23) continue;
      const onPath = sample.path > 0.45;
      const palette = onPath ? soil : grass;
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

function drawWater(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds) {
  // Sand and eroded soil sit underneath one uninterrupted water outline.
  trace(ctx, SHORELINE, true);
  ctx.strokeStyle = "#b3a063";
  ctx.lineWidth = 31;
  ctx.stroke();
  ctx.strokeStyle = "#d2b17a";
  ctx.lineWidth = 18;
  ctx.stroke();

  const water = ctx.createLinearGradient(0, 900, 0, 1900);
  water.addColorStop(0, "#187d92");
  water.addColorStop(0.35, "#12869b");
  water.addColorStop(1, "#12617c");
  ctx.fillStyle = water;
  ctx.fill();

  ctx.save();
  trace(ctx, SHORELINE, true);
  ctx.clip();
  ctx.lineWidth = 33;
  ctx.strokeStyle = "#42a8a52b";
  ctx.stroke();
  ctx.lineWidth = 11;
  ctx.strokeStyle = "#71b4a53a";
  ctx.stroke();
  for (let gy = Math.floor(bounds.y / 18) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 18) + 2; gy++) {
    for (let gx = Math.floor(bounds.x / 37) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 37) + 2; gx++) {
      const r = hash(gx, gy, seed + 30), x = gx * 37 + r * 22, y = gy * 18 + hash(gx, gy, seed + 31) * 12;
      if (sampleGround(x, y).water < 0) continue;
      ctx.strokeStyle = r > 0.55 ? "#6bb9bd45" : "#064d7042";
      ctx.lineWidth = r > 0.75 ? 1.2 : 0.7;
      ctx.beginPath();
      ctx.moveTo(x - 13, y);
      ctx.bezierCurveTo(x - 6, y - 3, x - 1, y + 3, x + 5, y);
      ctx.bezierCurveTo(x + 12, y - 3, x + 14, y, x + 23, y - 1);
      ctx.stroke();
      if (r > 0.87) {
        ctx.strokeStyle = "#a2d3c250";
        ctx.beginPath();
        ctx.moveTo(x - 6, y - 1);
        ctx.lineTo(x + 1, y - 1);
        ctx.stroke();
      }
    }
  }
  // Bank depth is projected down on the water plane; drawing only the front faces
  // gives the top-down painting a small but tangible vertical dimension.
  trace(ctx, SHORELINE, true, 11);
  ctx.strokeStyle = "#123e4275";
  ctx.lineWidth = 24;
  ctx.stroke();
  ctx.restore();

  for (let index = 0; index < SHORELINE.length; index++) {
    const a = SHORELINE[index], b = SHORELINE[(index + 1) % SHORELINE.length];
    if (Math.max(a[0], b[0]) < bounds.x - 25 || Math.min(a[0], b[0]) > bounds.x + bounds.width + 25 || Math.max(a[1], b[1]) < bounds.y - 25 || Math.min(a[1], b[1]) > bounds.y + bounds.height + 25) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    const subdivisions = Math.max(1, Math.ceil(length / 18));
    for (let part = 0; part < subdivisions; part++) {
      const x1 = a[0] + dx * part / subdivisions, y1 = a[1] + dy * part / subdivisions;
      const x2 = a[0] + dx * (part + 1) / subdivisions, y2 = a[1] + dy * (part + 1) / subdivisions;
      const r = hash(index, part, seed + 50), depth = 9 + r * 8;
      // Front-facing banks cast a visible cliff; the opposite bank has a thin lip.
      const front = sampleGround((x1 + x2) * 0.5, (y1 + y2) * 0.5 + 7).water > 0;
      const drop = front ? depth : 3.5;
      const face = ctx.createLinearGradient(x1, y1, x1, y1 + drop);
      face.addColorStop(0, r > 0.5 ? "#929773" : "#839174");
      face.addColorStop(1, "#435b51");
      ctx.fillStyle = face;
      ctx.strokeStyle = "#3d574c";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1 - 2);
      ctx.lineTo(x2, y2 - 2);
      ctx.lineTo(x2 + 1, y2 + drop);
      ctx.lineTo(x1 + 1, y1 + drop);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#c1b88aaa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1 + 1, y1 - 1);
      ctx.lineTo(x2 - 1, y2 - 1);
      ctx.stroke();
    }
  }
}

/** Paints terrain only. Objects are rendered separately in depth order. */
export function drawTerrain(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, baseTrails = true): void {
  ctx.save();
  // The caller may also clip; keeping this local makes direct exports safe.
  ctx.beginPath();
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.clip();
  drawGround(ctx, seed, bounds, baseTrails);
  drawWater(ctx, seed, bounds);
  ctx.restore();
}

/** Opaque, world-addressed paint materials are prepared once and masked into edited chunks. */
export function drawTerrainMaterial(ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, material: TerrainMaterial): void {
  ctx.save(); ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height); ctx.clip();
  if (material === "water") {
    const water = ctx.createLinearGradient(0, 900, 0, 1900);
    water.addColorStop(0, "#187d92"); water.addColorStop(.35, "#12869b"); water.addColorStop(1, "#12617c");
    ctx.fillStyle = water; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    for (let gy = Math.floor(bounds.y / 18) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 18) + 2; gy++) {
      for (let gx = Math.floor(bounds.x / 37) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 37) + 2; gx++) {
        const r = hash(gx, gy, seed + 30), x = gx * 37 + r * 22, y = gy * 18 + hash(gx, gy, seed + 31) * 12;
        ctx.strokeStyle = r > .55 ? "#6bb9bd45" : "#064d7042"; ctx.lineWidth = r > .75 ? 1.2 : .7;
        ctx.beginPath(); ctx.moveTo(x - 13, y); ctx.bezierCurveTo(x - 6, y - 3, x - 1, y + 3, x + 5, y);
        ctx.bezierCurveTo(x + 12, y - 3, x + 14, y, x + 23, y - 1); ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = material === "grass" ? "#536c34" : material === "path" ? "#c0a368" : "#d2b17a";
    ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    if (material === "grass") {
      for (let gy = Math.floor(bounds.y / 96) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 96) + 2; gy++) {
        for (let gx = Math.floor(bounds.x / 96) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 96) + 2; gx++) {
          const x = gx * 96 + hash(gx, gy, seed) * 48, y = gy * 96 + hash(gx, gy, seed + 1) * 48;
          const radius = 74 + hash(gx, gy, seed + 2) * 57, gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
          gradient.addColorStop(0, hash(gx, gy, seed + 3) > .45 ? "#7787357c" : "#284e3470"); gradient.addColorStop(1, "#63753200");
          ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        }
      }
    }
    const palette = material === "grass" ? ["#8a984558", "#a1aa505e", "#364f3054", "#6c883a73", "#aec05d53"]
      : material === "path" ? ["#e2c58d99", "#a588526b", "#9e8b5677", "#d4b97eaa"] : ["#f2cf9499", "#bd9b696b", "#c19d6477", "#e7c48caa"];
    for (let gy = Math.floor(bounds.y / 11) - 2; gy <= Math.ceil((bounds.y + bounds.height) / 11) + 2; gy++) {
      for (let gx = Math.floor(bounds.x / 11) - 2; gx <= Math.ceil((bounds.x + bounds.width) / 11) + 2; gx++) {
        const r = hash(gx, gy, seed + 11), r2 = hash(gx, gy, seed + 12), x = gx * 11 + r * 11, y = gy * 11 + r2 * 11;
        ctx.fillStyle = palette[Math.floor(hash(gx, gy, seed + 13) * palette.length)];
        ellipse(ctx, x, y, .9 + r * 2.4, .6 + r2 * 1.1, (r - .5) * 2.5);
        if (material === "grass" && r > .66) {
          ctx.fillStyle = r2 > .55 ? "#a6b35380" : "#8b9e4680"; ctx.beginPath(); ctx.moveTo(x + 1, y + 1);
          ctx.quadraticCurveTo(x - 2, y - 1, x - 2 - r * 1.5, y - 2 - r2 * 2); ctx.quadraticCurveTo(x + 1, y - 2, x + 2, y + 1); ctx.fill();
        }
      }
    }
  }
  ctx.restore();
}

type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

/** Bilinear material masks use one shared world grid, including a halo on every chunk. */
export function createTerrainComposer(makeCanvas: CanvasFactory) {
  let mask: HTMLCanvasElement | undefined, scratch: HTMLCanvasElement | undefined;
  function compose(base: HTMLCanvasElement, bounds: Bounds, state: TerrainState, preview: TerrainPreview | undefined,
    materialTile: (material: TerrainMaterial) => HTMLCanvasElement, reuse?: HTMLCanvasElement): HTMLCanvasElement {
    const minX = Math.floor(bounds.x / CELL_SIZE) - 1, minY = Math.floor(bounds.y / CELL_SIZE) - 1;
    const maxX = Math.ceil((bounds.x + bounds.width) / CELL_SIZE) + 1, maxY = Math.ceil((bounds.y + bounds.height) / CELL_SIZE) + 1;
    const groups = new Map<TerrainMaterial, [number, number][]>();
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
      // A low-resolution mask pixel is centered on the corresponding world cell.
      if (x * CELL_SIZE + CELL_SIZE * 1.5 <= bounds.x || x * CELL_SIZE - CELL_SIZE * .5 >= bounds.x + bounds.width
        || y * CELL_SIZE + CELL_SIZE * 1.5 <= bounds.y || y * CELL_SIZE - CELL_SIZE * .5 >= bounds.y + bounds.height) continue;
      const material = readTerrainMaterial((x + .5) * CELL_SIZE, (y + .5) * CELL_SIZE, state, preview);
      if (!material) continue;
      const group = groups.get(material); if (group) group.push([x - minX, y - minY]); else groups.set(material, [[x - minX, y - minY]]);
    }
    if (!groups.size) return base;
    const width = maxX - minX, height = maxY - minY;
    if (!mask || mask.width !== width || mask.height !== height) mask = makeCanvas(width, height);
    if (!scratch || scratch.width !== base.width || scratch.height !== base.height) scratch = makeCanvas(base.width, base.height);
    const target = reuse && reuse !== base ? reuse : makeCanvas(base.width, base.height);
    const targetCtx = target.getContext("2d"), maskCtx = mask.getContext("2d"), scratchCtx = scratch.getContext("2d");
    if (!targetCtx || !maskCtx || !scratchCtx) throw new Error("Не удалось подготовить кисть местности.");
    const dx = minX * CELL_SIZE - bounds.x, dy = minY * CELL_SIZE - bounds.y;
    const drawMask = (ctx: CanvasRenderingContext2D) => { ctx.imageSmoothingEnabled = true; ctx.drawImage(mask!, dx, dy, width * CELL_SIZE, height * CELL_SIZE); };
    targetCtx.save(); targetCtx.setTransform(1, 0, 0, 1, 0, 0); targetCtx.globalCompositeOperation = "source-over";
    targetCtx.clearRect(0, 0, base.width, base.height); targetCtx.drawImage(base, 0, 0);
    maskCtx.clearRect(0, 0, width, height); maskCtx.fillStyle = "#fff";
    for (const group of groups.values()) for (const [x, y] of group) maskCtx.fillRect(x, y, 1, 1);
    targetCtx.globalCompositeOperation = "destination-out"; drawMask(targetCtx);
    for (const [material, group] of groups) {
      maskCtx.clearRect(0, 0, width, height); for (const [x, y] of group) maskCtx.fillRect(x, y, 1, 1);
      scratchCtx.save(); scratchCtx.setTransform(1, 0, 0, 1, 0, 0); scratchCtx.globalCompositeOperation = "source-over";
      scratchCtx.clearRect(0, 0, base.width, base.height); scratchCtx.drawImage(materialTile(material), 0, 0);
      scratchCtx.globalCompositeOperation = "destination-in"; drawMask(scratchCtx); scratchCtx.restore();
      targetCtx.globalCompositeOperation = "lighter"; targetCtx.drawImage(scratch, 0, 0);
    }
    targetCtx.restore(); return target;
  }
  return { compose, dispose() { mask = undefined; scratch = undefined; } };
}
