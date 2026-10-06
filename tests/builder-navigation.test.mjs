import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { builderLocalPlaces, builderWorkStops, builderWorkClearance, builderRoute, BUILDER_NAVIGATION_LIMITS } =
  await vite.ssrLoadModule("/features/world/builder-navigation.ts");
const { isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const job = (stationId, targetLevel = 2) => ({ id: `${stationId}-${targetLevel}`, stationId, targetLevel,
  startedAt: "2026-10-06T12:00:00Z", finishesAt: "2026-10-06T13:00:00Z" });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function distanceToSegment(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(point, { x: a.x + dx * t, y: a.y + dy * t });
}
function assertClear(point, points, clearance, label) {
  assert.ok(distance(point, points[0]) >= clearance - 1e-6, `${label}: occupied point stays free`);
  for (let i = 1; i < points.length; i++)
    assert.ok(distanceToSegment(point, points[i - 1], points[i]) >= clearance - 1e-6, `${label}: approach stays free`);
}
function checkedRoute(scene, order) {
  const places = builderLocalPlaces(scene), stops = builderWorkStops(scene, order);
  const route = builderRoute(places, places.rest.position, stops);
  assert.ok(route, `${order.stationId} has a reachable side stop`);
  assert.ok(stops.length <= BUILDER_NAVIGATION_LIMITS.workCandidates);
  assert.ok(isWalkable(places.navigation, route.target.position));
  for (let i = 1; i < route.path.points.length; i++)
    assert.ok(canTraverse(places.navigation, route.path.points[i - 1], route.path.points[i]), "approach avoids static collisions");
  return { stops, route };
}
function fixture(size = 50) {
  const geometry = { bounds: { x: 200, y: 100, width: 100, height: 120 }, anchor: { x: 250, y: 170 },
    entry: { x: 250, y: 230 }, doorway: { x: 250, y: 210 }, hitArea: rect(200, 100, 100, 120), collision: rect(215, 110, 70, 85) };
  return { schemaVersion: 1, id: "builder-access", width: 500, height: 450, terrain: [],
    focus: { x: 0, y: 0, width: 500, height: 450 }, actor: { spawn: { x: 250, y: 365 }, size },
    sites: [{ id: "home", label: "Дом", initialLevel: 1, ...geometry,
      states: [{ level: 1, label: "Дом", image: "/home.webp" },
        { level: 2, label: "Дом 2", image: "/home2.webp", geometry: structuredClone(geometry) }] }],
    paths: [{ id: "home-approach", siteId: "home", behavior: "home",
      points: [{ x: 250, y: 365 }, { x: 250, y: 230 }] }], destinations: [],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "land", points: rect(0, 0, 500, 450) }], obstacles: [], interests: [] } };
}

test("all five actual houses and their interior upgrades leave Mochlik's doorway and complete home approach free", () => {
  const initial = initialPreviewLevels(TILED_WORLD);
  for (const level of [1, 2, 3, 4, 5]) {
    const levels = { ...initial, home: level }, scene = previewWorldScene(TILED_WORLD, levels);
    const home = scene.sites.find(site => site.id === "home"), clearance = (40 + scene.actor.size) / 2;
    assert.equal(builderWorkClearance(scene), clearance);
    for (const stationId of ["home", "warehouse"]) {
      const targetLevel = Math.min(5, level + 1), { stops, route } = checkedRoute(scene, job(stationId, targetLevel));
      const next = previewWorldScene(TILED_WORLD, { ...levels, home: stationId === "home" ? targetLevel : level });
      const nextHome = next.sites.find(site => site.id === "home");
      for (const { position } of stops) {
        assertClear(position, [scene.actor.spawn, home.entry, home.doorway], clearance, `${stationId} level ${level}`);
        for (const path of scene.paths.filter(path => path.siteId === "home" && path.behavior === "home"))
          assertClear(position, [...path.points, home.entry], clearance, `${stationId} authored approach`);
        assertClear(position, [scene.actor.spawn, nextHome.entry, nextHome.doorway], clearance, `${stationId} upgraded entrance`);
        for (const fire of scene.campfires) assertClear(position, [fire.seat], clearance, "nearby cooking seat");
        for (const bush of scene.bushes) {
          assertClear(position, [bush.entry], clearance, "nearby berry gathering");
          assertClear(position, [bush.hide], clearance, "nearby hiding place");
        }
      }
      assert.ok(isWalkable(builderLocalPlaces(next).navigation, route.target.position), "finished art preserves the selected working feet");
      const selectedDistance = distance(route.target.position, home.entry);
      assert.ok(stops.every(stop => selectedDistance <= distance(stop.position, home.entry) + 1e-6), "the nearest safe side is preferred");
      for (const bush of scene.bushes) {
        const bounds = scene.terrain.find(terrain => terrain.id === bush.imageId)?.bounds;
        if (bounds) assert.ok(route.target.position.x + 20 <= bounds.x || route.target.position.x - 20 >= bounds.x + bounds.width
          || route.target.position.y <= bounds.y || route.target.position.y - 37.5 >= bounds.y + bounds.height,
        "an active hiding bush cannot redraw over the working builder");
      }
    }
  }
});

test("actual selected stops leave each of the eight hosts' interaction points free and remain reachable", () => {
  const scene = previewWorldScene(TILED_WORLD, initialPreviewLevels(TILED_WORLD)), clearance = builderWorkClearance(scene);
  const hosts = { home: "home", warehouse: "home", workshop: "workshop", kiln: "workshop", woodlot: "woodlot", quarry: "quarry" };
  for (const stationId of [...Object.keys(hosts), "garden", "dryer"]) {
    const { route } = checkedRoute(scene, job(stationId)), point = route.target.position;
    for (const destination of scene.destinations) assertClear(point, [destination.position], clearance, `${stationId} leaves fixed destination free`);
    if (hosts[stationId]) {
      const site = scene.sites.find(site => site.id === hosts[stationId]);
      assertClear(point, [site.entry, site.doorway ?? site.entry], clearance, stationId);
      const destination = scene.destinations.find(destination => destination.id === site.id && destination.siteId === site.id);
      if (destination) assertClear(point, [destination.position, site.entry], clearance, `${stationId} visitor`);
    } else {
      const interaction = stationId === "garden" ? scene.bushes[0] : scene.campfires[0];
      const access = stationId === "garden" ? [interaction.entry, interaction.hide] : [interaction.seat, interaction.position];
      assertClear(point, access, clearance, stationId);
    }
  }
});

test("work clearance follows visible hero sizes while ground navigation keeps its normal foot radius", () => {
  for (const size of [30, 50, 90]) {
    const scene = fixture(size), { route } = checkedRoute(scene, job("home"));
    assert.equal(builderWorkClearance(scene), (40 + size) / 2);
    assert.equal(builderLocalPlaces(scene).navigation.radius, 4);
    assertClear(route.target.position, [scene.actor.spawn, scene.sites[0].entry], (40 + size) / 2, `size ${size}`);
    assert.ok(distance(route.target.position, scene.sites[0].entry) < (40 + size), "available near-side work is preferred over distant places");
  }
});

test("authored work markers cannot reclaim the doorway, but a safe reachable side marker keeps priority", () => {
  const unsafe = fixture();
  unsafe.destinations.push({ id: "builder-work-home", position: { ...unsafe.sites[0].entry }, pauseSeconds: 10 });
  const { route } = checkedRoute(unsafe, job("home"));
  assert.notDeepEqual(route.target.position, unsafe.sites[0].entry);
  const safe = fixture(), marker = { x: 305, y: 230 };
  safe.destinations.push({ id: "builder-work-home", position: marker, pauseSeconds: 10 });
  assert.deepEqual(checkedRoute(safe, job("home")).route.target.position, marker);
});

test("a future entrance excludes otherwise valid current work points before construction is claimed", () => {
  const scene = fixture(), old = checkedRoute(scene, job("home")).route.target.position;
  const changed = structuredClone(scene), next = changed.sites[0].states[1].geometry;
  next.entry = { ...old }; next.doorway = { x: old.x, y: old.y - 20 };
  const { stops, route } = checkedRoute(changed, job("home")), clearance = builderWorkClearance(changed);
  assert.notDeepEqual(route.target.position, old, "the old target becomes the upgraded doorway and must be replaced");
  for (const stop of stops) assertClear(stop.position, [changed.actor.spawn, next.entry, next.doorway], clearance, "future access");
});

test("a neighbouring cooking seat stays available without excluding arbitrary roaming interests", () => {
  const scene = fixture(), previous = checkedRoute(scene, job("home")).route.target.position;
  const withInterest = structuredClone(scene);
  withInterest.navigation.interests.push({ id: "look-near-home", position: { ...previous }, activity: "look" });
  assert.deepEqual(checkedRoute(withInterest, job("home")).route.target.position, previous, "an interest does not reserve a permanent work exclusion");
  const withFire = structuredClone(scene);
  withFire.campfires = [{ id: "neighbouring-fire", seat: { ...previous }, position: { x: previous.x + 35, y: previous.y }, radius: 10 }];
  const { stops, route } = checkedRoute(withFire, job("home"));
  assert.notDeepEqual(route.target.position, previous);
  for (const stop of stops) assertClear(stop.position, [previous], builderWorkClearance(withFire), "future cooking request");
});

test("a narrow approach with no room beside the host has no unsafe doorway fallback", () => {
  const scene = fixture();
  scene.navigation.areas = [{ id: "narrow", points: rect(236, 195, 28, 200) }, { id: "rest", points: rect(200, 350, 150, 80) }];
  assert.ok(builderLocalPlaces(scene), "a rest area remains available");
  assert.equal(builderWorkStops(scene, job("home")).length, 0);
});
