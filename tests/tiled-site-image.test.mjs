import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");
const { previewWorldScene, previewSiteAt } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { drawSiteGrounding } = await vite.ssrLoadModule("/features/world/grounding.ts");
const { drawSiteImage } = await vite.ssrLoadModule("/features/world/tiled/site-image.ts");

const placement = { x: 584.278092108405, y: 1025.10331433066, width: 96.2645550234738, height: 48.1322775117369, rotation: 346.507 };
function rotatedPoint(x, y) {
  const angle = placement.rotation * Math.PI / 180;
  return { x: placement.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: placement.y + x * Math.sin(angle) + y * Math.cos(angle) };
}
function rectangle(x, y, width, height) {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}
function fixture() {
  const corners = rectangle(0, 0, placement.width, placement.height).map(point => rotatedPoint(point.x, point.y));
  const x = Math.min(...corners.map(point => point.x)), y = Math.min(...corners.map(point => point.y));
  const geometry = { bounds: { x, y, width: Math.max(...corners.map(point => point.x)) - x, height: Math.max(...corners.map(point => point.y)) - y },
    imagePlacement: { ...placement }, anchor: rotatedPoint(48, 35), entry: rotatedPoint(0, 50), hitArea: corners,
    collision: rectangle(5, 25, 86, 20).map(point => rotatedPoint(point.x, point.y)) };
  const straight = { bounds: { x: 600, y: 1010, width: 96, height: 48 }, anchor: { x: 648, y: 1050 }, entry: { x: 595, y: 1060 },
    hitArea: rectangle(600, 1010, 96, 48), collision: rectangle(605, 1035, 86, 20) };
  const bridge = { ...geometry, id: "bridge", label: "Bridge", initialLevel: 0,
    states: [{ level: 0, label: "Ruins", image: "/bridge.png", geometry }, { level: 1, label: "Restored", image: "/bridge-1.png", geometry: straight }] };
  const workshop = { ...straight, id: "workshop", initialLevel: 0, label: "Workshop", states: [{ level: 0, label: "Ruins", image: "/workshop.png" }] };
  const scene = { schemaVersion: 1, id: "rotated-sites", width: 1254, height: 1254, terrain: [], sites: [bridge, workshop], paths: [], lights: [], focus: straight.bounds };
  return { scene, bridge, straight, corners };
}

// Record affine-transformed geometry to catch wrong pivots and leaked canvas transforms.
function canvas() {
  let matrix = [1, 0, 0, 1, 0, 0], path = [];
  const stack = [], draws = [], fills = [], clips = [];
  const point = (x, y) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] });
  const corners = (x, y, width, height) => rectangle(x, y, width, height).map(p => point(p.x, p.y));
  const ctx = {
    draws, fills, clips, globalAlpha: 1, globalCompositeOperation: "source-over", filter: "none",
    save() { stack.push({ matrix: [...matrix], alpha: this.globalAlpha, composite: this.globalCompositeOperation }); },
    restore() { const state = stack.pop(); matrix = state.matrix; this.globalAlpha = state.alpha; this.globalCompositeOperation = state.composite; },
    scale(x, y) { matrix = [matrix[0] * x, matrix[1] * x, matrix[2] * y, matrix[3] * y, matrix[4], matrix[5]]; },
    translate(x, y) { const p = point(x, y); matrix[4] = p.x; matrix[5] = p.y; },
    rotate(angle) {
      const [a, b, c, d, e, f] = matrix, cos = Math.cos(angle), sin = Math.sin(angle);
      matrix = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, f];
    },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(point(x, y)); }, lineTo(x, y) { path.push(point(x, y)); }, closePath() {},
    rect(x, y, width, height) { path.push(...corners(x, y, width, height)); },
    clip() { clips.push([...path]); },
    drawImage(image, x, y, width, height) { draws.push({ image, corners: corners(x, y, width, height), alpha: this.globalAlpha }); },
    fillRect(x, y, width, height) { fills.push({ corners: corners(x, y, width, height), composite: this.globalCompositeOperation,
      rectangle: [x, y, width, height], matrix: [...matrix] }); },
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

function closePoints(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, i) => {
    assert.ok(Math.abs(point.x - expected[i].x) < 1e-8, `point ${i} x: ${point.x} != ${expected[i].x}`);
    assert.ok(Math.abs(point.y - expected[i].y) < 1e-8, `point ${i} y: ${point.y} != ${expected[i].y}`);
  });
}

test("the shared compositor preserves the bridge angle and size without rotating the next building", () => {
  const { scene, corners, straight } = fixture(), ctx = canvas().getContext("2d");
  const bridgeImage = {}, workshopImage = {};
  paintFixedWorld(ctx, scene, { images: new Map([["/bridge.png", bridgeImage], ["/workshop.png", workshopImage]]),
    visuals: Object.fromEntries(scene.sites.map(site => [site.id, site.states[0]])), actor: null,
    options: { levels: { bridge: 0, workshop: 0 }, night: false, debug: false, selectedSiteId: null, reducedMotion: true, buildingShadow: false } });
  assert.equal(ctx.draws.length, 2);
  assert.equal(ctx.draws[0].image, bridgeImage);
  closePoints(ctx.draws[0].corners, corners);
  assert.equal(ctx.draws[1].image, workshopImage);
  closePoints(ctx.draws[1].corners, rectangle(straight.bounds.x, straight.bounds.y, straight.bounds.width, straight.bounds.height));
});

test("changing to an unrotated level clears image placement while keeping markers in world coordinates", () => {
  const { scene, bridge, straight } = fixture(), before = structuredClone(scene);
  const ruins = previewWorldScene(scene, { bridge: 0 }), restored = previewWorldScene(scene, { bridge: 1 });
  assert.deepEqual(ruins.sites[0].imagePlacement, placement);
  assert.equal(restored.sites[0].imagePlacement, undefined);
  assert.deepEqual(restored.sites[0].bounds, straight.bounds);
  assert.deepEqual(ruins.sites[0].collision, bridge.collision);
  assert.deepEqual(restored.sites[0].entry, straight.entry);
  assert.equal(previewSiteAt(ruins, rotatedPoint(2, 2))?.id, "bridge");
  assert.equal(previewWorldScene(scene, { bridge: 0 }), ruins);
  assert.deepEqual(scene, before);
});

test("negative, multi-turn and extreme finite rotations agree with their normalized angle", () => {
  const { bridge } = fixture(), image = {};
  for (const rotation of [-13.493, 706.507, Number.MAX_VALUE]) {
    const actual = canvas().getContext("2d"), normalized = canvas().getContext("2d");
    drawSiteImage(actual, { ...bridge, imagePlacement: { ...placement, rotation } }, image);
    drawSiteImage(normalized, { ...bridge, imagePlacement: { ...placement, rotation: rotation % 360 } }, image);
    closePoints(actual.draws[0].corners, normalized.draws[0].corners);
  }
});

test("the contact-shadow mask rotates the image once, clips world geometry, and keeps its cast in world space", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { createElement: () => canvas() };
  try {
    const { bridge, corners } = fixture(), image = {}, ctx = canvas().getContext("2d");
    drawSiteGrounding(ctx, bridge, image);
    assert.equal(ctx.draws.length, 2);
    const diffuse = ctx.draws[0].image, layers = diffuse.getContext("2d").draws;
    const mask = layers[0].image, maskCtx = mask.getContext("2d");
    const toMask = p => ({ x: (p.x - bridge.bounds.x) * mask.width / bridge.bounds.width,
      y: (p.y - bridge.bounds.y) * mask.height / bridge.bounds.height });
    assert.equal(maskCtx.draws[0].image, image);
    closePoints(maskCtx.draws[0].corners, corners.map(toMask));
    closePoints(maskCtx.clips[0], bridge.collision.map(toMask));
    assert.equal(maskCtx.fills[0].composite, "source-in");
    assert.deepEqual(maskCtx.fills[0].matrix, [1, 0, 0, 1, 0, 0], "tint uses bitmap coordinates after geometry clipping is painted into alpha");
    assert.deepEqual(maskCtx.fills[0].rectangle, [0, 0, mask.width, mask.height]);
    closePoints(maskCtx.fills[0].corners, rectangle(0, 0, mask.width, mask.height));
    assert.ok(layers[1].corners[0].x > layers[0].corners[0].x, "cast stays to the right regardless of artwork rotation");
    for (const draw of ctx.draws) {
      assert.equal(draw.corners[0].y, draw.corners[1].y);
      assert.equal(draw.corners[0].x, draw.corners[3].x);
    }
    drawSiteGrounding(ctx, bridge, image);
    assert.equal(ctx.draws[2].image, diffuse, "transformed shadow is cached");
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }
});
