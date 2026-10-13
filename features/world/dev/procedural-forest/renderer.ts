import { drawTree, drawShrub } from "./foliage";
import { drawTerrain } from "./terrain";
import { drawBridge, drawJetty, drawRock, drawRuins } from "./props";
import { compareObjects, forestObjects, initialProps, objectBounds, WORLD_HEIGHT, type Bounds, type ForestObject } from "./objects";

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;
export type ForestOptions = {
  seed: number; width: number; trees: boolean; grid: boolean;
  removed: ReadonlySet<string>; planted: readonly ForestObject[];
  modified?: ReadonlyMap<string, ForestObject>; selectedId?: string | null;
};
const TILE = 512;

/** Ground chunks and a small sprite atlas are disposable caches, never map data. */
export function createForestPainter(makeCanvas: CanvasFactory) {
  const ground = new Map<string, HTMLCanvasElement>();
  const sprites = new Map<string, HTMLCanvasElement>();
  let lastSeed = -1;
  let generated: ForestObject[] = [];
  let generatedWidth = 0;

  function objects(options: ForestOptions) {
    if (lastSeed !== options.seed || generatedWidth !== options.width) {
      if (lastSeed !== options.seed) ground.clear();
      lastSeed = options.seed; generatedWidth = options.width;
      generated = forestObjects(options.seed, { x: 0, y: 0, width: options.width, height: WORLD_HEIGHT });
    }
    const scene = new Map([...generated, ...initialProps(), ...options.planted].map(object => [object.id, object]));
    for (const [id, object] of options.modified ?? []) scene.set(id, object);
    return [...scene.values()]
      .filter(object => !options.removed.has(object.id) && (options.trees || (object.kind !== "tree" && object.kind !== "shrub")))
      .sort(compareObjects);
  }

  function sprite(object: ForestObject) {
    const key = `${object.kind}:${object.variant}`;
    let canvas = sprites.get(key);
    if (!canvas) {
      canvas = makeCanvas(288, 288);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Браузер не поддерживает Canvas 2D.");
      ctx.scale(1.5, 1.5); ctx.translate(96, 172);
      if (object.kind === "tree") drawTree(ctx, object.variant);
      else if (object.kind === "shrub") drawShrub(ctx, object.variant);
      else drawRock(ctx, object.variant);
      sprites.set(key, canvas);
    }
    return canvas;
  }

  function paint(ctx: CanvasRenderingContext2D, view: Bounds, options: ForestOptions) {
    const all = objects(options);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, options.width, WORLD_HEIGHT); ctx.clip();
    const minX = Math.max(0, Math.floor(view.x / TILE)), maxX = Math.min(Math.ceil(options.width / TILE) - 1, Math.floor((view.x + view.width) / TILE));
    const minY = Math.max(0, Math.floor(view.y / TILE)), maxY = Math.min(Math.ceil(WORLD_HEIGHT / TILE) - 1, Math.floor((view.y + view.height) / TILE));
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      const key = `${tx}:${ty}`;
      let tile = ground.get(key);
      if (!tile) {
        // One-pixel bleed avoids interpolation cracks at fractional camera scales.
        tile = makeCanvas(TILE + 2, TILE + 2);
        const tileCtx = tile.getContext("2d");
        if (!tileCtx) throw new Error("Не удалось подготовить землю.");
        tileCtx.translate(1 - tx * TILE, 1 - ty * TILE);
        drawTerrain(tileCtx, options.seed, { x: tx * TILE - 1, y: ty * TILE - 1, width: TILE + 2, height: TILE + 2 });
        ground.set(key, tile);
      }
      ctx.drawImage(tile, tx * TILE - 1, ty * TILE - 1);
    }
    const visible = all.filter(object => {
      const bounds = objectBounds(object);
      return bounds.x + bounds.width > view.x && bounds.x < view.x + view.width
        && bounds.y + bounds.height > view.y && bounds.y < view.y + view.height;
    });
    for (const object of visible) {
      if (object.kind !== "tree" && object.kind !== "shrub" && object.kind !== "rock") continue;
      ctx.save(); ctx.translate(object.x, object.y); ctx.rotate((object.rotation ?? 0) * Math.PI / 180); ctx.scale(object.scale, object.scale);
      const radius = object.kind === "tree" ? 61 : 22;
      const shadow = ctx.createRadialGradient(18, 2, 4, 20, 3, radius);
      shadow.addColorStop(0, "#122b2490"); shadow.addColorStop(.6, "#142e2460"); shadow.addColorStop(1, "#142e2400");
      ctx.scale(1.2, .48); ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(20, 3, radius, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    for (const object of visible) {
      ctx.save(); ctx.translate(object.x, object.y); ctx.rotate((object.rotation ?? 0) * Math.PI / 180); ctx.scale(object.scale, object.scale);
      if (object.kind === "ruins") drawRuins(ctx);
      else if (object.kind === "jetty") drawJetty(ctx);
      else if (object.kind === "bridge") drawBridge(ctx);
      else ctx.drawImage(sprite(object), -96, -172, 192, 192);
      ctx.restore();
    }
    if (options.grid) {
      ctx.strokeStyle = "#f3edb67a"; ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]); ctx.beginPath();
      for (let x = TILE; x < options.width; x += TILE) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_HEIGHT); }
      for (let y = TILE; y < WORLD_HEIGHT; y += TILE) { ctx.moveTo(0, y); ctx.lineTo(options.width, y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    const selected = all.find(object => object.id === options.selectedId);
    if (selected) {
      const bounds = objectBounds(selected);
      ctx.strokeStyle = "#ffe4a0"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.strokeRect(bounds.x - 4, bounds.y - 4, bounds.width + 8, bounds.height + 8);
      ctx.setLineDash([]); ctx.fillStyle = "#ffe4a0"; ctx.beginPath();
      ctx.arc(selected.x, selected.y, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    return { objects: all.length, chunks: ground.size };
  }

  return { paint, objects, dispose() { ground.clear(); sprites.clear(); generated = []; } };
}
