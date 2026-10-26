import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { recordingShipCanvas } from "./helpers/trade-ship-canvas.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawTradeShipLighting, TRADE_SHIP_LIGHT_RIG: rig } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-lighting.ts");
const { drawTradeShipSprite, TRADE_SHIP_SPRITE: sprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const frame = { x: 705, y: 1102, width: 310, time: 3.7, night: 1, still: false };
function drawing(overrides = {}) {
  const canvas = recordingShipCanvas(); drawTradeShipLighting(canvas.ctx, { ...frame, ...overrides });
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original); return JSON.parse(JSON.stringify(canvas.calls));
}
const worldPoint = (matrix, x, y) => { const [a,b,c,d,e,f] = matrix; return { x: a*x+c*y+e, y: b*x+d*y+f }; };
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);

test("daylight, disabled lights and invalid placement paint no emissive pass", () => {
  for (const options of [{ night: 0 }, { night: NaN }, { night: Infinity }, { enabled: false }, { x: NaN }, { y: Infinity }, { width: 0 }])
    assert.deepEqual(drawing(options), []);
  assert.ok(drawing({ night: .35 }).some(call => call.key === "fill"), "dusk fades lights in");
  const alpha = calls => calls.filter(call => call.key === "fill").at(-1).state.globalAlpha;
  assert.ok(alpha(drawing({ night: .35 })) < alpha(drawing({ night: 1 })));
});

test("lamp glass follows the exact real raster transform, bob, heading and mirror", () => {
  for (const options of [{}, { heading: .28 }, { heading: -.6, width: 620, x: 40, y: 80 }, { facing: "right" }, { still: true }]) {
    const pose = { ...frame, ...options }, raster = recordingShipCanvas(); drawTradeShipSprite(raster.ctx, {}, pose);
    const matrix = raster.calls.find(call => call.key === "drawImage").state.transform;
    const glow = drawing(options), panes = glow.filter(call => call.key === "moveTo").slice(-rig.panes.length);
    const native = rig.panes[0][0], actual = worldPoint(panes[0].state.transform, ...native);
    const expected = worldPoint(matrix, sprite.image.x + native[0] * sprite.image.width / sprite.sourceWidth,
      sprite.image.y + native[1] * sprite.image.height / sprite.sourceHeight);
    near(actual.x, expected.x); near(actual.y, expected.y);
  }
});

test("window frames stay open and deck spill is clipped; pools and reflections stay small", () => {
  assert.equal(rig.panes.length, 12, "8 cabin panes, 2 door panes, 2 boom glass slots");
  for (const pane of rig.panes) {
    const xs = pane.map(point => point[0]), ys = pane.map(point => point[1]);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 24);
    assert.ok(Math.max(...ys) - Math.min(...ys) <= 25);
  }
  const calls = drawing({ still: true });
  const clip = calls.findIndex(call => call.key === "clip"), firstPool = calls.findIndex(call => call.key === "fillRect");
  assert.ok(clip > 0 && firstPool > clip, "deck light is clipped to floor before it paints");
  const pools = calls.filter(call => call.key === "fillRect");
  assert.equal(pools.length, 2); assert.ok(pools.every(call => call.args[2] <= 290));
  const reflections = calls.filter(call => call.key === "lineTo").slice(0, 14);
  assert.equal(reflections.length, 14);
  assert.ok(calls.filter(call => call.key === "arc").every(call => call.args[2] <= 46), "no giant halo");
  assert.ok(calls.filter(call => call.key === "fill").every(call => call.state.globalCompositeOperation === "screen"));
});

test("pause is deterministic, reduced motion freezes light animation and bad values remain finite", () => {
  assert.deepEqual(drawing(), drawing());
  assert.notDeepEqual(drawing({ time: 2 }), drawing({ time: 8 }));
  assert.deepEqual(drawing({ time: 2, still: true }), drawing({ time: 8, still: true }));
  drawing({ time: NaN, heading: Infinity, night: 4 });
  drawing({ time: Number.MAX_VALUE, heading: Number.MAX_VALUE });
});

test("Canvas transform, composition and alpha restore even if deck lighting fails", () => {
  for (const failOn of ["stroke", "clip", "fillRect", "fill"]) {
    const canvas = recordingShipCanvas(failOn);
    assert.throws(() => drawTradeShipLighting(canvas.ctx, frame), /canvas failure/);
    assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
  }
});
