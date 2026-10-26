import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawTradeShipGangway, drawTradeShipGangwayDeck, tradeShipGangwayGeometry, TRADE_SHIP_GANGWAY_RIG: rig } =
  await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-gangway.ts");
const { drawTradeShipSprite, TRADE_SHIP_SPRITE: sprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const { createTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { previewPointInPolygon } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const frame = { ...createTradeShipMotion(), still: true };

function canvas(failOn) {
  let state = { transform: [1, 0, 0, 1, 0, 0], filter: "blur(2px)", globalAlpha: .43, fillStyle: "original", lineWidth: 7,
    strokeStyle: "original", lineJoin: "bevel", lineCap: "square" };
  const copy = () => ({ ...state, transform: [...state.transform] }), original = copy(), stack = [], calls = [];
  const ctx = new Proxy({}, {
    get(_, key) {
      if (key in state) return state[key];
      return (...args) => {
        calls.push({ key, args, state: copy() });
        for (const arg of args) if (typeof arg === "number") assert.ok(Number.isFinite(arg));
        if (key === failOn) throw new Error("canvas failure");
        if (key === "save") stack.push(copy());
        else if (key === "restore") state = stack.pop();
        else if (key === "createLinearGradient" || key === "createRadialGradient") return { addColorStop() {} };
        else if (["translate", "scale", "rotate"].includes(key)) {
          const [a,b,c,d,e,f] = state.transform;
          const [p,q,r,s,x,y] = key === "translate" ? [1,0,0,1,...args]
            : key === "scale" ? [args[0],0,0,args[1],0,0]
              : [Math.cos(args[0]),Math.sin(args[0]),-Math.sin(args[0]),Math.cos(args[0]),0,0];
          state.transform = [a*p+c*q,b*p+d*q,a*r+c*s,b*r+d*s,a*x+c*y+e,b*x+d*y+f];
        }
      };
    },
    set(_, key, value) { state[key] = value; return true; },
  });
  return { ctx, calls, original, current: copy, depth: () => stack.length };
}

test("hinge follows the real mirrored, calibrated raster transform and bob; shore stays fixed", () => {
  for (const options of [{ still: true }, { still: false, time: .7 }, { still: false, time: 4.2 }, { still: false, time: 1000001 },
    { still: true, x: 200, y: 300, width: 620 }]) {
    const pose = { ...frame, ...options }, target = canvas();
    drawTradeShipSprite(target.ctx, {}, pose);
    const matrix = target.calls.find(call => call.key === "drawImage").state.transform;
    const [a,b,c,d,e,f] = matrix;
    const x = sprite.image.x + rig.source.x * sprite.image.width / sprite.sourceWidth;
    const y = sprite.image.y + rig.source.y * sprite.image.height / sprite.sourceHeight;
    const geometry = tradeShipGangwayGeometry(pose);
    near(geometry.from.x, a*x+c*y+e); near(geometry.from.y, b*x+d*y+f);
    const deckX = sprite.image.x + rig.deckSource.x * sprite.image.width / sprite.sourceWidth;
    const deckY = sprite.image.y + rig.deckSource.y * sprite.image.height / sprite.sourceHeight;
    near(geometry.deck.to.x, a*deckX+c*deckY+e); near(geometry.deck.to.y, b*deckX+d*deckY+f);
    near(geometry.tip.x, geometry.to.x); near(geometry.tip.y, geometry.to.y);
  }
  const fixed = tradeShipGangwayGeometry(frame), bobbed = tradeShipGangwayGeometry({ ...frame, still: false, time: .7 });
  assert.deepEqual(fixed.to, { x: 850, y: 1138 });
  assert.deepEqual(fixed.to, bobbed.to);
  assert.notDeepEqual(fixed.from, bobbed.from);
  assert.ok(Math.hypot(fixed.to.x - fixed.from.x, fixed.to.y - fixed.from.y) < 40);
  assert.equal(fixed.width, 14, "narrower than the 17.5 world-pixel gap between the existing posts");
});

test("the foreground tongue rests visibly on opaque deck beyond the original threshold", async () => {
  const geometry = tradeShipGangwayGeometry(frame), { deck } = geometry;
  const length = Math.hypot(deck.to.x - geometry.from.x, deck.to.y - geometry.from.y);
  assert.ok(length > 9 && length < 14, "enough supported wood must remain visible inside the ship");
  assert.ok(deck.to.y > geometry.from.y + 9, "tongue extends onto the near deck, away from shore");
  const { data, info } = await sharp(root + "/public" + sprite.src.split("?")[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const x of [rig.deckSource.x - 50, rig.deckSource.x, rig.deckSource.x + 50]) {
    const alpha = data[(rig.deckSource.y * info.width + x) * 4 + 3];
    assert.ok(alpha >= 250, "full tongue width is supported by the unmodified opaque deck");
  }
  const background = canvas(), foreground = canvas();
  drawTradeShipGangway(background.ctx, frame); drawTradeShipGangwayDeck(foreground.ctx, frame);
  const foregroundPath = foreground.calls.filter(call => call.key === "moveTo" || call.key === "lineTo");
  assert.ok(foregroundPath.some(call => call.args[1] >= deck.to.y), "after-PNG pass actually draws the deck end");
  assert.ok(background.calls.some(call => call.key === "fill"));
  assert.ok(foreground.calls.some(call => call.key === "fill"));
});

test("shore landing spans dry authored land while the ship hinge is at the water edge", async () => {
  const tiled = JSON.parse(await readFile(root + "/world/tiled/forest.tmj", "utf8"));
  function polygons(layers, offset = { x: 0, y: 0 }) {
    return layers.flatMap(layer => {
      const origin = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
      if (layer.layers) return polygons(layer.layers, origin);
      if (layer.name !== "Water") return [];
      return (layer.objects ?? []).map(object => {
        const angle = (object.rotation ?? 0) * Math.PI / 180;
        return object.polygon.map(point => ({ x: origin.x + object.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
          y: origin.y + object.y + point.x * Math.sin(angle) + point.y * Math.cos(angle) }));
      });
    });
  }
  const water = polygons(tiled.layers), { from, to, width } = tradeShipGangwayGeometry(frame);
  assert.ok(water.length);
  assert.ok(water.some(polygon => previewPointInPolygon(from, polygon)), "source joint meets the ship at the water edge");
  for (const x of [to.x - width / 2, to.x, to.x + width / 2])
    assert.equal(water.some(polygon => previewPointInPolygon({ x, y: to.y }, polygon)), false, "entire landing reaches land");
});

test("extension reaches the same shore without stretching placement or width", () => {
  let previous = 0;
  for (const gangway of [.01, .25, .5, .75, 1]) {
    const geometry = tradeShipGangwayGeometry({ ...frame, gangway });
    const length = Math.hypot(geometry.tip.x - geometry.from.x, geometry.tip.y - geometry.from.y);
    assert.ok(length > previous); previous = length;
    near(length, Math.hypot(geometry.to.x - geometry.from.x, geometry.to.y - geometry.from.y) * gangway);
    assert.equal(geometry.width, rig.width);
  }
});

test("deck support grows continuously and fades away with the same retracting bridge", () => {
  let previous = 0;
  const full = tradeShipGangwayGeometry(frame);
  const maximum = Math.hypot(full.deck.to.x - full.from.x, full.deck.to.y - full.from.y);
  for (const gangway of [.0001, .01, .05, .2, .5, 1]) {
    const geometry = tradeShipGangwayGeometry({ ...frame, gangway });
    const length = Math.hypot(geometry.deck.tip.x - geometry.from.x, geometry.deck.tip.y - geometry.from.y);
    assert.ok(length >= previous - 1e-8 && length <= maximum + 1e-8); previous = length;
    if (gangway < .01) assert.ok(length < .01, "no full deck plate appears at the first animation frame");
    const target = canvas(); drawTradeShipGangwayDeck(target.ctx, { ...frame, gangway });
    const painted = target.calls.filter(call => call.key === "fill");
    assert.ok(painted.length > 0);
    if (gangway < .01) assert.ok(painted.every(call => call.state.globalAlpha < .01));
    assert.deepEqual(target.current(), target.original);
  }
});

test("both bridge passes paint nothing when stowed and restore Canvas even if drawing fails", () => {
  for (const painter of [drawTradeShipGangway, drawTradeShipGangwayDeck]) {
    for (const overrides of [{ gangway: 0 }, { gangway: -1 }, { gangway: NaN }, { gangway: Infinity }, { x: NaN }, { y: Infinity }, { width: 0 }]) {
      const target = canvas(); painter(target.ctx, { ...frame, ...overrides }); assert.deepEqual(target.calls, []);
    }
    for (const options of [{}, { night: 1, time: 4, still: false }, { night: NaN, heading: Infinity, time: Infinity }]) {
      const target = canvas(); painter(target.ctx, { ...frame, ...options });
      assert.ok(target.calls.some(call => call.key === "fill"));
      assert.equal(target.depth(), 0); assert.deepEqual(target.current(), target.original);
    }
    const failed = canvas("fill");
    assert.throws(() => painter(failed.ctx, frame), /canvas failure/);
    assert.equal(failed.depth(), 0); assert.deepEqual(failed.current(), failed.original);
  }
});
