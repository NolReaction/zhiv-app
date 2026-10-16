import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestSocial, advanceForestSocial, requestForestSocialVisit, forestSocialFrames,
  forestSocialPartner, forestSocialWaitingHost } = await vite.ssrLoadModule("/features/world/characters/social/forest-social.ts");
const { FOREST_PURPOSE_CONVERSATIONS } = await vite.ssrLoadModule("/features/world/characters/social/forest-purpose-conversations.ts");
const { forestLeaftailWindow } = await vite.ssrLoadModule("/features/world/characters/social/forest-leaftail-window.ts");
const { createWorldNavigation, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const scene = { id: "social-opportunities", width: 500, height: 320, sites: [], paths: [], destinations: [],
  actor: { spawn: { x: 50, y: 170 }, size: 44 }, focus: { x: 0, y: 0, width: 500, height: 320 },
  navigation: { version: 1, cellSize: 6, areas: [{ id: "ground", points: rect(0, 0, 500, 320) }], obstacles: [], interests: [] } };
const actor = (id, x, patch = {}) => ({ id, position: { x, y: 170 }, size: 44, visible: true, available: true,
  context: "idle", ...patch });
function passing(seed = 0) {
  const state = createForestSocial(seed); state.nextEncounterAt = Infinity;
  const guest = actor("lopukh", 70, { context: "walk", moving: true, canPausePassing: true });
  const host = actor("kamneshmyg", 130, { context: "walk", moving: true, canPausePassing: true });
  return { state, guest, host, env: { scene, builder: null, actors: [guest, host] } };
}
function chosenPassing() {
  for (let seed = 0; seed < 100; seed++) {
    const value = passing(seed); advanceForestSocial(value.state, .1, value.env);
    if (value.state.meeting) return value;
  }
  assert.fail("at least one deterministic crossing should produce a short exchange");
}
function visit(hostPatch = {}) {
  const state = createForestSocial("purpose"), guest = actor("lopukh", 50), host = actor("plesk", 250, hostPatch);
  const calls = [], statuses = new Map();
  const env = { scene, builder: null, actors: [guest, host], occupants: [{ id: guest.id, position: guest.position, size: guest.size }],
    requestVisit(id, target, occupants) {
      calls.push({ id, target, occupants }); if (id !== guest.id) return false;
      statuses.set(id, "approach"); guest.context = "walk"; return true;
    },
    cancelVisit(id) { statuses.delete(id); }, visitStatus(id) { return statuses.get(id) ?? null; } };
  return { state, guest, host, calls, env, statuses,
    arrive() { guest.position = host.approach ? { ...host.approach } : { x: host.position.x - 49.28, y: host.position.y };
      guest.context = "idle"; statuses.set(guest.id, "arrived"); advanceForestSocial(state, 0, env); } };
}

test("thirty purposeful exchanges cover every crossing pair and grounded fish/window/trade questions", () => {
  assert.equal(FOREST_PURPOSE_CONVERSATIONS.length, 30);
  assert.equal(new Set(FOREST_PURPOSE_CONVERSATIONS.map(topic => topic.id)).size, 30);
  for (const purpose of ["fish", "window", "trade", "passing"])
    assert.equal(FOREST_PURPOSE_CONVERSATIONS.filter(topic => topic.purpose === purpose).length, purpose === "passing" ? 15 : 5);
  for (const topic of FOREST_PURPOSE_CONVERSATIONS) {
    assert.equal(topic.lines.length, topic.purpose === "passing" ? 2 : 4);
    assert.deepEqual([...new Set(topic.lines.map(line => line.speaker))].sort(), topic.pair.split("-").sort());
    for (const [index, line] of topic.lines.entries()) {
      assert.notEqual(line.speaker, topic.lines[index - 1]?.speaker);
      assert.ok(line.text.length > 0 && line.text.length <= 42, `${topic.id}: ${line.text}`);
    }
  }
});

test("a real crossing can produce two short lines before the ordinary random invitation deadline", () => {
  const value = chosenPassing(), initial = value.state.current;
  assert.equal(value.state.meeting.purpose, "passing"); assert.equal(value.state.meeting.visit, null);
  assert.ok(value.state.elapsed < 1); assert.equal(value.state.queue.length, 1);
  assert.equal(forestSocialPartner(value.state, "lopukh"), "kamneshmyg");
  assert.equal(forestSocialWaitingHost(value.state), null);
  const spoken = [initial.text];
  for (let age = 0; age < 12; age += .1) {
    advanceForestSocial(value.state, .1, value.env);
    if (value.state.current && spoken.at(-1) !== value.state.current.text) spoken.push(value.state.current.text);
  }
  assert.equal(spoken.length, 2); assert.equal(value.state.meeting, null);
  assert.equal(value.state.lastMeetingResult.status, "completed");
  assert.ok(value.state.pairAfter["kamneshmyg:lopukh"] > value.state.elapsed + 130);
});

test("crossing chance is per approach, not per frame; staying or reading cannot repeatedly roll it", () => {
  let failed, successes = 0;
  for (let seed = 0; seed < 100; seed++) {
    const value = passing(seed); advanceForestSocial(value.state, .1, value.env);
    if (value.state.meeting) successes++; else failed ??= value;
  }
  assert.ok(successes > 10 && successes < 70); assert.ok(failed);
  for (let age = 0; age < 200; age++) advanceForestSocial(failed.state, 1, failed.env);
  assert.equal(failed.state.meeting, null); assert.equal(failed.state.sequence, 0, "remaining on the path does not retry chance every tick");
  const snapshot = structuredClone(failed.state);
  for (let camera = 0; camera < 6; camera++) { assert.deepEqual(forestSocialFrames(failed.state), []); forestSocialPartner(failed.state, "lopukh"); }
  assert.deepEqual(failed.state, snapshot);
  failed.host.position.x = 350; advanceForestSocial(failed.state, .1, failed.env); assert.deepEqual(failed.state.passingPairs, []);
});

test("passing never interrupts economic work, doorways, unavailable walkers, storms or deliberate still presentation", () => {
  for (const change of [value => { value.guest.available = false; }, value => { value.host.context = "mine"; },
    value => { value.host.context = "sleep"; }, value => { value.guest.canPausePassing = false; },
    value => { value.env.rain = .8; }, value => { value.env.dusk = .9; }, value => { value.env.ambient = false; }]) {
    for (let seed = 0; seed < 20; seed++) {
      const value = passing(seed); change(value); advanceForestSocial(value.state, .1, value.env);
      assert.equal(value.state.meeting, null);
    }
  }
  for (const change of [value => { value.host.available = false; value.host.context = "mine"; },
    value => { value.env.enabled = false; }, value => { value.env.ambient = false; }]) {
    const value = chosenPassing(), elapsed = value.state.elapsed; change(value); advanceForestSocial(value.state, 0, value.env);
    assert.equal(value.state.meeting, null); assert.equal(value.state.lastMeetingResult.status, "interrupted");
    assert.equal(value.state.elapsed, elapsed); assert.equal(forestSocialPartner(value.state, "lopukh"), null);
  }
});

test("a stationary fisher receives a purposeful question while keeping her fishing activity", () => {
  const denied = visit({ context: "fish" });
  assert.equal(requestForestSocialVisit(denied.state, "lopukh", "plesk", denied.env), false);
  const value = visit({ context: "fish", canReceiveVisit: true });
  assert.equal(requestForestSocialVisit(value.state, "lopukh", "plesk", value.env), true);
  assert.equal(value.state.meeting.purpose, "fish"); assert.equal(forestSocialWaitingHost(value.state), "plesk");
  value.arrive(); assert.equal(value.state.meeting.phase, "talk");
  assert.equal(value.state.topicHistory.at(-1), "fish-lopukh-plesk");
  const position = structuredClone(value.host.position);
  for (let age = 0; age < 25; age++) advanceForestSocial(value.state, 1, value.env);
  assert.equal(value.state.lastMeetingResult.status, "completed");
  assert.equal(value.host.context, "fish"); assert.deepEqual(value.host.position, position);
  assert.equal(value.state.meeting, null); assert.equal(value.statuses.size, 0);
});

test("already nearby neighbours talk from their real feet instead of making an unnecessary visiting circle", () => {
  const value = visit(); value.guest.id = "mochlik"; value.host.position.x = value.guest.position.x + 55;
  value.state.nextEncounterAt = 0;
  const feet = [structuredClone(value.guest.position), structuredClone(value.host.position)];
  advanceForestSocial(value.state, .1, value.env);
  assert.equal(value.state.meeting?.phase, "talk"); assert.equal(value.state.meeting?.visit, null);
  assert.equal(value.state.meeting?.guest, "mochlik"); assert.equal(value.state.meeting?.host, "plesk");
  assert.equal(value.calls.length, 0, "the newly available Pleska visit callback cannot steal an existing nearby exchange");
  assert.deepEqual([value.guest.position, value.host.position], feet);
});

test("a window visit uses an exact exterior approach without inventing a physical indoor occupant", () => {
  const value = visit({ id: "leaftail", position: { x: 300, y: 100 }, context: "trade", canReceiveVisit: true,
    window: true, approach: { x: 300, y: 170 }, speechAnchor: { x: 300, y: 85 } });
  assert.equal(requestForestSocialVisit(value.state, "lopukh", "leaftail", value.env), true);
  assert.equal(value.calls[0].target.approach, value.host.approach);
  assert.equal(value.calls[0].occupants.length, 1); assert.equal(value.calls[0].occupants[0].id, "lopukh");
  assert.equal(value.state.meeting.purpose, "window"); value.arrive();
  assert.equal(value.state.meeting.phase, "talk"); assert.equal(value.state.topicHistory.at(-1), "window-lopukh-leaftail");
  const window = structuredClone(value.host);
  for (let age = 0; age < 25; age++) advanceForestSocial(value.state, 1, value.env);
  assert.deepEqual(value.host, window, "the merchant keeps his indoor/window presentation and never walks outside");
  assert.equal(value.state.lastMeetingResult.status, "completed");
});

test("window occupancy, disappearance and withdrawal preempt the conversation at zero time", () => {
  for (const change of [value => { value.host.available = false; }, value => { value.host.visible = false; },
    value => { value.host.context = "busy"; }, value => { value.statuses.clear(); }, value => { value.env.enabled = false; }]) {
    const value = visit({ id: "leaftail", position: { x: 300, y: 100 }, context: "trade", canReceiveVisit: true,
      window: true, approach: { x: 300, y: 170 } });
    requestForestSocialVisit(value.state, "lopukh", "leaftail", value.env); value.arrive(); change(value);
    const elapsed = value.state.elapsed; advanceForestSocial(value.state, 0, value.env);
    assert.equal(value.state.meeting, null); assert.equal(value.state.lastMeetingResult.status, "interrupted");
    assert.equal(value.state.elapsed, elapsed); assert.equal(value.state.current, null);
  }
});

test("Mochlik can explicitly ask at the window only after his own real walk reaches the safe approach", () => {
  const value = visit({ id: "leaftail", position: { x: 300, y: 100 }, context: "trade", canReceiveVisit: true,
    window: true, approach: { x: 300, y: 170 } });
  value.guest.id = "mochlik";
  assert.equal(requestForestSocialVisit(value.state, "mochlik", "leaftail", value.env), false);
  assert.equal(value.calls.length, 0); assert.equal(value.state.meeting, null);
  value.guest.position = { ...value.host.approach }; const feet = structuredClone(value.guest.position);
  assert.equal(requestForestSocialVisit(value.state, "mochlik", "leaftail", value.env), true);
  assert.equal(value.calls.length, 0, "an arrived hero never borrows a villager's path or doorway");
  assert.equal(value.state.meeting.phase, "talk"); assert.equal(value.state.meeting.purpose, "window");
  assert.deepEqual(value.guest.position, feet);
  assert.equal(value.state.topicHistory.at(-1), "window-mochlik-leaftail");
});

test("actual caravan window annotation has a safe exterior footstop without modifying authored geometry", () => {
  const before = JSON.stringify(TILED_WORLD), window = forestLeaftailWindow(TILED_WORLD);
  assert.ok(window); assert.equal(forestLeaftailWindow(TILED_WORLD), window, "one geometry computation per shared scene");
  const site = TILED_WORLD.sites.find(site => site.id === "leaftail-caravan");
  assert.ok(window.position.x > site.bounds.x && window.position.x < site.bounds.x + site.bounds.width);
  assert.ok(window.position.y > site.bounds.y && window.position.y < site.bounds.y + site.bounds.height);
  assert.ok(Math.hypot(window.approach.x - window.position.x, window.approach.y - window.position.y) < 100);
  assert.ok(window.speechAnchor.y < window.position.y);
  assert.ok(isWalkable(createWorldNavigation(TILED_WORLD, window.size * .13), window.approach));
  assert.equal(JSON.stringify(TILED_WORLD), before);
  assert.equal(forestLeaftailWindow({ ...TILED_WORLD, sites: [] }), null);
  assert.equal(forestLeaftailWindow({ ...TILED_WORLD, navigation: undefined }), null);
});
