import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { recordingShipCanvas } from "./helpers/trade-ship-canvas.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawTradeShipWater, tradeShipWaterGeometry, TRADE_SHIP_WATERLINE } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-water.ts");
const { drawTradeShipSprite, tradeShipSpritePose } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const frame = { time: 2.3, night: 0, velocityX: 0, velocityY: 0 };
function drawing(overrides = {}, failOn) {
  const canvas = recordingShipCanvas(failOn);
  drawTradeShipWater(canvas.ctx, { ...frame, ...overrides });
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
  return canvas.calls;
}

test("contact water follows the supplied hull underside and remains soft at rest", () => {
  const geometry = tradeShipWaterGeometry(frame);
  assert.equal(geometry.strength, 0);
  assert.equal(geometry.waterline.length, TRADE_SHIP_WATERLINE.length);
  for (let i = 0; i < geometry.waterline.length; i++) {
    assert.ok(Math.abs(geometry.waterline[i].x - (70 + TRADE_SHIP_WATERLINE[i][0] * 660 / 1774)) < 1e-10);
    assert.ok(Math.abs(geometry.waterline[i].y - (60 + TRADE_SHIP_WATERLINE[i][1] * 660 / 1774)) < 1e-10);
  }
  const calls = drawing();
  assert.ok(calls.some(call => call.key === "stroke"));
  assert.ok(!calls.some(call => ["ellipse", "arc", "fillRect"].includes(call.key)), "no enormous oval under the ship");
  assert.ok(calls.filter(call => call.key === "lineTo").every(call => call.args[1] > 270), "no water rails across the deck");
});

test("wake emission follows actual travel and reverses at the opposite hull end", () => {
  for (const [x, y] of [[95,0],[-95,0],[0,95],[0,-95],[55,42]]) {
    const geometry = tradeShipWaterGeometry({ ...frame, velocityX: x, velocityY: y });
    assert.ok(geometry.strength > 0);
    const dot = point => point.x * x + point.y * y;
    assert.equal(dot(geometry.stern), Math.min(...geometry.waterline.map(dot)), "trailing support is opposite velocity");
    assert.equal(dot(geometry.bow), Math.max(...geometry.waterline.map(dot)), "pressure foam is on leading support");
    assert.notDeepEqual(drawing({ velocityX: x, velocityY: y }), drawing());
  }
  const forward = tradeShipWaterGeometry({ ...frame, velocityX: 95 });
  const reverse = tradeShipWaterGeometry({ ...frame, velocityX: -95 });
  assert.deepEqual(forward.stern, reverse.bow); assert.deepEqual(reverse.stern, forward.bow);
});

test("same time is deterministic, pause freezes foam, reduced motion freezes its surface phase", () => {
  assert.deepEqual(drawing({ velocityX: 70 }), drawing({ velocityX: 70 }));
  assert.notDeepEqual(drawing({ velocityX: 70, time: 4 }), drawing({ velocityX: 70, time: 8 }));
  assert.deepEqual(drawing({ velocityX: 70, still: true, time: 4 }), drawing({ velocityX: 70, still: true, time: 8 }));
  assert.notDeepEqual(drawing({ night: 1 }), drawing({ night: 0 }));
});

test("world velocity receives the inverse raster scale, rotation and mirror", () => {
  const pose = { x: 100, y: 200, width: 310, heading: -.6, still: true, water: true, velocityX: -15, velocityY: 38 };
  const transform = tradeShipSpritePose(pose), { heading, facing, scale } = transform;
  const local = { velocityX: (pose.velocityX * Math.cos(heading) + pose.velocityY * Math.sin(heading)) * facing / scale,
    velocityY: (-pose.velocityX * Math.sin(heading) + pose.velocityY * Math.cos(heading)) / scale };
  const expected = drawing({ ...local, time: 0, still: true });
  const canvas = recordingShipCanvas(); drawTradeShipSprite(canvas.ctx, {}, pose);
  const beforeRaster = canvas.calls.slice(0, canvas.calls.findIndex(call => call.key === "drawImage"));
  const strokes = calls => calls.filter(call => ["moveTo", "lineTo", "quadraticCurveTo"].includes(call.key)).map(call => [call.key, call.args]);
  assert.deepEqual(strokes(beforeRaster), strokes(expected));
});

test("invalid optional values stay finite and Canvas survives a drawing failure", () => {
  drawing({ time: NaN, night: Infinity, velocityX: NaN, velocityY: Infinity });
  drawing({ time: Number.MAX_VALUE, velocityX: Number.MAX_VALUE, velocityY: Number.MAX_VALUE });
  const target = recordingShipCanvas("stroke");
  assert.throws(() => drawTradeShipWater(target.ctx, frame), /canvas failure/);
  assert.equal(target.depth(), 0); assert.deepEqual(target.snapshot(), target.original);
});
