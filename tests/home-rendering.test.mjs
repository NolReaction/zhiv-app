import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { homeBackingSize, HOME_TEXTURE_SIZE } = await vite.ssrLoadModule("/features/mochlik/home-art.ts");
const { drawLanternLight, drawLanternGlass, drawSceneShade, NIGHT_SHADE } = await vite.ssrLoadModule("/features/mochlik/lantern-light.ts");
const { FOREST_MAP } = await vite.ssrLoadModule("/features/world/map-manifest.ts");

test("detail has enough real pixels for retina circles and a bounded detached world canvas", async () => {
  const bytes = await readFile(`${root}/public${FOREST_MAP.homeDetail.image}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "f14fba0d71b976ed63530726e3b4a86241ab72a409e8e837a7a5b36fae5ef8bd", "approved home texture stays unchanged");
  assert.ok(bytes.readUInt32BE(16) >= HOME_TEXTURE_SIZE);
  assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  assert.equal(homeBackingSize(320, 2), 640);
  assert.equal(homeBackingSize(280, 3), 840);
  assert.equal(homeBackingSize(900, 3), HOME_TEXTURE_SIZE);
  assert.equal(homeBackingSize(0, 2, true), HOME_TEXTURE_SIZE);
  assert.equal(homeBackingSize(NaN, NaN), 256);
  assert.deepEqual(FOREST_MAP.homeCrop, { x: 486, y: 514, size: 256 }, "quality change preserves the accepted scale");
});

test("lantern emits only at night, with separate soft clearing and glass falloff", () => {
  const stops = [], fills = [];
  const gradient = { addColorStop: (...stop) => stops.push(stop) };
  const ctx = { save() {}, restore() {}, createRadialGradient: () => gradient, fillRect() { fills.push({ paint: this.fillStyle, mode: this.globalCompositeOperation }); } };
  drawLanternLight(ctx, 0, 0);
  assert.equal(fills.length, 0);
  drawLanternLight(ctx, 1, 0);
  assert.equal(fills.length, 0, "daytime never emits light");
  drawLanternLight(ctx, 1, 1);
  assert.deepEqual(fills, [{ paint: gradient, mode: "screen" }, { paint: gradient, mode: "screen" }]);
  assert.deepEqual(stops.at(-1), [1, "rgba(255,181,65,0)"]);
});


test("daytime glass keeps texture; dark night receives separate cool moonlight", () => {
  const fills = [];
  const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() { fills.push({ mode: this.globalCompositeOperation, color: this.fillStyle }); } },
    { get: (object, key) => key in object ? object[key] : () => {} });
  drawLanternGlass(ctx, 1); assert.equal(fills.length, 0);
  drawLanternGlass(ctx, 0); assert.equal(fills.length, 1); assert.equal(fills[0].mode, "multiply");
  fills.length = 0; drawSceneShade(ctx, 1, 0, 256);
  assert.ok(NIGHT_SHADE >= .5 && NIGHT_SHADE < .65, "night returns to a dark base with lit clearings");
  assert.equal(fills[0].color, `rgba(8,17,37,${NIGHT_SHADE})`);
  assert.ok(fills.some(fill => fill.mode === "screen"), "moonlight opens up the dark base");
});
