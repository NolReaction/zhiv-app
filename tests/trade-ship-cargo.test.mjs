import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { recordingShipCanvas } from "./helpers/trade-ship-canvas.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { tradeShipCargo } = await vite.ssrLoadModule("/features/world/scene/trade-ship-cargo.ts");
const { drawTradeShipCargo } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-cargo.ts");
const { drawTradeShipSprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const ship = () => ({ voyage: { orders: [
  { items: { planks: 4, rope: 2 }, loadedItems: {}, deliveredAt: null },
  { items: { dried_berries: 4 }, loadedItems: {}, deliveredAt: null },
  { items: { bricks: 2 }, loadedItems: {}, deliveredAt: null },
] }, nextAvailableAt: null, completedVoyages: 0 });

test("deck props follow confirmed partial cargo per order, not available stock or foreign item IDs", () => {
  const state = ship(), untouched = structuredClone(state);
  assert.deepEqual(tradeShipCargo(state), [0, 0, 0]);
  assert.deepEqual(tradeShipCargo({ voyage: { id: "header-only" } }), [], "a restored header cannot invent cargo or break the scene");
  assert.deepEqual(state, untouched);
  state.voyage.orders[0].loadedItems = { planks: 1, rope: 1, stone: 999 };
  state.voyage.orders[1].loadedItems = { dried_berries: 2 };
  assert.deepEqual(tradeShipCargo(state), [1 / 3, .5, 0]);
  state.voyage.orders[2].deliveredAt = "2026-11-01T12:00:00Z";
  assert.deepEqual(tradeShipCargo(state), [1 / 3, .5, 1], "legacy delivered cargo still looks full");
  state.voyage.orders[0].loadedItems.planks = 1000;
  assert.deepEqual(tradeShipCargo(state), [5 / 6, .5, 1], "extra quantity cannot fill the missing rope");
});

test("fully loaded departure stays full after the server removes the completed voyage", () => {
  const cooldown = { voyage: null, completedVoyages: 1, nextAvailableAt: "2026-11-01T18:00:00Z" };
  assert.deepEqual(tradeShipCargo(cooldown, true), [1, 1, 1]);
  for (const state of [undefined, null, ship(), { ...cooldown, nextAvailableAt: null }]) {
    const value = tradeShipCargo(state, true); assert(value.every(fraction => fraction === 0));
  }
  assert.deepEqual(tradeShipCargo(cooldown, false), [], "a new arrival never inherits the previous cargo");
});

test("cargo detail grows in bounded steps and empty or invalid loading never paints goods", () => {
  const calls = cargo => { const canvas = recordingShipCanvas(); drawTradeShipCargo(canvas.ctx, cargo);
    assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original); return canvas.calls; };
  assert.deepEqual(calls(undefined), []);
  assert.deepEqual(calls([NaN, Infinity, -1]), []);
  assert(calls([.25]).length < calls([.5]).length);
  assert(calls([.5]).length < calls([1]).length);
  assert.deepEqual(calls([1, 1, 1, 1e9]), calls([1, 1, 1]));
  assert.deepEqual(calls([100, 100, 100]), calls([1, 1, 1]));
});

test("cargo shares the exact raster hull transform, bob, tint and facing in both motion modes", () => {
  for (const still of [false, true]) for (const facing of ["left", "right"]) {
    const frame = { x: 120, y: 200, width: 310, heading: -.3, time: 3.4, night: .8, still, facing, cargo: [.2, .7, 1] };
    const canvas = recordingShipCanvas(); drawTradeShipSprite(canvas.ctx, {}, frame);
    assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
    const raster = canvas.calls.find(call => call.key === "drawImage");
    const cargo = canvas.calls.find(call => call.key === "ellipse");
    const [a,b,c,d,e,f] = raster.state.transform, ratio = 660 / 1774;
    const x = 70 + 947 * ratio, y = 60 + 473 * ratio;
    const expected = [a*ratio,b*ratio,c*ratio,d*ratio,a*x+c*y+e,b*x+d*y+f];
    cargo.state.transform.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-7));
    assert.equal(cargo.state.filter, raster.state.filter);
    assert.equal(cargo.state.globalAlpha, raster.state.globalAlpha);
  }
});

test("a failed cargo paint restores caller Canvas state through the nested ship transform", () => {
  const canvas = recordingShipCanvas("ellipse");
  assert.throws(() => drawTradeShipSprite(canvas.ctx, {}, { x: 0, y: 0, width: 310, cargo: [1], still: true }), /canvas failure/);
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
});


test("expired and paid departures preserve only the goods actually loaded", () => {
  const cooldown = { voyage: null, completedVoyages: 0, nextAvailableAt: "2026-11-01T18:00:00Z" };
  assert.deepEqual(tradeShipCargo({ ...cooldown, departureCargo: [1, .2, 0] }, true), [1, .2, 0]);
  assert.deepEqual(tradeShipCargo({ ...cooldown, departureCargo: [0, 0, 0] }, true), [0, 0, 0]);
  assert.deepEqual(tradeShipCargo({ ...cooldown, departureCargo: [1, .2, 0] }, false), []);
});
