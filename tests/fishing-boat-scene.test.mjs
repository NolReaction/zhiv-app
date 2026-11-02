import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { browser, flush, modules, options } from "./helpers/new-map-scene.mjs";

test("mounted circle and map retain one voyage, a reopening marker and a single returning hero", async () => {
  const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  // Preserve actual shore/water/collision geometry. Other residents/artwork
  // are deliberately absent so a hero draw count is unambiguous.
  const { mountHabitat, connectForestSession, TILED_WORLD, previewWorldScene, builderSpriteRig } = await modules({
    actor: authored.actor, navigation: authored.navigation, water: authored.water,
  });
  const env = browser(), circleSurface = env.surface(), worldSurface = env.surface(), scenes = [];
  const date = value => new Date(value).toISOString(), start = 1_000_000;
  const boat = { level: 1, upgrades: ["oars"], artifacts: ["landing_net"], voyage: { id: "mounted-boat",
    departedAt: date(start), arrivesAt: date(start + 120_000), fishingUntil: date(start + 600_000), inboundSeconds: 120 } };
  const initial = { ...options, serverNow: start + 150_000, presenceKey: "mounted-fishing-camera", economyBoatFishing: boat };
  const callbacks = { activity() {}, ready() {}, failure: assert.fail };
  const heroCount = scene => {
    const surface = env.surface(); scene.paintWorld(surface.context);
    return surface.calls.filter(call => call.method === "drawImage" && call.args[0]?.width === 48 && call.args[0]?.height === 48
      && !builderSpriteRig(call.args[0])).length;
  };
  let probe;
  try {
    const circle = mountHabitat(circleSurface, initial, callbacks); scenes.push(circle);
    env.finishPath("/test-ground.webp"); await flush();
    const world = mountHabitat(worldSurface, { ...initial, view: "world" }, callbacks); scenes.push(world);
    await flush();
    probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, {}), "circle", start, 0, () => {}, { persistence: false, sync: false });
    const shared = probe.state.boatTravel; assert.equal(shared?.phase, "away");
    assert.equal(heroCount(circle), 0); assert.equal(heroCount(world), 0);
    const marker = world.mapObjects().find(object => object.place === "fishing-boat"); assert.ok(marker);
    assert.equal(circle.mapObjects().find(object => object.place === "fishing-boat"), marker);
    world.configure({ ...initial, view: "world", economyBoatFishing: null });
    assert.equal(probe.state.boatTravel, shared); assert.equal(shared.phase, "away");
    world.configure({ ...initial, view: "world", serverNow: start + 710_000 });
    assert.equal(heroCount(world), 1, "returning boat carries one passenger, with no duplicate on land");
    world.configure({ ...initial, view: "world", serverNow: start + 720_000 });
    assert.equal(probe.state.boatTravel, shared); assert.equal(shared.phase, "complete");
    assert.equal(heroCount(circle), 1); assert.equal(heroCount(world), 1);
    assert.equal(world.mapObjects().filter(object => object.place === "fishing-boat").length, 1);
    assert.equal(env.frames.size, 0, "reduced motion introduces no boat RAF loop");
    world.dispose(); circle.configure({ ...initial, serverNow: start + 720_000, economyBoatFishing: { ...boat, voyage: undefined } });
    assert.equal(probe.state.boatTravel, undefined); assert.equal(heroCount(circle), 1);
  } finally { probe?.release(); scenes.forEach(scene => scene.dispose()); env.restore(); }
});
