import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestWaterDynamics: create, disturbForestWater: disturb } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-dynamics.ts");
const { drawForestWaterRefraction: draw } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-refraction.ts");
const { containsDynamicsWater: wet } = await vite.ssrLoadModule("/features/world/environment/water/water-dynamics-geometry.ts");
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");
const rectangle = (x, y, width, height) => ({ points: [{ x, y }, { x: x + width, y },
  { x: x + width, y: y + height }, { x, y: y + height }] });
const terrain = { id: "ground", image: "/ground", bounds: { x: 0, y: 0, width: 1254, height: 1254 } };
const image = { naturalWidth: 2508, naturalHeight: 2508 };
const scene = () => ({ width: 1254, height: 1254, sites: [], lights: [], paths: [], terrain: [terrain],
  water: { surfaces: [rectangle(10, 10, 280, 240)], exclusions: [rectangle(111.1, 70, .2, 100), rectangle(190, 155, 25, 25)] } });
function context(e = 0) {
  const draws = [], clips = [], stack = [];
  return new Proxy({ draws, clips, globalAlpha: 1, imageSmoothingEnabled: false, canvas: { width: 1254, height: 1254 },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e, f: 0 }),
    save() { stack.push([this.globalAlpha, this.imageSmoothingEnabled]); },
    restore() { [this.globalAlpha, this.imageSmoothingEnabled] = stack.pop(); },
    clip(...args) { clips.push(args); },
    drawImage(...args) { draws.push(args); },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
}
function browser(run) {
  const prior = globalThis.Path2D;
  globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} };
  try { run(); } finally { if (prior === undefined) delete globalThis.Path2D; else globalThis.Path2D = prior; }
}

test("refraction keeps both its source and destination footprints in water, including a thin island", () => browser(() => {
  const world = scene(), state = create(world), ctx = context();
  disturb(state, { x: 75, y: 90 }, { strength: 3 }); state.elapsed = 3;
  draw(ctx, world, state, image, terrain, {});
  assert.ok(ctx.draws.length > 10 && ctx.draws.length <= 48 * 48);
  assert.equal(ctx.clips.length, 0, "certified interior patches need no repeated shoreline clip");
  for (const args of ctx.draws) {
    const [, sx, sy, sw, sh, x, y, width, height] = args;
    for (const [left, top, w, h] of [[sx / 2, sy / 2, sw / 2, sh / 2], [x, y, width, height]]) {
      // Interior probes catch a narrow exclusion even when all four corners are wet.
      for (let row = 0; row <= 20; row++) for (let column = 0; column <= 20; column++) {
        assert.ok(wet(state.geometry, { x: left + w * column / 20, y: top + h * row / 20 }));
      }
      assert.ok(!(left < 111.3 && left + w > 111.1 && top < 170 && top + h > 70));
    }
  }
  assert.equal(ctx.globalAlpha, 1); assert.equal(ctx.imageSmoothingEnabled, false);
}));

test("a scene with replacement shoreline geometry retains exact clipping while its solver is stale", () => browser(() => {
  const world = scene(), state = create(world), changed = { ...world,
    water: { ...world.water, exclusions: [rectangle(60, 20, 15, 160)] } };
  const ctx = context();
  draw(ctx, changed, state, image, terrain, {});
  assert.ok(ctx.draws.length > 10);
  assert.equal(ctx.clips.length, 1, "the compiled wet boundary includes the new island when clipping the old solver's patches");
  const current = context();
  draw(current, changed, create(changed), image, terrain, {});
  assert.equal(current.clips.length, 0, "replacement solver geometry restores the certified fast path");
}));

test("refraction follows active water time and waves without mutating or allocating simulation state", () => browser(() => {
  const world = scene(), state = create(world), before = structuredClone(state), first = context(), repeat = context();
  draw(first, world, state, image, terrain, {}); draw(repeat, world, state, image, terrain, {});
  assert.deepEqual(first.draws, repeat.draws, "paused time paints the same offsets");
  assert.deepEqual(state, before);
  state.elapsed = 2;
  const later = context(); draw(later, world, state, image, terrain, {});
  assert.notDeepEqual(later.draws, first.draws);
  const mip = context(); draw(mip, world, state, { width: 627, height: 627 }, terrain, {});
  assert.equal(mip.draws.length, later.draws.length);
  assert.deepEqual(mip.draws.map(args => args.slice(5)), later.draws.map(args => args.slice(5)));
  assert.deepEqual(mip.draws[0].slice(1, 5), later.draws[0].slice(1, 5).map(value => value / 4), "source uses the same mip resolution as the backdrop");
  const still = context(); draw(still, world, state, image, terrain, { reducedMotion: true });
  const outside = context(2000); draw(outside, world, state, image, terrain, {});
  assert.equal(still.draws.length, 0); assert.equal(outside.draws.length, 0);
}));

test("missing images, rotated unsupported backdrops and SSR skip refraction safely", () => {
  const world = scene(), state = create(world), ctx = context();
  draw(ctx, world, state, image, terrain, {});
  assert.equal(ctx.draws.length, 0);
  browser(() => {
    draw(ctx, world, state, { naturalWidth: 0, naturalHeight: 0 }, terrain, {});
    draw(ctx, world, state, image, { ...terrain, imagePlacement: { ...terrain.bounds, rotation: 30 } }, {});
    assert.equal(ctx.draws.length, 0);
  });
});

test("backdrop effects paint before later terrain and ground effects", () => {
  const world = scene(), ctx = context(), cutout = { naturalWidth: 50, naturalHeight: 50 };
  world.terrain.push({ id: "bank", image: "/bank", bounds: { x: 40, y: 50, width: 50, height: 50 } });
  paintFixedWorld(ctx, world, { images: new Map([["/ground", image], ["/bank", cutout]]), visuals: {}, actor: null,
    options: { levels: {}, night: false, debug: false, reducedMotion: false, selectedSiteId: null },
    paintBackdrop: () => ctx.draws.push(["refraction"]), paintGround: () => ctx.draws.push(["surface"]),
  });
  assert.deepEqual(ctx.draws.map(args => args[0]), [image, "refraction", cutout, "surface"]);
});
