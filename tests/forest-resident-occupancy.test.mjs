import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD: scene } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { createClearingActivity } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { createBuilderMind, advanceBuilderMind } = await vite.ssrLoadModule("/features/world/builder-mind.ts");
const { createPleskMind } = await vite.ssrLoadModule("/features/world/plesk-mind.ts");
const { forestResidentOccupants } = await vite.ssrLoadModule("/features/world/forest-resident-occupancy.ts");
function state() {
  return { clearing: createClearingActivity(scene), builderMind: createBuilderMind(scene, { awaitConstruction: true }),
    pleskMind: createPleskMind(scene) };
}
const occupants = (state, options = {}) => forestResidentOccupants(state, scene, { heroVisible: true, ...options });

test("sleeping, absent, underground and not-yet-confirmed residents do not leave invisible roadblocks", () => {
  const current = state();
  assert.equal(occupants(current).some(person => person.id === "builder"), false);
  assert.equal(occupants(current).some(person => person.id === "mochlik"), true);
  assert.equal(occupants(current, { heroVisible: false }).some(person => person.id === "mochlik"), false);
  current.clearing.stage = "home-sleep";
  assert.equal(occupants(current).some(person => person.id === "mochlik"), false);
  current.clearing.stage = "home";
  assert.equal(occupants(current, { mining: { x: 10, y: 20, opacity: 0, pose: "idle" } }).some(person => person.id === "mochlik"), false);
  current.builderMind.constructionPending = false;
  assert.equal(occupants(current).some(person => person.id === "builder"), true);
});

test("fixed fishing, cooking and doorway crossings reserve their actual visible ground position", () => {
  const current = state(); current.clearing.stage = "free-walk";
  for (const override of [
    { fishing: { x: 140, y: 160, action: "pack" } },
    { cooking: { x: 180, y: 200, action: "stir" } },
    { mining: { x: 220, y: 240, opacity: .5, pose: "walk" } },
  ]) {
    current.journeyTravel = { phase: "entering" };
    const hero = occupants(current, override).find(person => person.id === "mochlik"), frame = Object.values(override)[0];
    assert.deepEqual(hero.position, { x: frame.x, y: frame.y });
    assert.equal(hero.moving, false, "a fixed action cannot be displaced to settle walking priority");
  }
  current.clearing.stage = "entering"; current.clearing.doorProgress = .5;
  assert.equal(occupants(current).find(person => person.id === "mochlik").moving, false);
});

test("a sleeping builder releases the path and reserves it again as he leaves the doorway", () => {
  const current = state(); current.builderMind.constructionPending = false;
  const mind = current.builderMind, environment = { now: 1, night: true };
  for (let frame = 0; frame < 1000 && mind.sleepPhase !== "sleep"; frame++) advanceBuilderMind(mind, scene, .1, environment);
  assert.equal(mind.sleepPhase, "sleep");
  assert.equal(occupants(current).some(person => person.id === "builder"), false);
  advanceBuilderMind(mind, scene, 0, { ...environment, night: false });
  assert.equal(occupants(current).some(person => person.id === "builder"), false, "still fully indoors at exit start");
  advanceBuilderMind(mind, scene, .2, { ...environment, night: false });
  const visible = occupants(current).find(person => person.id === "builder");
  assert.ok(visible, "visible doorway crossing has a ground reservation");
  assert.deepEqual(visible.position, mind.position);
});

test("occupancy is detached and resampled from committed feet without becoming a second simulation owner", () => {
  const current = state(); current.clearing.stage = "free-walk";
  const elapsed = current.clearing.elapsed, first = occupants(current, { heroScale: 1.2 });
  const hero = first.find(person => person.id === "mochlik");
  assert.equal(hero.size, current.clearing.size * 1.2); assert.equal(hero.moving, true);
  hero.position.x += 100;
  assert.notEqual(hero.position.x, current.clearing.position.x);
  current.clearing.position.x += 5;
  assert.equal(occupants(current).find(person => person.id === "mochlik").position.x, current.clearing.position.x);
  assert.equal(current.clearing.elapsed, elapsed);
});
