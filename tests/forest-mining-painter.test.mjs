import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { pixelSprite, pixelSpriteContact } = await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts");
const { drawForestMiningHero } = await vite.ssrLoadModule("/features/world/forest-mining-painter.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

// Colour raster, including rotated polygons, exposes whether the pickaxe is
// actually visible through body pixels rather than merely recording draw order.
function rasterCanvas() {
  const canvas = { width: 0, height: 0, pixels: new Map() };
  let matrix = [1, 0, 0, 1, 0, 0], path = [];
  const stack = [];
  const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  function polygon(points, color) {
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a[1] > y + .5) !== (b[1] > y + .5)
          && x + .5 < (b[0] - a[0]) * (y + .5 - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      if (inside) canvas.pixels.set(`${x}:${y}`, color);
    }
  }
  const ctx = {
    fillStyle: "",
    save() { stack.push({ matrix: [...matrix], fillStyle: this.fillStyle }); },
    restore() { const saved = stack.pop(); matrix = saved.matrix; this.fillStyle = saved.fillStyle; },
    translate(x, y) { const [tx, ty] = point(x, y); matrix[4] = tx; matrix[5] = ty; },
    scale(x, y) { matrix[0] *= x; matrix[1] *= x; matrix[2] *= y; matrix[3] *= y; },
    rotate(angle) {
      const [a, b, c, d] = matrix, cosine = Math.cos(angle), sine = Math.sin(angle);
      matrix[0] = a * cosine + c * sine; matrix[1] = b * cosine + d * sine;
      matrix[2] = c * cosine - a * sine; matrix[3] = d * cosine - b * sine;
    },
    beginPath() { path = []; }, moveTo(x, y) { path.push(point(x, y)); }, lineTo(x, y) { path.push(point(x, y)); }, closePath() {},
    fill() { polygon(path, this.fillStyle); },
    fillRect(x, y, width, height) { polygon([point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)], this.fillStyle); },
  };
  canvas.getContext = () => ctx;
  return canvas;
}
globalThis.document = { createElement(tag) { assert.equal(tag, "canvas"); return rasterCanvas(); } };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});
const appearance = { palette: "moss", head: "mining_helmet", neck: null };
const toolColors = new Set(["#49382b", "#bf9255", "#725036", "#293d42", "#a5bdc0", "#e4ebd8", "#697f83"]);

test("the rear body occludes its carried pickaxe, retaining only the exposed edge through every walk frame", () => {
  for (const pose of ["idle", "walk"]) for (let frame = 0; frame < 4; frame++) {
    const ordinary = pixelSprite(pose, "back", frame, appearance);
    const miner = pixelSprite(pose, "back", frame, appearance, { mining: true });
    for (const [key, color] of ordinary.pixels) assert.equal(miner.pixels.get(key), color, `${pose}/${frame}/${key}: no tool through the back or paw`);
    const exposed = [...miner.pixels].filter(([key, color]) => !ordinary.pixels.has(key) && toolColors.has(color));
    assert.ok(exposed.length > 0, "the tool is occluded by the silhouette, not completely switched off");
    assert.deepEqual(pixelSpriteContact(miner), pixelSpriteContact(ordinary), "the pickaxe cannot move the grounded feet or shadow");
  }
});

test("front and side views retain a visible tool held by the existing paw without changing the eyes", () => {
  for (const direction of ["front", "left", "right"]) for (const pose of ["idle", "walk"]) for (let frame = 0; frame < 4; frame++) {
    const ordinary = pixelSprite(pose, direction, frame, appearance);
    const miner = pixelSprite(pose, direction, frame, appearance, { mining: true });
    assert.ok([...miner.pixels].some(([, color]) => toolColors.has(color)), `${direction}/${pose}/${frame}: visible tool`);
    const gripX = direction === "left" ? 14 : 34;
    const step = pose === "walk" ? [0, -1, 0, 1][frame] : 0, bob = pose === "walk" && frame % 2 ? -1 : 0;
    const gripY = 34 + bob + (direction === "left" ? -step : step);
    assert.equal(miner.pixels.get(`${gripX}:${gripY}`), ordinary.pixels.get(`${gripX}:${gripY}`), "paw overlaps the shaft at the grip");
    for (const [key, color] of ordinary.pixels) if (color === "#30291d") assert.equal(miner.pixels.get(key), color, `the tool cannot cross either eye: ${direction}/${pose}/${frame}/${key}`);
    assert.deepEqual(pixelSpriteContact(miner), pixelSpriteContact(ordinary));
    assert.equal(pixelSprite(pose, direction, frame, appearance), ordinary, "mining does not contaminate the wardrobe sprite cache");
  }
});

test("portal opacity composites miner and pickaxe as one image and keeps reduced-motion frames stable", () => {
  const frame = { x: 100, y: 200, size: 60, scale: .82, direction: "back", pose: "walk", frame: 0,
    opacity: .4, working: false, doorway: { x: 90, y: 190 }, workCue: { x: 90, y: 140 }, elapsed: 0 };
  const draws = [], stack = [], ctx = {
    globalAlpha: .8, imageSmoothingEnabled: true,
    save() { stack.push({ globalAlpha: this.globalAlpha, imageSmoothingEnabled: this.imageSmoothingEnabled }); },
    restore() { Object.assign(this, stack.pop()); },
    drawImage(...args) { draws.push({ args, alpha: this.globalAlpha }); },
  };
  drawForestMiningHero(ctx, frame, appearance, false);
  assert.equal(draws.length, 1, "the translucent back and pickaxe are already composed, so the tool never bleeds through");
  assert.ok(Math.abs(draws[0].alpha - .32) < 1e-12);
  assert.equal(draws[0].args[0], pixelSprite("walk", "back", 0, appearance, { mining: true }));
  const first = draws[0]; draws.length = 0;
  drawForestMiningHero(ctx, { ...frame, elapsed: 1000 }, appearance, false);
  assert.deepEqual(draws[0], first, "reduced motion keeps the same neutral frame independent of elapsed time");
  assert.equal(ctx.globalAlpha, .8);
  for (const invalid of [{ opacity: NaN }, { size: 0 }, { scale: -1 }, { opacity: 0 }]) {
    draws.length = 0; drawForestMiningHero(ctx, { ...frame, ...invalid }, appearance, false); assert.equal(draws.length, 0);
  }
});
