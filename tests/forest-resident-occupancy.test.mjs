import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD: scene } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { createClearingActivity } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const { createBuilderMind, advanceBuilderMind } = await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { createPleskMind } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { forestResidentOccupants } = await vite.ssrLoadModule("/features/world/characters/forest-resident-occupancy.ts");
const { createForestGarden } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden.ts");
const { forestGardenVisualFrame, forestGardenGroundBasket } = await vite.ssrLoadModule("/features/world/activities/garden/forest-garden-painter.ts");
const { basketGroundFootprint } = await vite.ssrLoadModule("/features/world/navigation/ground-props.ts");
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

test("parked and active grounded baskets publish the exact visual support, carried props release it", () => {
  const current = state(), garden = createForestGarden(scene);
  garden.basket = { position: { x: 100, y: 120 }, approach: { x: 80, y: 120 }, homePosition: { x: 100, y: 120 },
    homeApproach: { x: 80, y: 120 }, size: 14, berries: 0, capacity: 12 };
  current.life = { garden };
  const parked = occupants(current, { heroVisible: false }).find(prop => prop.id === "garden-basket");
  assert.deepEqual(parked.position, garden.basket.position, "a parked prop remains after its owner disappears");
  parked.groundFootprint[0].x += 100;
  assert.notEqual(occupants(current).find(prop => prop.id === "garden-basket").groundFootprint[0].x, parked.groundFootprint[0].x);
  const body = current.clearing;
  garden.routine = { kind: "harvest-berries", bushId: "", phase: "collect", elapsed: 2, totalElapsed: 2, carryingBasket: true };
  const frame = forestGardenVisualFrame(garden, { ...body.position, size: body.size }, { pose: "idle", frame: 0, direction: "front" }, true);
  const grounded = forestGardenGroundBasket(garden, body.size, frame), active = occupants(current).find(prop => prop.id === "garden-basket");
  assert.deepEqual(active.position, { x: grounded.x, y: grounded.y });
  assert.notDeepEqual(active.position, garden.basket.position, "collect uses the lowered basket, not its stale home marker");
  assert.deepEqual(active.groundFootprint, basketGroundFootprint(grounded, grounded.size));
  garden.routine.elapsed = 4.5;
  assert.equal(occupants(current).some(prop => prop.id === "garden-basket"), false, "lifting stops reserving ground at once");
  garden.routine = null; garden.basket.held = true;
  assert.equal(occupants(current).some(prop => prop.id === "garden-basket"), false);
  const gathering = { held: false, basket: { x: 230, y: 250, size: 16 } };
  assert.deepEqual(occupants(current, { gathering }).find(prop => prop.id === "supply-basket").groundFootprint,
    basketGroundFootprint(gathering.basket, 16));
  gathering.held = true;
  assert.equal(occupants(current, { gathering }).some(prop => prop.id === "supply-basket"), false);
});
