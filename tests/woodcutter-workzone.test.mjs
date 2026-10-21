import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { initialPreviewLevels, previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { forestVillagerPlaces } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-navigation.ts");
const { woodcutterSafeDrop } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-navigation.ts");
const { beginWoodcutterCycle } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-cycle.ts");
const { createForestVillagers, configureForestVillagers, advanceForestVillagers, rehydrateForestVillagers } =
  await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const now = Date.parse("2026-10-18T18:00:00Z"), size = 44;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const marked = id => /^(lopukh-work|lopukh-delivery|lopukh-rest)(-|$)/.test(id);
function authoredPosition(scene, id) {
  const marker = scene.destinations.find(stop => stop.id === id);
  assert.ok(marker, `missing authored marker: ${id}`);
  return { ...marker.position };
}
function sceneAt(level = 1) {
  return previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: 3, quarry: 1,
    woodlot: 1, "lopukh-home": level });
}
function setup(scene) {
  const state = createForestVillagers(scene);
  configureForestVillagers(state, scene, { confirmed: true, buildings: { home: 3, quarry: 1, woodlot: 1 },
    arrivalSeen: true, lopukhArrivalSeen: true, leaftailReady: true, now });
  for (const id of ["kamneshmyg", "leaftail"]) state.residents[id].available = false;
  return { state, rabbit: state.residents.lopukh, places: forestVillagerPlaces(scene, "lopukh") };
}
function advance(state, scene, until, occupants = [], seconds = 60) {
  const places = forestVillagerPlaces(scene, "lopukh");
  for (let tick = 0; tick < seconds / .05 && !until(); tick++) {
    const rabbit = state.residents.lopukh, previous = { ...rabbit.position };
    advanceForestVillagers(state, scene, .05, { now, occupants });
    assert.ok(canTraverse(places.navigation, previous, rabbit.position), "work routing keeps physical colliders");
    assert.ok(distance(previous, rabbit.position) <= 39 * .05 + 1e-6, "storage changes never teleport feet");
  }
  return until();
}

for (const level of [1, 2]) test(`Tiled home level ${level}: both work spots deliver two consecutive logs only to marked storage`, () => {
  const scene = sceneAt(level), before = structuredClone(scene), { state, rabbit, places } = setup(scene), plan = places.woodcutting;
  const storage = authoredPosition(scene, "lopukh-delivery");
  assert.deepEqual(plan.work.map(stop => stop.id), ["lopukh-work-tree-1", "lopukh-work-tree-2"]);
  assert.deepEqual(plan.delivery.map(stop => stop.id), ["lopukh-delivery"]);
  assert.deepEqual(plan.rest.map(stop => stop.id), ["lopukh-rest"]);
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.equal(beginWoodcutterCycle(rabbit, places, [], { chopSeconds: 0, workIndex: cycle }), true);
    assert.equal(rabbit.target.id, plan.work[cycle].id);
    assert.ok(advance(state, scene, () => rabbit.woodwork.completedCycles === cycle + 1));
    const log = rabbit.woodwork.lastDelivery;
    assert.equal(log.sequence, cycle + 1); assert.deepEqual(log.position, storage);
    for (const work of plan.work) assert.ok(distance(log.position, work.position) >= size * .6);
  }
  assert.deepEqual(rabbit.woodwork.deliveries.map(log => log.position), [storage, storage]);
  assert.deepEqual(scene, before, "the worker never writes into the authored map");
});

test("moving the authored work/storage/rest points changes actual walking and final log targets", () => {
  const scene = structuredClone(sceneAt());
  const work = authoredPosition(scene, "lopukh-work-tree-1"), storage = authoredPosition(scene, "lopukh-delivery"),
    rest = authoredPosition(scene, "lopukh-rest"), shifted = point => ({ x: point.x - 4, y: point.y + 3 });
  for (const marker of scene.destinations.filter(stop => marked(stop.id))) { marker.position.x -= 4; marker.position.y += 3; }
  const { state, rabbit, places } = setup(scene);
  assert.deepEqual(places.home.position, shifted(rest));
  assert.equal(beginWoodcutterCycle(rabbit, places, [], { chopSeconds: 0 }), true);
  assert.deepEqual(rabbit.target.position, shifted(work));
  assert.ok(advance(state, scene, () => rabbit.woodwork.completedCycles === 1));
  assert.deepEqual(rabbit.woodwork.lastDelivery.position, shifted(storage));
  assert.equal(woodcutterSafeDrop(scene, places.navigation, storage, size), false);
});

for (const prefix of ["lopukh-work", "lopukh-delivery", "lopukh-rest"]) {
  test(`an incomplete authored zone without ${prefix} fails closed instead of inventing a target`, () => {
    const scene = structuredClone(sceneAt()); scene.destinations = scene.destinations.filter(stop => !stop.id.startsWith(prefix));
    assert.equal(forestVillagerPlaces(scene, "lopukh"), null);
    const navigation = forestVillagerPlaces(sceneAt(), "lopukh").navigation;
    if (prefix === "lopukh-delivery") assert.equal(woodcutterSafeDrop(scene, navigation, { x: 947, y: 270 }, size), false);
  });
  for (const invalid of ["blocked", "non-finite"]) test(`${invalid} authored ${prefix} cannot fall back to the ordinary yard`, () => {
    const scene = structuredClone(sceneAt());
    for (const marker of scene.destinations.filter(stop => stop.id.startsWith(prefix))) marker.position = invalid === "blocked"
      ? { x: 900, y: 200 } : { x: NaN, y: 300 };
    assert.equal(forestVillagerPlaces(scene, "lopukh"), null);
  });
}

test("authored work inside the storage clearance is rejected", () => {
  const scene = structuredClone(sceneAt());
  const storage = authoredPosition(scene, "lopukh-delivery");
  for (const marker of scene.destinations.filter(stop => stop.id.startsWith("lopukh-work"))) marker.position = { x: storage.x + 2, y: storage.y };
  assert.equal(forestVillagerPlaces(scene, "lopukh"), null);
});

test("an occupied authored storage waits with carried wood rather than dumping it at the work spot", () => {
  const scene = sceneAt(), { state, rabbit, places } = setup(scene);
  const storage = authoredPosition(scene, "lopukh-delivery");
  assert.equal(beginWoodcutterCycle(rabbit, places, [], { chopSeconds: 0 }), true);
  assert.ok(advance(state, scene, () => rabbit.action === "work"));
  const workFeet = { ...rabbit.position }, blockers = [{ id: "storage-worker", position: { ...storage }, size: 44 }];
  advance(state, scene, () => false, blockers, 55);
  assert.equal(rabbit.woodwork.phase, "haul"); assert.equal(rabbit.action, "carry");
  assert.deepEqual(rabbit.position, workFeet); assert.equal(rabbit.woodwork.lastDelivery, undefined);
  assert.equal(woodcutterSafeDrop(scene, places.navigation, workFeet, size), false);
  assert.equal(woodcutterSafeDrop(scene, places.navigation, { x: storage.x + 3, y: storage.y }, size), true);
  assert.equal(woodcutterSafeDrop(scene, places.navigation, { x: storage.x + 3.01, y: storage.y }, size), false);
  assert.ok(advance(state, scene, () => rabbit.woodwork.completedCycles === 1), JSON.stringify({position:rabbit.position,action:rabbit.action,cycle:rabbit.woodwork,failed:rabbit.failedStops,goal:rabbit.goal,elapsed:rabbit.elapsed}));
  assert.deepEqual(rabbit.woodwork.lastDelivery.position, storage);
});

test("a legacy map with no work-zone markers retains its safe outdoor work and delivery compatibility", () => {
  const scene = structuredClone(sceneAt()); scene.destinations = scene.destinations.filter(stop => !marked(stop.id));
  const { places } = setup(scene);
  assert.ok(places?.woodcutting.work.length); assert.ok(places.woodcutting.delivery.length);
  assert.ok(places.woodcutting.delivery.every(stop => stop.id.startsWith("lopukh-delivery:")));
  assert.equal(woodcutterSafeDrop(scene, places.navigation, places.woodcutting.work[0].position, size), true);
});

test("refresh removes obsolete work-site logs without moving any surviving storage drop or prior owner's state", () => {
  const scene = sceneAt(), { state, rabbit } = setup(scene), oldWork = authoredPosition(scene, "lopukh-work-tree-1"),
    storage = authoredPosition(scene, "lopukh-delivery");
  rabbit.woodwork.lastDelivery = { position: oldWork, sequence: 2 };
  rabbit.woodwork.deliveries = [{ position: storage, sequence: 1 }, rabbit.woodwork.lastDelivery];
  const previous = structuredClone(state), next = rehydrateForestVillagers(structuredClone(scene), state, now), cycle = next.residents.lopukh.woodwork;
  assert.deepEqual(cycle.deliveries, [{ position: storage, sequence: 1 }]);
  assert.deepEqual(cycle.lastDelivery, cycle.deliveries[0]); assert.deepEqual(state, previous);
  cycle.deliveries[0].position.x += 1;
  assert.deepEqual(rabbit.woodwork.deliveries[0].position, storage);
});

test("moving storage during an unfinished unload keeps feet and the carried log until the new storage is reached", () => {
  const scene = sceneAt(), { state, rabbit, places } = setup(scene);
  beginWoodcutterCycle(rabbit, places, [], { chopSeconds: 0 });
  assert.ok(advance(state, scene, () => rabbit.action === "unload"));
  assert.equal(rabbit.woodwork.lastDelivery, undefined);
  const oldFeet = { ...rabbit.position }, edited = structuredClone(scene);
  const storage = authoredPosition(scene, "lopukh-delivery"), movedStorage = { x: storage.x, y: storage.y + 15 };
  edited.destinations.find(stop => stop.id === "lopukh-delivery").position = movedStorage;
  const next = rehydrateForestVillagers(edited, state, now), worker = next.residents.lopukh;
  assert.deepEqual(worker.position, oldFeet);
  advanceForestVillagers(next, edited, .05, { now });
  assert.equal(worker.woodwork.lastDelivery, undefined); assert.equal(worker.woodwork.phase, "haul");
  assert.ok(advance(next, edited, () => worker.woodwork.completedCycles === 1));
  assert.deepEqual(worker.woodwork.lastDelivery.position, movedStorage);
  assert.equal(isWalkable(forestVillagerPlaces(edited, "lopukh").navigation, worker.position), true);
});
