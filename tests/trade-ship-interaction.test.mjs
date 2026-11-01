import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import sharp from "sharp";
import { browser, finishVillagerArtwork, flush, modules, options, quietClearing, sendWaterPointer, waterPointer } from "./helpers/new-map-scene.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createTradeShipMapObject, tradeShipCanInteract, tradeShipSourceToWorld } = await vite.ssrLoadModule("/features/world/scene/trade-ship-interaction.ts");
const { TRADE_SHIP_SPRITE: sprite, applyTradeShipSpriteTransform } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-sprite.ts");
const { sampleTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { mapObjectAt } = await vite.ssrLoadModule("/features/world/scene/site-interactions.ts");
const { data: pixels, info: png } = await sharp(root + "/public" + sprite.src.split("?")[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const alpha = point => pixels[(point.y * png.width + point.x) * 4 + 3];

test("port touch geometry follows the painter's mirror, rotation, native image inset and bob", () => {
  for (const facing of ["left", "right"]) for (const heading of [-.6, 0, .28]) for (const still of [false, true]) {
    const frame = { ...sampleTradeShipMotion("docked", 0), facing, heading, still, time: 1.17 };
    const operations = [];
    applyTradeShipSpriteTransform({
      translate: (x, y) => operations.push(([a, b]) => [a + x, b + y]),
      scale: (x, y) => operations.push(([a, b]) => [a * x, b * y]),
      rotate: angle => operations.push(([a, b]) => [a * Math.cos(angle) - b * Math.sin(angle), a * Math.sin(angle) + b * Math.cos(angle)]),
    }, frame);
    const projected = source => {
      const point = [sprite.image.x + source.x * sprite.image.width / sprite.sourceWidth,
        sprite.image.y + source.y * sprite.image.height / sprite.sourceHeight];
      const [x, y] = [...operations].reverse().reduce((point, operation) => operation(point), point);
      return { x, y };
    };
    const object = createTradeShipMapObject(frame, () => frame);
    for (const source of [{ x: 1100, y: 520 }, { x: 380, y: 340 }, { x: 590, y: 180 }]) {
      assert.ok(alpha(source) > 64, "the actual supplied PNG has a visible deck, cabin or chimney here");
      const actual = projected(source), expected = tradeShipSourceToWorld(source, frame);
      assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-9);
      assert.equal(mapObjectAt([object], actual)?.place, "trade-ship");
    }
    for (const source of [{ x: 0, y: 0 }, { x: 1773, y: 886 }, { x: 1100, y: 120 }, { x: 1450, y: 350 }]) {
      assert.ok(alpha(source) < 64, "these are transparent parts of the supplied PNG");
      assert.equal(mapObjectAt([object], projected(source)), null, "transparent corners and crane opening are not the port");
    }
  }
});

test("only a shown production ship with a fully deployed gangway can expose port controls", () => {
  const ship = { kind: "arrival", pending: false, voyageId: "owner", motion: sampleTradeShipMotion("docked", 0) };
  const access = { imageReady: true, view: "world" };
  assert.equal(tradeShipCanInteract(ship, access), true);
  for (const patch of [{ readOnly: true }, { devRehearsal: true }, { imageReady: false }, { view: "circle" }])
    assert.equal(tradeShipCanInteract(ship, { ...access, ...patch }), false);
  for (const patch of [{ kind: "dev" }, { pending: true }, { motion: { ...ship.motion, visible: false } },
    { motion: { ...ship.motion, gangway: .5 } }, ...["arriving", "deploying", "retracting", "departing", "departed"].map(phase => ({ motion: sampleTradeShipMotion(phase, 0) }))])
    assert.equal(tradeShipCanInteract({ ...ship, ...patch }, access), false);
  assert.equal(tradeShipCanInteract(null, access), false);
});

test("real map taps and keyboard activation open the port after arrival; guests and DEV cannot activate it", async () => {
  const { createMapEngine, forgetForestSession, worldDevStore } = await modules();
  const env = browser(), owner = "ship-port-interaction", key = `zhiv:mochlik:presence:${owner}`, opened = [];
  const authority = { ownerPublicId: owner, revision: 1, buildings: { lighthouse: 1 }, production: { ownerPublicId: owner, revision: 1, jobs: [] } };
  const initial = { ...options, reducedMotion: true, serverNow: 100_000, presenceKey: key, economyResidents: authority, tradeShipArrivalEnabled: false };
  let engine;
  try {
    worldDevStore.reset(); worldDevStore.patch(quietClearing);
    const canvas = env.surface(390, 844);
    const loading = createMapEngine(canvas, initial, place => opened.push(place), []);
    await finishVillagerArtwork(env); engine = await loading;
    assert.equal(engine.activateObject("trade-ship"), false, "pending introduction is not interactive");
    engine.update({ ...initial, tradeShipArrivalEnabled: true }); await flush();
    assert.equal(engine.activateObject("trade-ship"), true, "keyboard uses the same current object");
    const point = tradeShipSourceToWorld({ x: 1100, y: 520 }, { ...sampleTradeShipMotion("docked", 0), still: true });
    const tap = waterPointer(canvas, point);
    sendWaterPointer(canvas, "pointerdown", tap); sendWaterPointer(canvas, "pointerup", tap);
    assert.deepEqual(opened, ["trade-ship", "trade-ship"]);
    worldDevStore.triggerTradeShip("arrive");
    assert.equal(engine.activateObject("trade-ship"), false, "preview cannot stand in for the player's port");
    worldDevStore.patch({ tradeShipPreview: false });
    engine.update({ ...initial, readOnly: true, tradeShipArrivalEnabled: true });
    assert.equal(engine.activateObject("trade-ship"), false);
    sendWaterPointer(canvas, "pointerdown", tap); sendWaterPointer(canvas, "pointerup", tap);
    assert.equal(opened.length, 2, "read-only pointer taps never dispatch a port action");
  } finally { engine?.dispose(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
