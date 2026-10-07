import assert from "node:assert/strict";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { compileWorldInteractions, findInteractionApproach, WORLD_INTERACTION_LIMITS } = await vite.ssrLoadModule("/features/world/interaction-navigation.ts");
const { createWorldNavigation, canTraverse, isWalkable, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const scene = () => ({ ...withPlacedBushArtwork(TILED_WORLD), paths: [] });

test("real map markers work without Routes, including the doorway outside WalkAreas", () => {
  const map = scene(), nav = createWorldNavigation(map), compiled = compileWorldInteractions(map);
  assert.equal(compileWorldInteractions(map), compiled, "local corridors compile once per scene");
  assert.ok(compiled.home); assert.equal(compiled.bushes.length, 1);
  assert.ok(compiled.diagnostics.every(item => item.valid), JSON.stringify(compiled.diagnostics));
  const home = compiled.home;
  assert.equal(isWalkable(nav, home.entry), false, "regression: authored entry needs its short threshold connector");
  assert.equal(isWalkable(nav, home.dock), true);
  assert.ok(distance(home.entry, home.dock) > 0 && distance(home.entry, home.dock) <= WORLD_INTERACTION_LIMITS.homeDock);
  for (const interaction of [home, ...compiled.bushes]) {
    const approach = findInteractionApproach(nav, map.actor.spawn, interaction);
    assert.ok(approach); assert.deepEqual(approach.points[0], map.actor.spawn);
    assert.deepEqual(approach.points.at(-1), interaction.entry);
    assert.deepEqual(approach.departure[0], interaction.entry);
    assert.deepEqual(approach.departure.at(-1), interaction.dock);
    const dockIndex = approach.points.findIndex(point => distance(point, interaction.dock) < .00001);
    for (let i = 1; i <= dockIndex; i++) assert.ok(canTraverse(nav, approach.points[i - 1], approach.points[i]));
  }
  assert.equal(isWalkable(nav, home.entry), false, "special permission must not alter shared navigation");
});

test("door thresholds do not grant permission to cross water, obstacles or other buildings", () => {
  for (const kind of ["water", "obstacle", "building"]) {
    const map = scene(), { entry, doorway } = map.sites.find(site => site.id === "home");
    const points = rect((entry.x + doorway.x) / 2 - 1, (entry.y + doorway.y) / 2 - 1, 2, 2);
    if (kind === "water") map.water.surfaces.push({ id: "blocked-threshold", points });
    if (kind === "obstacle") map.navigation.obstacles.push({ id: "blocked-threshold", points });
    if (kind === "building") map.sites.push({ ...structuredClone(map.sites[0]), id: "other", collision: points });
    const compiled = compileWorldInteractions(map);
    assert.equal(compiled.home, null, kind);
    assert.equal(compiled.diagnostics.find(item => item.id === "home").reason, "blocked-doorway");
  }
});

test("an unreachable entry is rejected rather than snapped across the house", () => {
  const map = scene(), home = map.sites.find(site => site.id === "home");
  home.entry = { ...home.doorway };
  const compiled = compileWorldInteractions(map);
  assert.equal(compiled.home, null);
  assert.equal(compiled.diagnostics.find(item => item.id === "home").reason, "unreachable-door-entry");
});

test("bush jumps reject every hard blocker and require a safe standing point", () => {
  for (const kind of ["water", "obstacle", "building", "entry"]) {
    const map = scene(), bush = map.bushes[0];
    const points = rect((bush.entry.x + bush.hide.x) / 2 - 1, (bush.entry.y + bush.hide.y) / 2 - 1, 2, 2);
    if (kind === "water") map.water.surfaces.push({ id: "bush-water", points });
    if (kind === "obstacle") map.navigation.obstacles.push({ id: "bush-rock", points });
    if (kind === "building") map.sites.push({ ...structuredClone(map.sites[0]), id: "other", collision: points });
    if (kind === "entry") map.navigation.obstacles.push({ id: "bush-entry-rock", points: rect(bush.entry.x - 1, bush.entry.y - 1, 2, 2) });
    const compiled = compileWorldInteractions(map);
    assert.equal(compiled.bushes.length, 0, kind);
    assert.ok(compiled.diagnostics.find(item => item.id === bush.id).reason);
  }
});

test("disconnected grass cannot reach otherwise valid interactions", () => {
  const map = scene();
  map.navigation.areas.push({ id: "isolated", points: rect(20, 20, 40, 40) });
  const nav = createWorldNavigation(map), compiled = compileWorldInteractions(map), start = { x: 40, y: 40 };
  assert.equal(isWalkable(nav, start), true);
  assert.equal(findInteractionApproach(nav, start, compiled.home), null);
  assert.equal(findInteractionApproach(nav, start, compiled.bushes[0]), null);
});

test("all five authored homes retain reachable entrances when the actor changes from size 56 to 50", () => {
  for (const size of [50, 56]) for (const level of [1, 2, 3, 4, 5]) {
    const map = structuredClone(previewWorldScene(TILED_WORLD, { home: level }));
    map.actor.size = size;
    const nav = createWorldNavigation(map);
    const { home, diagnostics } = compileWorldInteractions(map);
    assert.ok(home, `size ${size}, level ${level}: ${JSON.stringify(diagnostics)}`);
    const origins = [map.actor.spawn, ...map.navigation.interests.map(interest => interest.position)];
    // Include both sides of the accessible clearing and positions near its rocks.
    // Authored props can leave isolated walkable pockets which the actor cannot enter.
    for (let id = 0; id < nav.grid.walkable.length; id += 7) {
      if (!nav.grid.walkable[id]) continue;
      const origin = { x: nav.grid.origin.x + id % nav.grid.columns * nav.cellSize,
        y: nav.grid.origin.y + Math.floor(id / nav.grid.columns) * nav.cellSize };
      if (findWorldPath(nav, map.actor.spawn, origin)) origins.push(origin);
      else {
        assert.equal(findInteractionApproach(nav, origin, home), null, "the doorway must not connect isolated ground");
        assert.equal(findWorldPath(nav, home.dock, origin), null, "departure must not cross blockers into an isolated pocket");
      }
    }
    for (const origin of origins) {
      const approach = findInteractionApproach(nav, origin, home);
      assert.ok(approach, `level ${level}, from ${JSON.stringify(origin)}: ${nav.stats.lastSearch?.reason}`);
      assert.deepEqual(approach.points.at(-1), home.entry);
      const dockIndex = approach.points.findIndex(point => distance(point, home.dock) < 1e-7);
      assert.ok(dockIndex >= 0);
      for (let index = 1; index <= dockIndex; index++) assert.ok(canTraverse(nav, approach.points[index - 1], approach.points[index]));
      const departure = findWorldPath(nav, home.dock, origin);
      assert.ok(departure, `level ${level} must leave its own porch`);
      for (let index = 1; index < departure.length; index++) assert.ok(canTraverse(nav, departure[index - 1], departure[index]));
    }
  }
});

test("smaller sprites preserve authored bush jumps while larger sprites retain their full clearance", () => {
  for (const size of [24, 50, 56]) {
    const map = scene(); map.actor.size = size;
    const nav = createWorldNavigation(map), compiled = compileWorldInteractions(map);
    assert.equal(nav.radius, size * .1);
    assert.ok(compiled.bushes.length, `size ${size}: ${JSON.stringify(compiled.diagnostics)}`);
    assert.ok(findInteractionApproach(nav, map.actor.spawn, compiled.bushes[0]));
  }
  const map = scene(), entry = map.bushes[0].entry;
  // The obstacle sits six units from the standing point: a small support fits,
  // but an eight-unit support cannot use the same approach.
  map.navigation.obstacles.push({ id: "close-to-entry", points: rect(entry.x + 6, entry.y - 1, 1, 2) });
  map.actor.size = 24;
  assert.equal(isWalkable(createWorldNavigation(map), entry), true);
  const enlarged = structuredClone(map); enlarged.actor.size = 80;
  assert.equal(isWalkable(createWorldNavigation(enlarged), entry), false);
  assert.equal(compileWorldInteractions(enlarged).diagnostics.find(item => item.id === "clearing-bush").reason, "unreachable-bush-entry");
});

test("authored transition lengths stay bounded in world units regardless of actor size", () => {
  for (const size of [24, 50, 56, 80]) {
    const map = scene(); map.actor.size = size;
    const home = map.sites.find(site => site.id === "home");
    home.doorway = { x: home.entry.x, y: home.entry.y - WORLD_INTERACTION_LIMITS.homeThreshold - .01 };
    assert.equal(compileWorldInteractions(map).diagnostics.find(item => item.id === "home").reason, "invalid-doorway");
    const bushMap = scene(); bushMap.actor.size = size;
    const bush = bushMap.bushes[0];
    bush.hide = { x: bush.entry.x - WORLD_INTERACTION_LIMITS.bushJump - .01, y: bush.entry.y };
    bush.points = rect(bush.hide.x - 1, bush.hide.y - 1, 2, 2);
    assert.equal(compileWorldInteractions(bushMap).diagnostics.find(item => item.id === "clearing-bush").reason, "invalid-bush-corridor");
  }
});
