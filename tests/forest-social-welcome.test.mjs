import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { createForestSocial, advanceForestSocial, forestSocialWaitingHost } = await load("characters/social/forest-social");
const { queueForestSocialWelcome, forestWelcomeConversation } = await load("characters/social/forest-social-welcome");
const { createBuilderMind, advanceBuilderMind } = await load("characters/builder/builder-mind");
const { builderLocalPlaces } = await load("characters/builder/builder-navigation");
const { canTraverse } = await load("navigation/navigation");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const now = Date.parse("2026-10-18T12:00:00Z");
function fixture() {
  const scene = { schemaVersion: 1, id: "welcome", width: 400, height: 280, terrain: [], paths: [], destinations: [],
    focus: { x: 0, y: 0, width: 400, height: 280 }, actor: { spawn: { x: 70, y: 170 }, size: 50 },
    sites: [{ id: "home", label: "Дом", initialLevel: 1, bounds: { x: 230, y: 60, width: 80, height: 80 },
      anchor: { x: 270, y: 100 }, entry: { x: 270, y: 145 }, hitArea: rect(230, 60, 80, 80),
      collision: rect(245, 75, 50, 50), states: [{ level: 1, label: "Дом", image: "/home.webp" }] }],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "land", points: rect(0, 0, 400, 280) }], obstacles: [],
      interests: [{ id: "look", activity: "look", position: { x: 325, y: 215 } }] } };
  const state = createForestSocial("welcome-test"), builder = createBuilderMind(scene);
  state.nextEncounterAt = state.nextAnimalAt = Infinity;
  const host = { id: "kamneshmyg", position: { x: 330, y: 215 }, size: 42, visible: true, available: true, context: "idle" };
  const merchant = { ...host, id: "leaftail", position: { x: 330, y: 165 }, visible: false };
  const value = { scene, state, builder, host, merchant, enabled: true, ambient: true, construction: { ownerPublicId: "owner", revision: 1, jobs: [] } };
  value.env = () => ({ scene, builder, enabled: value.enabled, ambient: value.ambient, actors: [host, merchant,
    { id: "builder", position: { ...builder.position }, size: 40, visible: builder.available,
      available: !builder.job && !builder.noticePending, context: builder.job ? "build" : builder.route ? "walk" : "idle" }],
    occupants: [host, merchant].filter(item => item.visible).map(({ id, position, size }) => ({ id, position, size })) });
  return value;
}
function tick(value, seconds = .1, callback) {
  for (let t = 0; t < seconds - 1e-7; t += .1) {
    const dt = Math.min(.1, seconds - t), from = { ...value.builder.position };
    advanceBuilderMind(value.builder, value.scene, 0, { now, construction: value.construction });
    advanceForestSocial(value.state, dt, value.env());
    advanceBuilderMind(value.builder, value.scene, dt, { now, construction: value.construction, occupants: value.env().occupants,
      socialHold: value.state.meeting?.phase === "talk" });
    assert.ok(Math.hypot(value.builder.position.x - from.x, value.builder.position.y - from.y) <= 34 * dt + .001, "a welcome never teleports the visitor");
    assert.ok(canTraverse(builderLocalPlaces(value.scene).navigation, from, value.builder.position), "every approach segment stays on land");
    callback?.();
  }
}
function reach(value) {
  for (let age = 0; age < 25 && value.state.meeting?.phase !== "talk"; age += .1) tick(value);
  assert.equal(value.state.meeting?.phase, "talk");
}

test("one established neighbour really walks up, introduces himself, releases the visit and never repeats", () => {
  const value = fixture(); queueForestSocialWelcome(value.state, "kamneshmyg"); queueForestSocialWelcome(value.state, "kamneshmyg");
  assert.equal(value.state.welcomes.length, 1);
  tick(value, 2.1);
  assert.equal(value.state.meeting?.purpose, "welcome"); assert.equal(value.state.meeting?.guest, "builder");
  assert.equal(value.state.meeting?.phase, "approach"); assert.equal(value.state.current, null, "no introduction is spoken across the map");
  assert.equal(forestSocialWaitingHost(value.state), "kamneshmyg"); assert.ok(value.builder.socialVisit);
  reach(value);
  assert.match(value.state.current.text, /Я Шишколап/); assert.equal(value.state.queue.length, 3);
  assert.deepEqual(value.state.welcomedResidents, ["kamneshmyg"]);
  tick(value, 22);
  assert.equal(value.state.meeting, null); assert.equal(value.builder.socialVisit, null);
  queueForestSocialWelcome(value.state, "kamneshmyg"); tick(value, 25);
  assert.equal(value.state.meeting, null); assert.equal(value.state.welcomes.length, 0);
});

test("two arrivals use one guest in sequence, never a crowd", () => {
  const value = fixture(); value.merchant.visible = true;
  queueForestSocialWelcome(value.state, "kamneshmyg"); queueForestSocialWelcome(value.state, "leaftail");
  const hosts = new Set(); tick(value, 70, () => {
    if (value.state.meeting) {
      assert.equal(value.state.meeting.guest, "builder"); hosts.add(value.state.meeting.host);
      assert.ok(value.builder.socialVisit, "one visit owns the real existing body");
    }
  });
  assert.deepEqual([...hosts], ["kamneshmyg", "leaftail"]);
  assert.deepEqual(value.state.welcomedResidents, ["kamneshmyg", "leaftail"]);
});

test("work, indoor newcomers, reduced motion and disabled scenes do not begin an introduction", () => {
  for (const patch of [{ available: false }, { visible: false }, { context: "mine" }, { window: true }]) {
    const value = fixture(); Object.assign(value.host, patch); queueForestSocialWelcome(value.state, "kamneshmyg"); tick(value, 15);
    assert.equal(value.state.meeting, null); assert.equal(value.builder.socialVisit, null);
  }
  for (const patch of [{ ambient: false }, { enabled: false }]) {
    const value = fixture(); Object.assign(value, patch); queueForestSocialWelcome(value.state, "kamneshmyg"); tick(value, 15);
    assert.equal(value.state.meeting, null); assert.equal(value.builder.socialVisit, null);
  }
});

test("lost visibility interrupts the approach and releases its hold; a quiet retry remains bounded", () => {
  const value = fixture(); queueForestSocialWelcome(value.state, "kamneshmyg"); tick(value, 2.1);
  assert.ok(value.builder.socialVisit); value.host.visible = false;
  advanceForestSocial(value.state, 0, value.env());
  assert.equal(value.state.meeting, null); assert.equal(value.builder.socialVisit, null); assert.equal(forestSocialWaitingHost(value.state), null);
  assert.equal(value.state.welcomes[0].attempts, 1);
  value.host.visible = true; tick(value, 25); reach(value); tick(value, 22);
  assert.deepEqual(value.state.welcomedResidents, ["kamneshmyg"]);
});

test("job preemption during approach does not hijack the construction or replay a spoken introduction", () => {
  const value = fixture(); queueForestSocialWelcome(value.state, "kamneshmyg"); tick(value, 2.1);
  value.construction = { ownerPublicId: "owner", revision: 2, jobs: [{ id: "job", stationId: "home", targetLevel: 2,
    startedAt: new Date(now - 500).toISOString(), finishesAt: new Date(now + 100_000).toISOString() }] };
  tick(value, .1);
  assert.equal(value.state.meeting, null); assert.equal(value.builder.socialVisit, null); assert.ok(value.builder.job);
  assert.deepEqual(value.state.welcomedResidents, []);
});

test("unique welcome scripts fit speech bubbles and preserve the two newcomer personalities", () => {
  for (const resident of ["kamneshmyg", "leaftail"]) for (const guest of ["builder", "plesk", "lopukh"]) {
    const topic = forestWelcomeConversation(resident, guest);
    assert.equal(topic.lines.length, 4); assert.ok(topic.lines.every(line => line.text.length <= 42));
    assert.deepEqual(new Set(topic.lines.map(line => line.speaker)), new Set([resident, guest]));
    assert.match(topic.lines[1].text, resident === "kamneshmyg" ? /голубчик/ : /хвост/);
  }
});

test("an unavailable earlier arrival does not block a free newcomer and failed approaches have a finite budget", () => {
  const value = fixture(); value.host.available = false; value.merchant.visible = true;
  queueForestSocialWelcome(value.state, "kamneshmyg"); queueForestSocialWelcome(value.state, "leaftail"); tick(value, 2.1);
  assert.equal(value.state.meeting?.host, "leaftail");
  const blocked = fixture(); blocked.host.position = { x: 250, y: -10 };
  queueForestSocialWelcome(blocked.state, "kamneshmyg"); tick(blocked, 90);
  assert.equal(blocked.state.meeting, null); assert.equal(blocked.builder.socialVisit, null);
  assert.equal(blocked.state.welcomes.length, 0, "four failed checked routes are abandoned quietly");
  const busy = fixture(); busy.host.available = false;
  queueForestSocialWelcome(busy.state, "kamneshmyg"); tick(busy, 242);
  assert.equal(busy.state.welcomes.length, 0, "a permanently busy newcomer expires after four active minutes");
});
