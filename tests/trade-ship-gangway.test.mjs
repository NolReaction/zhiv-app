import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawTradeShipGangway, tradeShipGangwayGeometry, TRADE_SHIP_GANGWAY_RIG: rig } =
  await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-gangway.ts");
const { drawTradeShipSprite, TRADE_SHIP_SPRITE: sprite } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const { createTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { previewPointInPolygon } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const frame = { ...createTradeShipMotion(), still: true };

function canvas(failOn) {
  let state = { transform: [1, 0, 0, 1, 0, 0], filter: "blur(2px)", fillStyle: "original", lineWidth: 7,
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
  for (const options of [{ still: true }, { still: false, time: .7 }, { still: false, time: 4.2 },
    { still: true, x: 200, y: 300, width: 620 }]) {
    const pose = { ...frame, ...options }, target = canvas();
    drawTradeShipSprite(target.ctx, {}, pose);
    const matrix = target.calls.find(call => call.key === "drawImage").state.transform;
    const [a,b,c,d,e,f] = matrix;
    const x = sprite.image.x + rig.source.x * sprite.image.width / sprite.sourceWidth;
    const y = sprite.image.y + rig.source.y * sprite.image.height / sprite.sourceHeight;
    const geometry = tradeShipGangwayGeometry(pose);
    near(geometry.from.x, a*x+c*y+e); near(geometry.from.y, b*x+d*y+f);
    near(geometry.tip.x, geometry.to.x); near(geometry.tip.y, geometry.to.y);
  }
  const fixed = tradeShipGangwayGeometry(frame), bobbed = tradeShipGangwayGeometry({ ...frame, still: false, time: .7 });
  assert.deepEqual(fixed.to, { x: 850, y: 1138 });
  assert.deepEqual(fixed.to, bobbed.to);
  assert.notDeepEqual(fixed.from, bobbed.from);
  assert.ok(Math.hypot(fixed.to.x - fixed.from.x, fixed.to.y - fixed.from.y) < 40);
  assert.equal(fixed.width, 14, "narrower than the 17.5 world-pixel gap between the existing posts");
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

test("hidden/invalid gangways paint nothing and painter restores Canvas even if drawing fails", () => {
  for (const overrides of [{ gangway: 0 }, { gangway: -1 }, { gangway: NaN }, { x: NaN }, { y: Infinity }, { width: 0 }]) {
    const target = canvas(); drawTradeShipGangway(target.ctx, { ...frame, ...overrides }); assert.deepEqual(target.calls, []);
  }
  for (const options of [{}, { night: 1, time: 4, still: false }, { night: NaN, heading: Infinity, time: Infinity }]) {
    const target = canvas(); drawTradeShipGangway(target.ctx, { ...frame, ...options });
    assert.ok(target.calls.some(call => call.key === "fillRect"));
    assert.equal(target.depth(), 0); assert.deepEqual(target.current(), target.original);
  }
  const failed = canvas("fillRect");
  assert.throws(() => drawTradeShipGangway(failed.ctx, frame), /canvas failure/);
  assert.equal(failed.depth(), 0); assert.deepEqual(failed.current(), failed.original);
});
