import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createPhaserActorNavigation } = await vite.ssrLoadModule("/features/world/phaser/actor-navigation.ts");
const { createWorldNavigation, canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const point = (x, y) => ({ x, y });
const rectangle = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
const world = (obstacles = []) => ({ schemaVersion: 1, id: "phaser-actor-test", width: 100, height: 100,
  actor: { spawn: point(15, 50), size: 20 }, focus: { x: 0, y: 0, width: 100, height: 100 },
  terrain: [], sites: [], paths: [], navigation: { version: 1, cellSize: 5,
    areas: [{ id: "grass", points: rectangle(0, 0, 100, 100) }], obstacles, interests: [] } });

test("preview actor follows a safe detour and never cuts the corner between waypoints", () => {
  const source = world([{ id: "workshop", points: rectangle(44, 25, 12, 50) }]);
  const actor = createPhaserActorNavigation(source), nav = createWorldNavigation(source);
  assert.equal(actor.active, true);
  assert.equal(actor.walkTo(point(85, 50)), true);
  let frames = 0, previous = actor.position;
  while (actor.moving && frames++ < 500) {
    actor.update(16);
    assert.ok(canTraverse(nav, previous, actor.position));
    previous = actor.position;
  }
  assert.equal(actor.moving, false);
  assert.deepEqual(actor.position, point(85, 50));
});

test("blocked, missing and nonfinite destinations grant no walking permission", () => {
  const source = world([{ id: "rock", points: rectangle(40, 40, 20, 20) }]);
  const actor = createPhaserActorNavigation(source);
  for (const target of [point(50, 50), point(-20, 20), point(NaN, 50), point(50, Infinity)]) {
    assert.equal(actor.walkTo(target), false);
    actor.update(16);
    assert.deepEqual(actor.position, source.actor.spawn);
  }
  const unmarked = createPhaserActorNavigation({ ...source, navigation: undefined });
  assert.equal(unmarked.active, false);
  assert.equal(unmarked.walkTo(point(25, 50)), false);
});

test("suspended frames have bounded movement and invalid deltas do not corrupt the route", () => {
  const actor = createPhaserActorNavigation(world());
  actor.walkTo(point(85, 50));
  const start = actor.position;
  actor.update(60_000);
  assert.ok(actor.position.x - start.x < 4);
  const afterResume = actor.position;
  for (const delta of [NaN, Infinity, -100]) actor.update(delta);
  assert.deepEqual(actor.position, afterResume);
  assert.equal(actor.moving, true);
});

test("new editor geometry cancels the path and relocates a covered actor onto walkable ground", () => {
  const source = world(), actor = createPhaserActorNavigation(source);
  actor.walkTo(point(85, 50));
  actor.update(50);
  const occupied = world([{ id: "moved-workshop", points: rectangle(5, 35, 30, 30) }]);
  actor.updateWorld(occupied);
  assert.equal(actor.moving, false);
  assert.equal(actor.active, true);
  assert.ok(isWalkable(createWorldNavigation(occupied), actor.position));
  assert.notDeepEqual(actor.position, occupied.actor.spawn);
  const relocated = actor.position;
  actor.update(50);
  assert.deepEqual(actor.position, relocated);
});

test("reset uses authored spawn and exposed position cannot mutate navigation", () => {
  const source = world(), actor = createPhaserActorNavigation(source);
  const exposed = actor.position;
  exposed.x = -999;
  assert.deepEqual(actor.position, source.actor.spawn);
  actor.walkTo(point(85, 50));
  actor.update(50);
  actor.reset();
  assert.equal(actor.moving, false);
  assert.deepEqual(actor.position, source.actor.spawn);
});

test("an entirely blocked editor map hides the actor instead of bypassing collision", () => {
  const actor = createPhaserActorNavigation(world());
  actor.walkTo(point(85, 50));
  actor.updateWorld(world([{ id: "closed", points: rectangle(0, 0, 100, 100) }]));
  assert.equal(actor.active, false);
  assert.equal(actor.moving, false);
  assert.equal(actor.walkTo(point(85, 50)), false);
  actor.updateWorld(world());
  assert.equal(actor.active, true);
  assert.equal(actor.walkTo(point(85, 50)), true);
});

test("building approach uses safe nearby ground and reports that it did not reach the blocked entry", () => {
  const source = world();
  const site = { id: "workshop", entry: point(50, 50), collision: rectangle(40, 40, 20, 20) };
  source.sites = [site];
  const actor = createPhaserActorNavigation(source), nav = createWorldNavigation(source);
  assert.equal(actor.walkTo(site.entry), false);
  const approach = actor.walkToSite(site);
  assert.equal(approach.kind, "near-entry");
  assert.ok(Math.hypot(approach.point.x - site.entry.x, approach.point.y - site.entry.y) <= source.actor.size * 1.2);
  assert.ok(isWalkable(nav, approach.point));
  let previous = actor.position, frames = 0;
  while (actor.moving && frames++ < 200) {
    actor.update(16);
    assert.ok(canTraverse(nav, previous, actor.position));
    previous = actor.position;
  }
  assert.deepEqual(actor.position, approach.point);
  assert.equal(actor.walkToSite({ ...site, id: "missing" }), null);
});

test("building approach never snaps across a disconnected barrier", () => {
  const source = world([{ id: "wall", points: rectangle(40, 0, 20, 100) }]);
  const site = { id: "workshop", entry: point(90, 50), collision: rectangle(85, 40, 10, 20) };
  source.sites = [site];
  const actor = createPhaserActorNavigation(source);
  assert.equal(actor.walkToSite(site), null);
  actor.update(16);
  assert.deepEqual(actor.position, source.actor.spawn);
});
