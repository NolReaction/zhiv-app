import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { occlusionRaster } from "./helpers/occlusion-raster.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { withForestOcclusion, forestPointOccluded } = await vite.ssrLoadModule("/features/world/scene/forest-occlusion.ts");

const rectangle = (id = "tree", x = 40, y = 30, width = 40, height = 50, frontY = 80) => ({ id, frontY,
  points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const scene = (occluders = [rectangle()]) => ({ width: 200, height: 200, occluders });
const actor = { x: 75, y: 70, size: 40 };

// A tiny sampled Canvas clip model verifies visible pixels, including the
// intersection of multiple clips, without installing a browser/image backend.
class SamplePath {
  polygons = [];
  rect(x, y, width, height) { this.polygons.push(rectangle("rect", x, y, width, height).points); }
  moveTo(x, y) { this.polygons.push([{ x, y }]); }
  lineTo(x, y) { this.polygons.at(-1).push({ x, y }); }
  closePath() {}
}
function contains(polygon, x, y) {
  let crossings = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)) crossings++;
  }
  return crossings % 2 === 1;
}
function surface() {
  const ctx = new SamplePath(), stack = [], pixels = new Map(), clips = [];
  ctx.globalAlpha = .6;
  ctx.calls = [];
  ctx.save = () => { ctx.calls.push("save"); stack.push({ clips: [...clips], alpha: ctx.globalAlpha }); };
  ctx.restore = () => {
    ctx.calls.push("restore");
    const state = stack.pop(); assert.ok(state, "restore must balance save");
    clips.splice(0, clips.length, ...state.clips); ctx.globalAlpha = state.alpha;
  };
  ctx.beginPath = () => { ctx.polygons = []; };
  ctx.clip = (path, rule) => {
    ctx.calls.push("clip");
    const polygons = typeof path === "string" ? ctx.polygons : path.polygons;
    assert.equal(typeof path === "string" ? path : rule, "evenodd");
    clips.push(structuredClone(polygons));
  };
  ctx.paint = (x, y, value = "actor") => {
    if (clips.every(polygons => polygons.filter(polygon => contains(polygon, x, y)).length % 2 === 1)) pixels.set(`${x},${y}`, value);
  };
  ctx.read = (x, y) => pixels.get(`${x},${y}`);
  ctx.getImageData = ctx.drawImage = () => assert.fail("occlusion must not copy or sample background artwork");
  return ctx;
}

test("only actor pixels behind the authored front line disappear, preserving background and front actors", () => {
  for (const y of [70, 79.999, 80, 81]) {
    const ctx = surface();
    ctx.paint(60, 45, "ground");
    let calls = 0;
    withForestOcclusion(ctx, scene(), { ...actor, y }, () => { calls++; ctx.paint(60, 45); ctx.paint(95, 45, "held-basket"); });
    assert.equal(calls, 1);
    assert.equal(ctx.read(60, 45), y < 80 ? "ground" : "actor", `feet y=${y}`);
    assert.equal(ctx.read(95, 45), "held-basket", "pixels beyond the contour survive");
    ctx.paint(60, 45, "next-actor");
    assert.equal(ctx.read(60, 45), "next-actor", "a previous actor cannot leave a mask on later draws");
  }
});

test("crossing a contour hides only the overlapping part, even when the feet are outside it", () => {
  const ctx = surface(), shape = scene();
  withForestOcclusion(ctx, shape, { x: 85, y: 75, size: 40 }, () => {
    for (const x of [39.999, 40.001, 79.999, 80.001]) ctx.paint(x, 45);
    ctx.paint(65, 85, "prop");
  });
  assert.equal(ctx.read(39.999, 45), "actor");
  assert.equal(ctx.read(40.001, 45), undefined);
  assert.equal(ctx.read(79.999, 45), undefined);
  assert.equal(ctx.read(80.001, 45), "actor");
  assert.equal(ctx.read(65, 85), "prop");
});

test("concave crowns preserve their open notches rather than hiding a rectangular bounding box", () => {
  const ctx = surface(), shape = { id: "bent-tree", frontY: 90, points: [
    { x: 40, y: 30 }, { x: 90, y: 30 }, { x: 90, y: 50 },
    { x: 60, y: 50 }, { x: 60, y: 80 }, { x: 40, y: 80 },
  ] };
  withForestOcclusion(ctx, scene([shape]), actor, () => { ctx.paint(70, 40); ctx.paint(50, 65); ctx.paint(75, 65); });
  assert.equal(ctx.read(70, 40), undefined);
  assert.equal(ctx.read(50, 65), undefined);
  assert.equal(ctx.read(75, 65), "actor");
});

test("overlapping foreground masks form a union and never reopen their overlap", () => {
  const ctx = surface(), shape = scene([rectangle(), rectangle("second-tree", 60, 30, 40, 50)]);
  withForestOcclusion(ctx, shape, actor, () => {
    for (const x of [35, 50, 70, 90, 105]) ctx.paint(x, 45);
  });
  assert.deepEqual([35, 50, 70, 90, 105].map(x => ctx.read(x, 45)), ["actor", undefined, undefined, undefined, "actor"]);
  assert.equal(ctx.calls.filter(call => call === "clip").length, 2);
  assert.equal(ctx.calls.filter(call => call === "save").length, 1);
});

test("hit masking agrees with visual depth and preserves taps on a partly visible body", () => {
  const shape = scene([rectangle(), rectangle("second-tree", 60, 30, 40, 50)]);
  for (const feetY of [70, 80, 90]) for (const x of [35, 50, 70, 90, 105]) {
    const ctx = surface(), point = { x, y: 45 };
    withForestOcclusion(ctx, shape, { ...actor, y: feetY }, () => ctx.paint(x, point.y));
    assert.equal(forestPointOccluded(shape, feetY, point), ctx.read(x, point.y) === undefined);
  }
  assert.equal(forestPointOccluded(shape, 70, { x: 40, y: 45 }), true, "the authored edge belongs to the foreground");
  assert.equal(forestPointOccluded({ width: 200, height: 200 }, 70, { x: 50, y: 45 }), false);
});

test("clip and canvas state are restored when actor drawing throws", () => {
  const ctx = surface(), error = new Error("sprite unavailable");
  assert.throws(() => withForestOcclusion(ctx, scene(), actor, () => { ctx.globalAlpha = .1; throw error; }), error);
  assert.equal(ctx.globalAlpha, .6);
  ctx.paint(60, 45);
  assert.equal(ctx.read(60, 45), "actor");
  assert.equal(ctx.calls.at(-1), "restore");
});

test("missing, invalid, remote and front-side masks preserve the legacy draw without canvas work", () => {
  const samples = [
    { width: 200, height: 200 }, scene([]), scene([rectangle("far-tree", 900, 900)]),
    scene([{ ...rectangle(), frontY: 70 }]), scene([{ ...rectangle(), points: [] }]),
    scene([{ ...rectangle(), frontY: NaN }]), scene([{ ...rectangle(), points: [{ x: NaN, y: 1 }, { x: 1, y: 2 }, { x: 3, y: 4 }] }]),
  ];
  for (const shape of samples) {
    const ctx = surface(); let calls = 0;
    withForestOcclusion(ctx, shape, actor, () => { calls++; ctx.paint(60, 45); });
    assert.equal(calls, 1); assert.equal(ctx.read(60, 45), "actor"); assert.deepEqual(ctx.calls, []);
  }
});

test("immutable scene shares cached paths between cameras and culls remote masks before path allocation", () => {
  const previousPath = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const created = [];
  class CachedPath extends SamplePath { constructor() { super(); created.push(this); } }
  Object.defineProperty(globalThis, "Path2D", { configurable: true, value: CachedPath });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement() { assert.fail("no image or offscreen canvas allocation"); },
  } });
  try {
    const shape = scene([rectangle(), rectangle("far-tree", 900, 900)]);
    for (let frame = 0; frame < 20; frame++) {
      const ctx = surface();
      withForestOcclusion(ctx, shape, actor, () => { ctx.paint(60, 45); ctx.paint(90, 45); });
      assert.equal(ctx.read(60, 45), undefined); assert.equal(ctx.read(90, 45), "actor");
      assert.deepEqual(ctx.polygons, [], "the context does not retrace cached polygons");
    }
    assert.equal(created.length, 1, "two cameras reuse the same nearby inverse path");
    withForestOcclusion(surface(), structuredClone(shape), actor, () => {});
    assert.equal(created.length, 2, "new scene identity rebuilds geometry after a map/level change");
  } finally {
    if (previousPath) Object.defineProperty(globalThis, "Path2D", previousPath); else delete globalThis.Path2D;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  }
});

test("explicit prop bounds clip a distant float while keeping the actor's own depth", () => {
  const ctx = surface(), fishingActor = { x: 20, y: 40, size: 10 };
  const shape = scene([rectangle("bank-leaves", 45, 47, 10, 15, 70)]);
  withForestOcclusion(ctx, shape, fishingActor, () => {
    ctx.paint(20, 35, "resident"); ctx.paint(50, 52, "float"); ctx.paint(57, 52, "line");
  }, { x: 10, y: 10, width: 50, height: 50 });
  assert.equal(ctx.read(20, 35), "resident");
  assert.equal(ctx.read(50, 52), undefined, "the float overlaps a mask outside the usual body envelope");
  assert.equal(ctx.read(57, 52), "line");
  ctx.paint(50, 52, "later"); assert.equal(ctx.read(50, 52), "later", "clips are restored");
});

function withRasterDocument(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), allocated = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement(tag) {
    assert.equal(tag, "canvas"); const canvas = occlusionRaster(); allocated.push(canvas); return canvas;
  } } });
  try { run(allocated); } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
}

test("the inward edge fades actor pixels, leaving its exterior crisp and interior completely hidden", () => {
  withRasterDocument(() => {
    const target = occlusionRaster(), ctx = target.getContext("2d"), shape = scene();
    let calls = 0;
    withForestOcclusion(ctx, shape, actor, paint => { calls++; paint.fillRect(20, 20, 100, 60); });
    assert.equal(calls, 1, "the sprite is painted only once, not once per feather band");
    assert.equal(target.alpha(39, 45), 1, "no fade outside the author’s contour");
    assert.equal(target.alpha(80, 45), 1);
    assert.equal(target.alpha(50, 45), 0, "the opaque canopy interior never shows the actor");
    const alpha = [40, 41, 42, 43].map(x => target.alpha(x, 45));
    assert.ok(alpha[0] < 1 && alpha[0] > alpha[1] && alpha[1] > alpha[2] && alpha[2] > 0 && alpha[3] === 0,
      `continuous inward alpha falloff: ${alpha}`);
    assert.equal(ctx.drawCalls.length, 1);
    assert.deepEqual(ctx.drawCalls[0].matrix, [1, 0, 0, 1, 0, 0], "composite at physical pixel resolution");
    assert.equal(ctx.globalCompositeOperation, "source-over");
    assert.equal(ctx.globalAlpha, 1);
  });
});

test("feather composition respects camera scaling, inherited opacity, concavity and overlapping crowns", () => {
  withRasterDocument(() => {
    const shape = scene([rectangle(), rectangle("overlap", 60, 30, 40, 50)]);
    for (const scale of [1, 2]) {
      const target = occlusionRaster(400, 400), ctx = target.getContext("2d");
      ctx.setTransform(scale, 0, 0, scale, 6, 8); ctx.globalAlpha = .4;
      withForestOcclusion(ctx, shape, actor, paint => paint.fillRect(20, 20, 110, 70));
      const alpha = (x, y = 45) => target.alpha(x * scale + 6, y * scale + 8);
      assert.ok(Math.abs(alpha(35) - .4) < 1e-8, "opacity is applied once");
      assert.equal(alpha(50), 0); assert.equal(alpha(70), 0); assert.equal(alpha(90), 0);
      assert.ok(alpha(40) > 0 && alpha(40) < .4);
      assert.equal(ctx.globalAlpha, .4);
      assert.deepEqual(ctx.getTransform(), { a: scale, b: 0, c: 0, d: scale, e: 6, f: 8 });
    }
    const target = occlusionRaster(), ctx = target.getContext("2d");
    const crown = { id: "concave", frontY: 90, points: [
      { x: 40, y: 30 }, { x: 90, y: 30 }, { x: 90, y: 50 },
      { x: 60, y: 50 }, { x: 60, y: 80 }, { x: 40, y: 80 },
    ] };
    withForestOcclusion(ctx, scene([crown]), actor, paint => paint.fillRect(20, 20, 100, 70));
    assert.equal(target.alpha(75, 65), 1, "an open notch remains open");
    assert.equal(target.alpha(50, 65), 0);
    assert.ok(target.alpha(59, 65) > 0 && target.alpha(59, 65) < 1);
  });
});

test("mask textures are shared across cameras while each camera reuses its bounded actor surface", () => {
  withRasterDocument(allocated => {
    const shape = scene(), cameras = [occlusionRaster(), occlusionRaster()];
    for (let frame = 0; frame < 3; frame++) for (const camera of cameras) {
      const ctx = camera.getContext("2d"); ctx.clearRect();
      withForestOcclusion(ctx, shape, actor, paint => paint.fillRect(20, 20, 100, 60));
    }
    assert.equal(allocated.length, 3, "two camera buffers plus one shared contour texture");
    assert.equal(allocated.filter(canvas => canvas.getContext("2d").strokeCalls > 0).length, 1);
    assert.ok(allocated.every(canvas => canvas.width * canvas.height <= 1024 * 1024));
    const before = allocated.length;
    withForestOcclusion(cameras[0].getContext("2d"), scene([rectangle("far", 900, 900)]), actor, paint => paint.fillRect(20, 20, 10, 10));
    assert.equal(allocated.length, before, "remote crowns do not allocate a texture or actor buffer");
  });
});

test("a failed sprite draw restores the scratch layer and never damages previously painted world pixels", () => {
  withRasterDocument(() => {
    const target = occlusionRaster(), ctx = target.getContext("2d"), shape = scene();
    ctx.globalAlpha = .7; ctx.fillRect(60, 45, 1, 1); ctx.globalAlpha = 1;
    assert.throws(() => withForestOcclusion(ctx, shape, actor, paint => { paint.fillRect(20, 20, 100, 60); throw new Error("sprite"); }), /sprite/);
    assert.equal(target.alpha(60, 45), .7);
    withForestOcclusion(ctx, shape, actor, paint => paint.fillRect(20, 20, 100, 60));
    assert.equal(target.alpha(60, 45), .7, "masking erases only the isolated actor, never the world behind it");
    assert.equal(target.alpha(35, 45), 1, "the reusable layer recovered after the exception");
  });
});

test("extreme DEV zoom falls back to vector clips before any offscreen allocation", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() {
    assert.fail("oversized actor layers must not allocate GPU textures");
  } } });
  try {
    const ctx = surface();
    ctx.canvas = { width: 5000, height: 5000 }; ctx.globalCompositeOperation = "source-over";
    ctx.getTransform = () => ({ a: 20, b: 0, c: 0, d: 20, e: 0, f: 0 }); ctx.setTransform = () => {};
    withForestOcclusion(ctx, scene(), actor, paint => { paint.paint(60, 45); paint.paint(95, 45); });
    assert.equal(ctx.read(60, 45), undefined); assert.equal(ctx.read(95, 45), "actor");
    assert.equal(ctx.calls.filter(call => call === "clip").length, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
});
