import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { sampleTradeShipMotion, TRADE_SHIP_VOYAGE } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { TRADE_SHIP_SPRITE: sprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const { previewPointInPolygon } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const tiled = JSON.parse(await readFile(root + "/world/tiled/forest.tmj", "utf8"));

function polygons(name, layers = tiled.layers, offset = { x: 0, y: 0 }) {
  return layers.flatMap(layer => {
    const origin = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
    if (layer.layers) return polygons(name, layer.layers, origin);
    if (layer.name !== name) return [];
    return (layer.objects ?? []).map(object => {
      assert.ok(object.polygon, `Expected a polygon in ${name}; update the route check for other geometry`);
      const angle = (object.rotation ?? 0) * Math.PI / 180;
      return object.polygon.map(point => ({
        x: origin.x + object.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
        y: origin.y + object.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
      }));
    });
  });
}
const surfaces = polygons("Water"), exclusions = polygons("WaterExclusions");
const edges = [...surfaces, ...exclusions].flatMap(polygon => polygon.map((point, index) =>
  [point, polygon[(index + 1) % polygon.length]]));
const bottom = tiled.height * tiled.tileheight;
function wet(point, holes = exclusions) {
  if (holes.some(polygon => previewPointInPolygon(point, polygon))) return false;
  // The Tiled water edge stops a fraction of a pixel above the open bottom sea.
  return point.y >= bottom - .1 || surfaces.some(polygon => previewPointInPolygon(point, polygon));
}

const { data, info } = await sharp(root + "/public" + sprite.src.split("?")[0])
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const waterline = [];
// Follow the actual opaque lower hull across the complete PNG width, including
// bow, stern and fenders. Roof/chimney height is not a water-contact footprint.
// Three strips cover the bottom 24 native pixels (~3.5 world px at this scale).
for (let x = 0; x < info.width; x++) {
  let y = info.height - 1;
  while (y >= 0 && data[(y * info.width + x) * 4 + 3] <= 64) y--;
  for (const inset of [0, 12, 24]) {
    const row = y - inset;
    if (row >= 0 && data[(row * info.width + x) * 4 + 3] > 64) waterline.push({ x, y: row });
  }
}

function placement(point, state, bob = 0) {
  const scale = state.width / sprite.width, angle = sprite.baseHeading + state.heading;
  const x = sprite.width - (sprite.image.x + point.x * sprite.image.width / info.width) - sprite.pivot.x;
  const y = sprite.image.y + point.y * sprite.image.height / info.height + bob - sprite.pivot.y;
  return {
    x: state.x + (sprite.pivot.x + x * Math.cos(angle) - y * Math.sin(angle)) * scale,
    y: state.y + (sprite.pivot.y + x * Math.sin(angle) + y * Math.cos(angle)) * scale,
  };
}

test("the rotated PNG waterline stays in Water through tilted arrival, level stern-right clearance and CCW exit", () => {
  assert.ok(surfaces.length > 0 && waterline.length > 5000, "every native PNG column contributes its hull contact strips");
  let clockwiseArrival = false, counterclockwiseExit = false;
  for (const phase of ["arriving", "departing"]) {
    const duration = phase === "arriving" ? TRADE_SHIP_VOYAGE.arrivalDuration : TRADE_SHIP_VOYAGE.departureDuration;
    for (let step = 0; step <= duration * 10; step++) {
      const state = sampleTradeShipMotion(phase, step / 10);
      clockwiseArrival ||= phase === "arriving" && state.heading > .2;
      counterclockwiseExit ||= phase === "departing" && state.heading < -.5;
      for (const point of waterline) for (const bob of [-.8, .8]) {
        const actual = placement(point, state, bob);
        assert.ok(wet(actual), `${phase} at ${step / 10}s: hull meets land/exclusion at ${actual.x},${actual.y}`);
      }
    }
  }
  assert.ok(clockwiseArrival && counterclockwiseExit, "coast validation must include both requested rotated poses");
});

test("the waterline check rejects an unsafe berth and authored water exclusions", () => {
  const docked = sampleTradeShipMotion("docked", 0);
  const unsafe = { ...docked, y: docked.y - 50 };
  assert.ok(waterline.some(point => !wet(placement(point, unsafe))), "moving the ship onto the bank must fail");
  const point = placement(waterline[Math.floor(waterline.length / 2)], docked);
  assert.ok(wet(point));
  const hole = [{ x: point.x - 1, y: point.y - 1 }, { x: point.x + 1, y: point.y - 1 },
    { x: point.x + 1, y: point.y + 1 }, { x: point.x - 1, y: point.y + 1 }];
  assert.equal(wet(point, [...exclusions, hole]), false, "WaterExclusions must be subtracted from water");
});

test("the entire straight-right swept waterline clears the bank between animation frames", () => {
  const start = sampleTradeShipMotion("departing", 0);
  const finish = sampleTradeShipMotion("departing", TRADE_SHIP_VOYAGE.backingDuration);
  assert.equal(start.y, finish.y); assert.ok(start.heading === 0 && finish.heading === 0);
  for (const point of waterline) for (const bob of [-.8, .8]) {
    const a = placement(point, start, bob), b = placement(point, finish, bob);
    const cuts = [a.x, b.x];
    // Split this exact horizontal sweep at every authored shoreline/hole
    // intersection; each open interval then lies entirely in water or on land.
    for (const [c, d] of edges) {
      if ((c.y > a.y) === (d.y > a.y)) continue;
      const x = c.x + (a.y - c.y) * (d.x - c.x) / (d.y - c.y);
      if (x > a.x && x < b.x) cuts.push(x);
    }
    cuts.sort((left, right) => left - right);
    assert.ok(wet(a) && wet(b), "straight-right sweep endpoints must stay wet");
    for (let n = 1; n < cuts.length; n++) {
      assert.ok(wet({ x: (cuts[n - 1] + cuts[n]) / 2, y: a.y }),
        `straight-right hull sweep crosses land at y=${a.y}, x=${cuts[n - 1]}..${cuts[n]}`);
    }
  }
});

test("arrival and departure endpoints clear the whole visible PNG before hiding", () => {
  const arrival = sampleTradeShipMotion("arriving", 0);
  const departure = sampleTradeShipMotion("departing", TRADE_SHIP_VOYAGE.departureDuration);
  // Check every opaque pixel on a coarse grid, including the tall chimney: the
  // complete picture, rather than only its waterline, must be out of the world.
  for (let y = 0; y < info.height; y += 8) for (let x = 0; x < info.width; x += 8) {
    if (data[(y * info.width + x) * 4 + 3] <= 64) continue;
    assert.ok(placement({ x, y }, arrival, -.8).y > 1320);
    assert.ok(placement({ x, y }, departure, -.8).y > 1320);
  }
  assert.equal(departure.visible, false);
});
