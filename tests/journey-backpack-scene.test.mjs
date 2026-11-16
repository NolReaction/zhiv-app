import assert from "node:assert/strict";
import test from "node:test";
import { browser, flush, modules, options } from "./helpers/new-map-scene.mjs";

test("the shared circle and full-map painter wear the pack only after a distant assignment exists", async () => {
  const { mountHabitat, pixelSprite } = await modules();
  const env = browser(), circle = env.surface(), world = env.surface();
  const now = 1_000_000;
  const latestBody = surface => surface.calls.filter(call => call.method === "drawImage"
    && call.args[0]?.width === 48 && call.args[0]?.height === 48).at(-1)?.args[0];
  const isPacked = sprite => ["idle", "walk", "blink"].some(pose =>
    ["front", "back", "left", "right"].some(direction => [0, 1, 2, 3].some(frame =>
      sprite === pixelSprite(pose, direction, frame, undefined, { backpack: true }))));
  let scene;
  try {
    scene = mountHabitat(circle, { ...options, serverNow: now, economyJourney: null }, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    assert(latestBody(circle)); assert.equal(isPacked(latestBody(circle)), false, "choosing a route without a saved job does not dress the hero");
    scene.configure({ ...options, serverNow: now, economyJourney: {
      id: "confirmed-backpack", routeId: "ancient_ruins", startedAt: new Date(now).toISOString(),
      finishesAt: new Date(now + 3_600_000).toISOString(), rewards: {},
    } });
    scene.paintWorld(world.context);
    assert.equal(isPacked(latestBody(circle)), true, "reduced-motion circle keeps the confirmed worn prop");
    assert.strictEqual(latestBody(world), latestBody(circle), "both cameras use the same pose and cached backpack sprite");
    assert.equal(env.frames.size, 0, "the new prop does not start its own animation loop");
  } finally { scene?.dispose(); env.restore(); }
});
