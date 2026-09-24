import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { compileWorldInteractions, findInteractionApproach } = await vite.ssrLoadModule("/features/world/interaction-navigation.ts");
const { createWorldNavigation, canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const scene = () => ({ ...structuredClone(TILED_WORLD), paths: [] });

test("real map markers work without Routes, including the doorway outside WalkAreas", () => {
  const map = scene(), nav = createWorldNavigation(map), compiled = compileWorldInteractions(map);
  assert.equal(compileWorldInteractions(map), compiled, "local corridors compile once per scene");
  assert.ok(compiled.home); assert.equal(compiled.bushes.length, 1);
  assert.ok(compiled.diagnostics.every(item => item.valid), JSON.stringify(compiled.diagnostics));
  const home = compiled.home;
  assert.equal(isWalkable(nav, home.entry), false, "regression: authored entry needs its short threshold connector");
  assert.equal(isWalkable(nav, home.dock), true);
  assert.ok(distance(home.entry, home.dock) > 0 && distance(home.entry, home.dock) <= map.actor.size * .24);
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
