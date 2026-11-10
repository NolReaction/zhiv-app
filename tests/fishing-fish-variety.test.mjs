import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingSceneFishAppearance, fishingSceneClassShapes, fishingSceneFishMotion, paintSceneFish } =
  await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-fish.ts");
const classes = ["common", "uncommon", "rare", "epic", "legendary"];

test("five public classes have distinct generic outlines without exposing an injected species or weight", () => {
  const outlines = classes.map(fishRarity => fishingSceneClassShapes(fishRarity, .3, "saved-cast"));
  assert.equal(new Set(outlines.map(shapes => JSON.stringify(shapes))).size, 5);
  const silhouettes = classes.map(fishRarity => fishingSceneFishAppearance({ stage: "reeling", fishRarity, fishId: "fish_shark", fishSizeScale: 1.3 }));
  assert.equal(new Set(silhouettes.map(value => value.silhouette)).size, 5);
  for (const appearance of silhouettes) {
    assert.equal(appearance.species, "fish"); assert.equal(appearance.revealed, false); assert.equal(appearance.sizeScale, 1);
  }
  for (const shapes of outlines) for (const shape of shapes) {
    if (shape.kind === "ellipse") assert.ok([shape.x, shape.y, shape.rx, shape.ry].every(Number.isFinite));
    else assert.ok(shape.points.flat().every(Number.isFinite));
  }
});

test("one accepted cast retains its silhouette through frames and resume, while other casts can vary within class", () => {
  const saved = fishingSceneClassShapes("rare", 0, "saved-cast");
  assert.deepEqual(fishingSceneClassShapes("rare", 0, "saved-cast"), saved);
  const variants = new Set(Array.from({ length: 12 }, (_, index) => JSON.stringify(fishingSceneClassShapes("rare", 0, `cast-${index}`))));
  assert.equal(variants.size, 3);
  assert.deepEqual(fishingSceneClassShapes("rare", Number.NaN, "saved-cast"), saved);
});

test("only a confirmed exact species scales with its actual size, with bounded safe fallbacks", () => {
  const base = { stage: "landed", fishRarity: "rare", fishId: "fish_mooncarp" };
  const small = fishingSceneFishAppearance({ ...base, fishSizeScale: .78 });
  const trophy = fishingSceneFishAppearance({ ...base, fishSizeScale: 1.3 });
  assert.equal(small.species, trophy.species); assert.equal(small.species, "fish_mooncarp");
  assert.ok(trophy.size > small.size * 1.6);
  assert.equal(fishingSceneFishAppearance({ ...base, fishSizeScale: 100 }).size, trophy.size);
  assert.equal(fishingSceneFishAppearance({ ...base, fishSizeScale: -10 }).size, small.size);
  assert.equal(fishingSceneFishAppearance({ ...base, fishSizeScale: Number.NaN }).sizeScale, 1);
  assert.equal(fishingSceneFishAppearance({ ...base, stage: "caught", fishSizeScale: 1.3 }).sizeScale, 1);
  assert.equal(fishingSceneFishAppearance({ stage: "landed", fishSizeScale: 1.3 }).revealed, false);
});

test("class motion differs decoratively, settles after landing, and stays still under reduced motion", () => {
  const motions = classes.map(rarity => fishingSceneFishMotion("reeling", 1.23, false, 1, rarity));
  assert.equal(new Set(motions.map(value => JSON.stringify(value))).size, 5);
  for (const rarity of classes) {
    const still = fishingSceneFishMotion("reeling", 1, true, 1, rarity);
    assert.deepEqual(still, fishingSceneFishMotion("reeling", 100, true, 100, rarity));
    assert.equal(still.tail, 0);
    assert.deepEqual(fishingSceneFishMotion("landed", 3, false, 2, rarity), fishingSceneFishMotion("landed", 30, false, 30, rarity));
  }
});

test("painting each class and size retains the exact game target and never mutates the confirmed input", () => {
  const calls = [], ctx = new Proxy({ globalAlpha: 1 }, { get(value, key) { return key in value ? value[key] : (...args) => calls.push({ key, args }); } });
  for (const fishRarity of classes) for (const stage of ["reeling", "landed"]) {
    const frame = { stage, fishRarity, fishId: "fish_mooncarp", fishSizeScale: 1.3, castKey: "saved-cast", held: true, boat: { repaired: true, upgrades: [] } };
    const point = { x: 420, y: 260 }, original = structuredClone({ frame, point });
    calls.length = 0; paintSceneFish(ctx, point, frame, 1.23, false, 1);
    assert.deepEqual({ frame, point }, original);
    assert.deepEqual(calls.find(call => call.key === "translate").args, [420, 260]);
  }
});
