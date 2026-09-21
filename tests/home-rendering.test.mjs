import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { homeBackingSize, HOME_TEXTURE_SIZE } = await vite.ssrLoadModule("/features/mochlik/home-art.ts");
const { drawLanternLight, drawSceneShade, NIGHT_SHADE } = await vite.ssrLoadModule("/features/mochlik/lantern-light.ts");
const { drawLanternGlass } = await vite.ssrLoadModule("/features/mochlik/lantern-glass.ts");

test("circle uses the same full-resolution map without a separate home image", async () => {
  const { WORLD_ART } = await vite.ssrLoadModule("/features/world/art.ts");
  const { NEW_MAP_FOCUS, NEW_MAP_SIZE, NEW_MAP_SPAWN } = await vite.ssrLoadModule("/features/world/presentation.ts");
  const source = await sharp(`${root}/art/world/prototype/forest-ground.png`).metadata();
  const runtime = await sharp(`${root}/public${WORLD_ART.map.split("?")[0]}`).metadata();
  assert.equal(runtime.width, source.width); assert.equal(runtime.height, source.height);
  assert.equal(WORLD_ART.map, WORLD_ART.homeDetail);
  assert.equal(WORLD_ART.map, WORLD_ART.homePreview);
  const focus = NEW_MAP_FOCUS;
  assert.ok(focus.x >= 0 && focus.y >= 0 && focus.x + focus.width <= NEW_MAP_SIZE && focus.y + focus.height <= NEW_MAP_SIZE);
  assert.ok(NEW_MAP_SPAWN.x > focus.x && NEW_MAP_SPAWN.x < focus.x + focus.width);
  assert.ok(NEW_MAP_SPAWN.y > focus.y && NEW_MAP_SPAWN.y < focus.y + focus.height);
  assert.equal(homeBackingSize(320, 2), 640);
  assert.equal(homeBackingSize(280, 3), 840);
  assert.equal(homeBackingSize(900, 3), HOME_TEXTURE_SIZE);
  assert.equal(homeBackingSize(0, 2, true), HOME_TEXTURE_SIZE);
  assert.equal(homeBackingSize(NaN, NaN), 256);
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


test("daytime glass uses its sampled texture; dark night receives separate cool moonlight", () => {
  const fills = [];
  const glass = { texture: {}, scale: 4 }, panes = [];
  const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }),
    drawImage(image) { panes.push({ image, mode: this.globalCompositeOperation }); },
    fillRect() { fills.push({ mode: this.globalCompositeOperation, color: this.fillStyle }); } },
    { get: (object, key) => key in object ? object[key] : () => {} });
  drawLanternGlass(ctx, 1, glass); assert.equal(panes.length, 0);
  drawLanternGlass(ctx, 0, glass); assert.equal(fills.length, 0, "no painted spot covers the glass");
  assert.deepEqual(panes, [{ image: glass.texture, mode: "source-over" }]);
  fills.length = 0; drawSceneShade(ctx, 1, 0, 256);
  assert.ok(NIGHT_SHADE >= .5 && NIGHT_SHADE < .65, "night returns to a dark base with lit clearings");
  assert.equal(fills[0].color, `rgba(8,17,37,${NIGHT_SHADE})`);
  assert.ok(fills.some(fill => fill.mode === "screen"), "moonlight opens up the dark base");
});


test("the doorway clips only after the feet cross the threshold, in either direction", async () => {
  const { HOUSE_ANCHORS, isBehindDoorThreshold } = await vite.ssrLoadModule("/features/mochlik/home-layout.ts");
  const { inside, doorstep } = HOUSE_ANCHORS;
  assert.equal(isBehindDoorThreshold(doorstep), false);
  assert.equal(isBehindDoorThreshold({ y: (doorstep.y + inside.y) / 2 }), false);
  assert.equal(isBehindDoorThreshold(inside), true);
  for (let step = 0; step <= 100; step++) {
    const y = doorstep.y + (inside.y - doorstep.y) * step / 100;
    const reverseY = inside.y + (doorstep.y - inside.y) * (100 - step) / 100;
    assert.equal(isBehindDoorThreshold({ y }), isBehindDoorThreshold({ y: reverseY }));
  }
});
