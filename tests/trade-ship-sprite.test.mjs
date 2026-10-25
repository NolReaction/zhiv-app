import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawTradeShipSprite, TRADE_SHIP_SPRITE } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
function recordingCanvas(failOn) {
  const calls = [], stack = [];
  let gradient = 0;
  let state = { globalAlpha: .37, lineWidth: 7, lineJoin: "bevel", lineCap: "square", fillStyle: "before-fill",
    strokeStyle: "before-stroke", globalCompositeOperation: "xor", filter: "blur(2px)", imageSmoothingEnabled: false, imageSmoothingQuality: "low", transform: [2, 0, 0, 2, 11, 13] };
  const snapshot = () => ({ ...state, transform: [...state.transform] });
  const original = snapshot();
  const value = item => Array.isArray(item) ? item.map(value)
    : item && typeof item === "object" && "gradient" in item ? { gradient: item.gradient } : item;
  const finite = args => { for (const arg of args.flat(Infinity)) if (typeof arg === "number") assert.ok(Number.isFinite(arg)); };
  function multiply([a, b, c, d, e, f]) {
    const [p, q, r, s, x, y] = state.transform;
    state.transform = [p * a + r * b, q * a + s * b, p * c + r * d, q * c + s * d, p * e + r * f + x, q * e + s * f + y];
  }
  const ctx = new Proxy({}, {
    get(_, key) {
      if (key in state) return state[key];
      if (["canvas", "getImageData", "createPattern"].includes(key)) throw new Error(`Unexpected raster/DOM dependency: ${key}`);
      return (...args) => {
        finite(args); calls.push([key, ...args.map(value)]);
        if (key === failOn) throw new Error("recording failure");
        if (key === "save") stack.push(snapshot());
        else if (key === "restore") { assert.ok(stack.length, "restore without save"); state = stack.pop(); }
        else if (key === "translate") multiply([1, 0, 0, 1, ...args]);
        else if (key === "scale") multiply([args[0], 0, 0, args[1], 0, 0]);
        else if (key === "rotate") multiply([Math.cos(args[0]), Math.sin(args[0]), -Math.sin(args[0]), Math.cos(args[0]), 0, 0]);
        else if (key === "createLinearGradient" || key === "createRadialGradient") {
          const id = ++gradient;
          return { gradient: id, addColorStop(offset, color) { finite([offset]); assert.ok(!/NaN|Infinity/.test(color)); calls.push(["colorStop", id, offset, color]); } };
        }
      };
    },
    set(_, key, next) {
      if (typeof next === "number") finite([next]);
      state[key] = next; calls.push(["set", key, value(next)]); return true;
    },
  });
  return { ctx, calls, snapshot, original, depth: () => stack.length };
}


const source = { source: "provided PNG" };
function drawing(overrides = {}) {
  const canvas = recordingCanvas();
  drawTradeShipSprite(canvas.ctx, source, { x: 17, y: 29, width: 640, still: true, ...overrides });
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
  return canvas.calls;
}

test("the supplied PNG is unchanged, has real transparency and keeps its native aspect ratio", async () => {
  const file = await readFile(root + "/public" + TRADE_SHIP_SPRITE.src.split("?")[0]);
  assert.equal(createHash("sha256").update(file).digest("hex"), "608f97253e98bc118a80ecc2a69d293b902b0415bd7f54e53cdf9def6a7feebe");
  const metadata = await sharp(file).metadata();
  assert.equal(metadata.width, TRADE_SHIP_SPRITE.sourceWidth);
  assert.equal(metadata.height, TRADE_SHIP_SPRITE.sourceHeight);
  assert.equal(metadata.hasAlpha, true);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const [x, y] of [[0,0], [info.width-1,0], [0,info.height-1], [info.width-1,info.height-1]])
    assert.equal(data[(y * info.width + x) * 4 + 3], 0);
  assert.equal(TRADE_SHIP_SPRITE.image.width / TRADE_SHIP_SPRITE.image.height, metadata.width / metadata.height);
});

test("one PNG is drawn nose-left with caller-owned placement and no procedural replacement", () => {
  const calls = drawing();
  const images = calls.filter(call => call[0] === "drawImage");
  assert.equal(images.length, 1);
  assert.equal(images[0][1], source);
  assert.deepEqual(images[0].slice(2), [70, 60, 660, 330]);
  assert.ok(calls.some(call => call[0] === "scale" && call[1] === -1));
  assert.ok(!drawing({ facing: "right" }).some(call => call[0] === "scale" && call[1] === -1));
  assert.deepEqual(drawing({ time: 999 }), calls, "static PNG export contains no moving steam");
  assert.deepEqual(drawing({ water: false, velocityX: 40 }), calls);
  assert.notDeepEqual(drawing({ water: true }), calls);
  assert.notDeepEqual(drawing({ water: true, velocityX: 40 }), drawing({ water: true, velocityX: -40 }));
});

test("invalid placement is skipped; optional values are finite and Canvas state survives a raster failure", () => {
  for (const invalid of [{ x: NaN }, { y: Infinity }, { width: -1 }, { width: 0 }]) {
    const canvas = recordingCanvas(); drawTradeShipSprite(canvas.ctx, source, { x: 0, y: 0, width: 500, ...invalid });
    assert.deepEqual(canvas.calls, []);
  }
  assert.deepEqual(drawing({ time: NaN, heading: Infinity, night: NaN }), drawing());
  assert.deepEqual(drawing({ heading: 3, night: 4 }), drawing({ heading: .3, night: 1 }));
  const canvas = recordingCanvas("drawImage");
  assert.throws(() => drawTradeShipSprite(canvas.ctx, source, { x: 0, y: 0, width: 800, night: 1 }), /recording failure/);
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
});
