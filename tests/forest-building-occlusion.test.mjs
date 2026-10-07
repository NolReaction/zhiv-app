import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { occlusionRaster } from "./helpers/occlusion-raster.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { withForestOcclusion, withForestSiteOcclusion, forestVisibleSiteAt } = await vite.ssrLoadModule("/features/world/forest-occlusion.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");

const points = ({ x, y, width, height }) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
const tree = (id = "tree", bounds = { x: 40, y: 30, width: 40, height: 50 }, frontY = 80) => ({ id, frontY, points: points(bounds) });
function building(id = "house", anchorY = 70, bounds = { x: 20, y: 20, width: 120, height: 80 }) {
  return { id, label: id, initialLevel: 0, bounds, anchor: { x: 100, y: anchorY },
    entry: { x: 100, y: 150 }, hitArea: points(bounds), collision: [],
    states: [{ level: 0, label: "Built", image: `/${id}.png` }] };
}
const scene = (sites = [building()], occluders = [tree()]) => ({
  schemaVersion: 1, id: "building-occlusion", width: 200, height: 200,
  terrain: [], sites, occluders, paths: [], lights: [], focus: { x: 0, y: 0, width: 200, height: 200 },
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
function paintBounds(ctx, bounds) { ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height); }

test("building anchor depth hides only its tree overlap and preserves the ground beneath it", () => {
  withRasterDocument(() => {
    for (const anchorY of [79.999, 80, 81]) {
      const site = building("house", anchorY), target = occlusionRaster(), ctx = target.getContext("2d");
      ctx.globalAlpha = .35; ctx.fillRect(0, 0, 200, 200); ctx.globalAlpha = 1;
      let calls = 0;
      withForestSiteOcclusion(ctx, scene([site]), site, paint => { calls++; paintBounds(paint, site.bounds); });
      assert.equal(calls, 1);
      assert.equal(target.alpha(60, 45), anchorY < 80 ? .35 : 1, `anchor y=${anchorY}`);
      assert.equal(target.alpha(95, 45), 1, "the building beyond the canopy remains visible");
      assert.equal(target.alpha(10, 45), .35, "ground outside the building is unchanged");
      ctx.fillRect(60, 45, 1, 1);
      assert.equal(target.alpha(60, 45), 1, "the next object does not inherit the building mask");
    }
  });
});

test("a building ignores its own silhouette while trees and other buildings still mask it", () => {
  withRasterDocument(() => {
    const site = building(), own = { ...tree("house-silhouette", { x: 30, y: 30, width: 20, height: 40 }, 100),
      when: { siteId: site.id, level: 0 } };
    const other = { ...tree("stall-silhouette", { x: 110, y: 30, width: 20, height: 40 }, 100),
      when: { siteId: "stall", level: 0 } };
    const shape = scene([site], [own, tree("canopy", { x: 70, y: 30, width: 20, height: 40 }, 100), other]);
    const target = occlusionRaster();
    withForestSiteOcclusion(target.getContext("2d"), shape, site, paint => paintBounds(paint, site.bounds));
    assert.equal(target.alpha(40, 45), 1, "an active site-owned mask cannot erase its own image");
    assert.equal(target.alpha(80, 45), 0, "an unrelated tree still hides the building");
    assert.equal(target.alpha(120, 45), 0, "another site's silhouette remains foreground");
    const actorTarget = occlusionRaster();
    withForestOcclusion(actorTarget.getContext("2d"), shape, { x: 60, y: 70, size: 40 }, paint => paintBounds(paint, site.bounds));
    assert.equal(actorTarget.alpha(40, 45), 0, "self-exclusion does not remove the mask for residents");
  });
});

test("buildings and actors share the same inward feather without fading exterior pixels", () => {
  withRasterDocument(() => {
    const site = building(), shape = scene([site]), target = occlusionRaster(), actorTarget = occlusionRaster();
    const ctx = target.getContext("2d"), actorCtx = actorTarget.getContext("2d");
    ctx.globalAlpha = actorCtx.globalAlpha = .6;
    withForestSiteOcclusion(ctx, shape, site, paint => paintBounds(paint, site.bounds));
    withForestOcclusion(actorCtx, shape, { x: 100, y: site.anchor.y, size: 40 }, paint => paintBounds(paint, site.bounds), site.bounds);
    const edge = [39, 40, 41, 42, 43, 50, 79, 80];
    assert.deepEqual(edge.map(x => target.alpha(x, 45)), edge.map(x => actorTarget.alpha(x, 45)));
    assert.equal(target.alpha(39, 45), .6);
    assert.equal(target.alpha(80, 45), .6);
    assert.equal(target.alpha(50, 45), 0);
    const alpha = [40, 41, 42, 43].map(x => target.alpha(x, 45));
    assert.ok(alpha[0] < .6 && alpha[0] > alpha[1] && alpha[1] > alpha[2] && alpha[2] > 0 && alpha[3] === 0,
      `inward alpha falloff: ${alpha}`);
    assert.equal(ctx.globalAlpha, .6, "inherited opacity is restored");
  });
});

test("effective preview geometry uses the rotated envelope and only active level masks", () => {
  withRasterDocument(() => {
    const site = building("house", 120, { x: 120, y: 30, width: 20, height: 90 });
    const rotated = { bounds: { x: 30, y: 30, width: 90, height: 20 },
      imagePlacement: { x: 120, y: 30, width: 20, height: 90, rotation: 90 },
      anchor: { x: 110, y: 49 }, entry: { x: 150, y: 160 },
      hitArea: points({ x: 30, y: 30, width: 90, height: 20 }), collision: [] };
    site.states.push({ level: 1, label: "Rotated upgrade", image: "/house-1.png", geometry: rotated });
    const gate = building("gate", 180, { x: 170, y: 170, width: 10, height: 10 });
    gate.states.push({ level: 1, label: "Open", image: "/gate-1.png" });
    const mask = { ...tree("level-canopy", { x: 45, y: 30, width: 15, height: 20 }, 90), when: { siteId: "gate", level: 1 } };
    const source = scene([site, gate], [mask]);
    for (const gateLevel of [0, 1]) {
      const effective = previewWorldScene(source, { house: 1, gate: gateLevel }), activeSite = effective.sites[0];
      const target = occlusionRaster();
      withForestSiteOcclusion(target.getContext("2d"), effective, activeSite, paint => paintBounds(paint, activeSite.bounds));
      assert.equal(target.alpha(50, 40), gateLevel === 1 ? 0 : 1, "mask selection follows the effective preview level");
      assert.equal(target.alpha(80, 40), 1, "rotated artwork outside its unrotated placement is retained");
      assert.equal(target.alpha(119, 40), 1, "the whole rotated envelope fits the isolated layer");
      assert.equal(forestVisibleSiteAt(effective, { x: 50, y: 40 })?.id ?? null, gateLevel === 1 ? null : "house");
      assert.equal(forestVisibleSiteAt(effective, { x: 80, y: 40 })?.id, "house");
    }
    assert.equal(forestVisibleSiteAt(previewWorldScene(source, { house: 0, gate: 1 }), { x: 80, y: 40 }), null,
      "the upgraded hit polygon does not leak into the original level");
  });
});

test("visible hit testing keeps reverse draw order and skips hidden candidates", () => {
  const rear = building("rear", 90), top = building("top", 70), shape = scene([rear, top]);
  assert.equal(forestVisibleSiteAt(shape, { x: 95, y: 45 }), top, "visible overlaps prefer the later-painted site");
  assert.equal(forestVisibleSiteAt(shape, { x: 60, y: 45 }), rear, "a masked candidate does not block an eligible earlier site");
  assert.equal(forestVisibleSiteAt(scene([top]), { x: 60, y: 45 }), null, "fully hidden pixels are not selectable");
  assert.equal(forestVisibleSiteAt(scene([building("edge", 80)]), { x: 60, y: 45 })?.id, "edge",
    "an anchor on the foreground threshold is visible");
  assert.equal(forestVisibleSiteAt(shape, { x: 10, y: 45 }), null);
  const ownMask = { ...tree(), when: { siteId: top.id, level: 0 } };
  assert.equal(forestVisibleSiteAt(scene([top], [ownMask]), { x: 60, y: 45 }), top,
    "own artwork remains selectable inside its resident mask");
  assert.equal(forestVisibleSiteAt(scene([top], [ownMask, tree("other-tree")]), { x: 60, y: 45 }), null,
    "self-exclusion does not disable other masks for hit testing");
});

test("paintFixedWorld draws buildings into the masked target while terrain and ground effects survive", () => {
  withRasterDocument(allocated => {
    const site = building(), shape = scene([site]), target = occlusionRaster(), ctx = target.getContext("2d");
    const ground = occlusionRaster(200, 200), image = occlusionRaster(120, 80);
    ground.getContext("2d").globalAlpha = .25; ground.getContext("2d").fillRect(0, 0, 200, 200);
    image.getContext("2d").fillRect(0, 0, 120, 80);
    shape.terrain = [{ id: "ground", image: "/ground.png", bounds: shape.focus }];
    // The renderer's outer scene clip exactly matches this raster's canvas.
    ctx.rect = (x, y, width, height) => assert.deepEqual([x, y, width, height], [0, 0, 200, 200]);
    ctx.clip = () => {};
    paintFixedWorld(ctx, shape, { images: new Map([["/ground.png", ground], ["/house.png", image]]),
      visuals: { house: site.states[0] }, actor: null,
      options: { levels: { house: 0 }, night: false, debug: false, selectedSiteId: null, reducedMotion: true, buildingShadow: false },
      paintGround(paint) { paint.globalAlpha = .5; paint.fillRect(60, 45, 1, 1); },
    });
    assert.equal(target.alpha(50, 45), .25, "terrain remains behind the hidden roof");
    assert.equal(target.alpha(60, 45), .625, "ground effects are outside the building mask");
    assert.equal(target.alpha(95, 45), 1, "the visible building is painted");
    assert.equal(ctx.drawCalls.some(call => call.source === image), false, "the building cannot bypass the supplied masked target");
    assert.ok(allocated.some(canvas => canvas.getContext("2d").drawCalls.some(call => call.source === image)));
  });
});
