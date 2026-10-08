import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { occlusionRaster } from "./helpers/occlusion-raster.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { withForestImageOcclusion } = await vite.ssrLoadModule("/features/world/scene/forest-occlusion.ts");
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { drawForestBush } = await vite.ssrLoadModule("/features/world/activities/garden/forest-bush-painter.ts");

const points = ({ x, y, width, height }) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const mask = (id, bounds, frontY = 80) => ({ id, frontY, points: points(bounds) });
const image = (id = "ground-patch", bounds = { x: 20, y: 20, width: 120, height: 130 }) => ({
  id, image: `/${id}.png`, bounds,
});
function building(id = "builder-home", anchorY = 70) {
  const bounds = { x: 20, y: 20, width: 120, height: 80 };
  return { id, label: id, initialLevel: 0, bounds, anchor: { x: 100, y: anchorY },
    entry: { x: 100, y: 150 }, hitArea: points(bounds), collision: [],
    states: [{ level: 0, label: "Built", image: `/${id}.png` }] };
}
const scene = (terrain = [], sites = [], occluders = [mask("tree", { x: 40, y: 30, width: 40, height: 50 })]) => ({
  schemaVersion: 1, id: "image-occlusion", width: 200, height: 200,
  terrain, sites, occluders, paths: [], lights: [], focus: { x: 0, y: 0, width: 200, height: 200 },
});
function raster(width = 200, height = 200) {
  const canvas = occlusionRaster(width, height), ctx = canvas.getContext("2d"), draw = ctx.drawImage;
  ctx.transform = (a, b, c, d, e, f) => {
    const m = ctx.getTransform();
    ctx.setTransform(m.a * a + m.c * b, m.b * a + m.d * b,
      m.a * c + m.c * d, m.b * c + m.d * d, m.a * e + m.c * f + m.e, m.b * e + m.d * f + m.f);
  };
  ctx.translate = (x, y) => ctx.transform(1, 0, 0, 1, x, y);
  ctx.scale = (x, y) => ctx.transform(x, 0, 0, y, 0, 0);
  ctx.rotate = angle => ctx.transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0);
  ctx.drawImage = function (source, ...args) {
    if (args.length === 8) {
      assert.deepEqual(args.slice(0, 4), [0, 0, source.width, source.height], "this fixture only draws complete source images");
      return draw.call(this, source, ...args.slice(4));
    }
    return draw.call(this, source, ...args);
  };
  return canvas;
}
function withRasterDocument(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), allocated = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement(tag) {
    assert.equal(tag, "canvas"); const canvas = raster(); allocated.push(canvas); return canvas;
  } } });
  try { run(allocated); } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
}
function paintBounds(ctx, bounds) { ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height); }
function artwork(width, height, alpha = 1) {
  const canvas = raster(width, height), ctx = canvas.getContext("2d");
  ctx.globalAlpha = alpha; ctx.fillRect(0, 0, width, height); return canvas;
}
function paintScene(shape, images, extra = {}) {
  const target = raster(), ctx = target.getContext("2d");
  ctx.rect = (x, y, width, height) => assert.deepEqual([x, y, width, height], [0, 0, 200, 200]);
  ctx.clip = () => {};
  paintFixedWorld(ctx, shape, { images, visuals: Object.fromEntries(shape.sites.map(site => [site.id, site.states[0]])),
    actor: null, options: { levels: Object.fromEntries(shape.sites.map(site => [site.id, site.initialLevel])),
      night: false, debug: false, selectedSiteId: null, reducedMotion: true, buildingShadow: false }, ...extra });
  return target;
}

test("a placed image stays below a canopy even when its bottom extends beyond frontY", () => {
  withRasterDocument(() => {
    const patch = image(), shape = scene([patch]), target = occlusionRaster();
    assert.ok(patch.bounds.y + patch.bounds.height > shape.occluders[0].frontY);
    withForestImageOcclusion(target.getContext("2d"), shape, patch, ctx => paintBounds(ctx, patch.bounds));
    assert.equal(target.alpha(60, 45), 0, "the ground cannot cover the tree when its lower edge reaches the path");
    assert.equal(target.alpha(95, 45), 1, "uncovered artwork remains visible");
    assert.equal(target.alpha(60, 120), 1, "the forward portion of a large ground patch remains intact");
  });
});

test("a site's ground patch ignores its owner's silhouette and respects every other active occluder", () => {
  withRasterDocument(() => {
    const site = building(), patch = { ...image("builder-home-ground"), when: { siteId: site.id, level: 0 } };
    const own = { ...mask("home-silhouette", { x: 30, y: 30, width: 20, height: 40 }), when: patch.when };
    const foreign = { ...mask("stall-silhouette", { x: 110, y: 30, width: 20, height: 40 }),
      when: { siteId: "stall", level: 0 } };
    const shape = scene([patch], [site], [own, mask("tree", { x: 70, y: 30, width: 20, height: 40 }), foreign]);
    const target = occlusionRaster();
    withForestImageOcclusion(target.getContext("2d"), shape, patch, ctx => paintBounds(ctx, patch.bounds));
    assert.equal(target.alpha(40, 45), 1, "a house cannot erase its associated foundation");
    assert.equal(target.alpha(80, 45), 0, "the tree remains in front");
    assert.equal(target.alpha(120, 45), 0, "another site's silhouette remains in front");
  });
});

test("effective level filtering applies to conditional ground pictures and their masks together", () => {
  withRasterDocument(() => {
    const site = building("gate", 150);
    site.states.push({ level: 1, label: "Upgraded", image: "/gate-1.png" });
    const patch = { ...image("level-ground"), when: { siteId: "gate", level: 1 } };
    const canopy = { ...mask("level-tree", { x: 40, y: 30, width: 40, height: 50 }),
      when: { siteId: "gate", level: 1 } };
    const source = scene([patch], [site], [canopy, mask("other-tree", { x: 100, y: 30, width: 20, height: 50 })]);
    const absent = previewWorldScene(source, { gate: 0 });
    assert.equal(absent.terrain.length, 0); assert.equal(absent.occluders.length, 1);
    const active = previewWorldScene(source, { gate: 1 }), target = occlusionRaster();
    withForestImageOcclusion(target.getContext("2d"), active, active.terrain[0], ctx => paintBounds(ctx, patch.bounds));
    assert.equal(target.alpha(60, 45), 1, "active own-state silhouette is excluded");
    assert.equal(target.alpha(110, 45), 0, "unrelated active mask still cuts the conditional image");
  });
});

test("rotated image envelopes and extended contact layers are not clipped to the unrotated placement", () => {
  withRasterDocument(() => {
    const rotated = { ...image("rotated-ground", { x: 30, y: 30, width: 90, height: 20 }),
      imagePlacement: { x: 120, y: 30, width: 20, height: 90, rotation: 90 } };
    const shape = scene([rotated], [], [mask("tree", { x: 45, y: 30, width: 15, height: 20 })]);
    const target = occlusionRaster();
    withForestImageOcclusion(target.getContext("2d"), shape, rotated, ctx => paintBounds(ctx, rotated.bounds));
    assert.equal(target.alpha(50, 40), 0);
    assert.equal(target.alpha(80, 40), 1, "rotated pixels outside the original narrow placement survive");
    const expanded = { x: 20, y: 20, width: 110, height: 50 }, contactTarget = occlusionRaster();
    withForestImageOcclusion(contactTarget.getContext("2d"), shape, rotated, ctx => paintBounds(ctx, expanded), expanded);
    assert.equal(contactTarget.alpha(25, 25), 1, "the supplied contact envelope retains its padding");
    assert.equal(contactTarget.alpha(50, 40), 0, "padding does not disable the canopy mask");
  });
});

test("paintFixedWorld masks a builder home's foundation and house while retaining the baked background", () => {
  withRasterDocument(() => {
    const site = building(), base = image("renamed-landscape", { x: 0, y: 0, width: 200, height: 200 });
    const patch = { ...image("builder-home-ground"), when: { siteId: site.id, level: 0 } };
    const shape = scene([base, patch], [site]);
    const images = new Map([[base.image, artwork(200, 200, .25)], [patch.image, artwork(120, 130)],
      [site.states[0].image, artwork(120, 80)]]);
    const target = paintScene(shape, images, { paintGround(ctx) { ctx.globalAlpha = .5; ctx.fillRect(60, 45, 1, 1); } });
    assert.equal(target.alpha(50, 45), .25, "both placed pictures reveal the original tree/background underneath");
    assert.equal(target.alpha(60, 45), .625, "procedural ground effects keep their separate pass");
    assert.equal(target.alpha(95, 45), 1, "the unobstructed house stays visible");
    assert.equal(target.alpha(60, 120), 1, "ground in front of the house is retained");
    assert.equal(target.alpha(145, 45), .25, "the original full-world image is never erased");
  });
});

test("only the first underlying full-world image is exempt, not later full-sized or first small pictures", () => {
  withRasterDocument(() => {
    const base = image("base", { x: 0, y: 0, width: 200, height: 200 });
    const overlay = image("overlay", { x: 0, y: 0, width: 200, height: 200 });
    const images = new Map([[base.image, artwork(200, 200, .25)], [overlay.image, artwork(200, 200)]]);
    const target = paintScene(scene([base, overlay]), images);
    assert.equal(target.alpha(60, 45), .25, "a full-sized overlay cannot cover the underlying canopy");
    assert.equal(target.alpha(95, 45), 1);
    const patch = image("first-small-picture"), small = paintScene(scene([patch]), new Map([[patch.image, artwork(120, 130)]]));
    assert.equal(small.alpha(60, 45), 0, "the first terrain entry alone does not qualify for base exemption");
    assert.equal(small.alpha(95, 45), 1);
  });
});

test("the terrain renderer preserves the authored image rotation inside an occluded layer", () => {
  withRasterDocument(() => {
    const base = image("base", { x: 0, y: 0, width: 200, height: 200 });
    const rotated = { ...image("rotated", { x: 30, y: 30, width: 90, height: 20 }),
      imagePlacement: { x: 120, y: 30, width: 20, height: 90, rotation: 90 } };
    const shape = scene([base, rotated], [], [mask("tree", { x: 45, y: 30, width: 15, height: 20 })]);
    const target = paintScene(shape, new Map([[base.image, artwork(200, 200, .25)], [rotated.image, artwork(20, 90)]]));
    assert.equal(target.alpha(50, 40), .25, "the rotated overlap reveals the original background");
    assert.equal(target.alpha(80, 40), 1, "the image draws at its rotated rather than unrotated location");
    assert.equal(target.alpha(119, 40), 1, "the complete rotated envelope remains available");
    assert.equal(target.alpha(120, 40), .25, "rotation does not spill beyond the envelope");
  });
});

test("a standalone bush's foreground redraw also stays below the canopy in normal and reduced motion", () => {
  withRasterDocument(() => {
    const cutout = image("foreground-bush", { x: 20, y: 20, width: 120, height: 80 });
    const shape = scene([cutout]);
    shape.bushes = [{ id: "bush", imageId: cutout.id, points: points(cutout.bounds),
      entry: { x: 100, y: 110 }, hide: { x: 80, y: 80 } }];
    const source = artwork(120, 80); source.naturalWidth = 120; source.naturalHeight = 80;
    for (const still of [false, true]) {
      const target = raster(), ctx = target.getContext("2d");
      ctx.globalAlpha = .25; ctx.fillRect(0, 0, 200, 200); ctx.globalAlpha = 1;
      drawForestBush(ctx, shape, new Map([[cutout.image, source]]), { id: "bush", rustle: 0, occlude: true }, 0, still);
      assert.equal(target.alpha(60, 45), .25, `foreground PNG cannot repaint the canopy (still=${still})`);
      assert.equal(target.alpha(95, 45), 1, "leaves outside the tree silhouette remain visible");
    }
  });
});
