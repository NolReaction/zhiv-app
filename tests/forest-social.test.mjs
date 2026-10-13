import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestSocial, noticeForestSocial, advanceForestSocial, forestSocialFrames,
  forestSocialHolding, forestSocialPartner, cancelForestSocial, FOREST_SOCIAL_LIMITS } = await vite.ssrLoadModule("/features/world/characters/social/forest-social.ts");
const { createBuilderMind, advanceBuilderMind, requestBuilderVisit, cancelBuilderVisit } = await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { builderLocalPlaces } = await vite.ssrLoadModule("/features/world/characters/builder/builder-navigation.ts");
const { canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { residentClearance } = await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts");
const { FOREST_ANIMAL_LINES, forestClickLines } = await vite.ssrLoadModule("/features/world/characters/social/forest-social-dialogue.ts");
const { FOREST_CONVERSATIONS } = await vite.ssrLoadModule("/features/world/characters/social/forest-conversations.ts");
const now = Date.parse("2026-10-06T18:00:00Z");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function fixture(seed = "social-test") {
  const scene = { schemaVersion: 1, id: "social", width: 400, height: 280, terrain: [], paths: [], destinations: [],
    focus: { x: 0, y: 0, width: 400, height: 280 }, actor: { spawn: { x: 70, y: 170 }, size: 50 },
    sites: [{ id: "home", label: "Дом", initialLevel: 1, bounds: { x: 230, y: 60, width: 80, height: 80 },
      anchor: { x: 270, y: 100 }, entry: { x: 270, y: 145 }, hitArea: rect(230, 60, 80, 80),
      collision: rect(245, 75, 50, 50), states: [{ level: 1, label: "Дом", image: "/home.webp" },
        { level: 2, label: "Дом 2", image: "/home-2.webp" }] }],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "land", points: rect(0, 0, 400, 280) }], obstacles: [],
      interests: [{ id: "look", activity: "look", position: { x: 325, y: 215 } }] } };
  const mind = createBuilderMind(scene), state = createForestSocial(seed);
  const hero = { id: "mochlik", position: { x: 70, y: 170 }, size: 50, visible: true, available: true, context: "idle" };
  const plesk = { id: "plesk", position: { x: 360, y: 210 }, size: 44, visible: true, available: false, context: "idle" };
  const value = { scene, mind, state, hero, plesk, construction: { ownerPublicId: "owner", revision: 1, jobs: [] },
    enabled: true, ambient: true, animalEvents: [] };
  value.env = () => ({ scene, builder: mind, enabled: value.enabled, ambient: value.ambient, animalEvents: value.animalEvents,
    actors: [hero, plesk, { id: "builder", position: { ...mind.position }, size: 40, visible: mind.available,
      available: !mind.job && mind.action !== "finish", context: mind.job ? mind.ready ? "ready" : "build" : mind.route ? "walk" : "idle" }],
    occupants: [hero, plesk].filter(item => item.visible).map(item => ({ id: item.id, position: item.position, size: item.size })) });
  return value;
}
function tick(value, seconds = .1, onTick) {
  for (let age = 0; age < seconds - 1e-7; age += .1) {
    const dt = Math.min(.1, seconds - age), previous = { ...value.mind.position };
    advanceBuilderMind(value.mind, value.scene, 0, { now, construction: value.construction });
    advanceForestSocial(value.state, dt, value.env());
    advanceBuilderMind(value.mind, value.scene, dt, { now, construction: value.construction, occupants: value.env().occupants });
    assert.ok(Math.hypot(value.mind.position.x - previous.x, value.mind.position.y - previous.y) <= 34 * dt + .001, "social visit never teleports");
    assert.ok(canTraverse(builderLocalPlaces(value.scene).navigation, previous, value.mind.position), "complete motion stays on land");
    onTick?.();
  }
}
function startMeeting(value) {
  value.state.nextEncounterAt = value.state.elapsed;
  tick(value);
  assert.equal(value.state.meeting?.phase, "approach");
  assert.equal(forestSocialHolding(value.state), null, "Mochlik remains free during approach");
}
function reachMeeting(value) {
  startMeeting(value);
  for (let elapsed = 0; elapsed < 18 && value.state.meeting?.phase === "approach"; elapsed += .1) tick(value);
  assert.equal(value.state.meeting?.phase, "talk");
}

test("clicks are contextual cosmetic replies with global and character cooldowns and detached frames", () => {
  const value = fixture(), { state, mind } = value;
  value.hero.context = "cook"; value.hero.available = false;
  const pose = structuredClone({ position: mind.position, action: mind.action, route: mind.route });
  assert.equal(noticeForestSocial(state, "mochlik", value.env()), true);
  assert.equal(state.current.origin, "interaction");
  assert.ok(forestClickLines("mochlik", "cook").includes(state.current.text));
  for (let n = 0; n < 100; n++) assert.equal(noticeForestSocial(state, n % 2 ? "plesk" : "mochlik", value.env()), false);
  const frames = forestSocialFrames(state); frames[0].text = "changed"; frames[0].elapsed = 99;
  assert.notEqual(state.current.text, "changed"); assert.equal(state.current.elapsed, 0);
  advanceForestSocial(state, 6, { ...value.env(), ambient: false });
  assert.equal(state.current, null); assert.equal(noticeForestSocial(state, "mochlik", value.env()), false);
  assert.equal(noticeForestSocial(state, "plesk", value.env()), true);
  assert.deepEqual({ position: mind.position, action: mind.action, route: mind.route }, pose);
  advanceForestSocial(state, 20, { ...value.env(), ambient: false });
  assert.equal(noticeForestSocial(state, "mochlik", value.env()), true);
  assert.equal(state.queue.length, 0);
});

test("hidden, sleeping or explicitly disabled residents cannot speak, while working residents can", () => {
  for (const patch of [{ visible: false }, { canSpeak: false }, { context: "sleep" }]) {
    const value = fixture(); Object.assign(value.hero, patch);
    assert.equal(noticeForestSocial(value.state, "mochlik", value.env()), false);
  }
  const value = fixture(); value.enabled = false;
  assert.equal(noticeForestSocial(value.state, "builder", value.env()), false);
  value.enabled = true; value.mind.job = { id: "work" }; value.mind.action = "work";
  assert.equal(noticeForestSocial(value.state, "builder", value.env()), true);
  assert.ok(forestClickLines("builder", "build").includes(value.state.current.text));
  assert.equal(value.mind.action, "work"); assert.equal(value.mind.job.id, "work");
});

test("automatic meetings leave a long quiet opening and do not catch up offline", () => {
  const value = fixture("same"), equal = createForestSocial("same");
  assert.deepEqual(value.state, equal);
  assert.ok(value.state.nextEncounterAt >= 30 && value.state.nextEncounterAt <= 50);
  advanceForestSocial(value.state, 3600, value.env());
  assert.equal(value.state.elapsed, 1); assert.equal(value.state.meeting, null);
  tick(value, 25); assert.equal(value.state.meeting, null); assert.equal(value.state.current, null);
  const before = structuredClone(value.state);
  for (const dt of [NaN, Infinity, -1, 0]) advanceForestSocial(value.state, dt, value.env());
  assert.deepEqual(value.state, before);
});

test("builder walks safely to personal space, trades a complete authored dialogue, then releases both residents", () => {
  const value = fixture(); reachMeeting(value);
  const gap = Math.hypot(value.mind.position.x - value.hero.position.x, value.mind.position.y - value.hero.position.y);
  assert.ok(gap > residentClearance(40, 50)); assert.equal(value.mind.route, null);
  assert.equal(forestSocialHolding(value.state), "mochlik");
  const feet = { ...value.mind.position }, spoken = [structuredClone(value.state.current)];
  tick(value, 32, () => {
    const line = value.state.current;
    if (line && !spoken.some(old => old.id === line.id)) spoken.push(structuredClone(line));
    if (value.state.meeting?.phase === "talk") assert.deepEqual(value.mind.position, feet);
  });
    assert.ok(spoken.every(line => line.origin === "ambient"));
  const topic = FOREST_CONVERSATIONS.find(item => item.id === value.state.topicHistory[0]);
  assert.deepEqual(spoken.map(({ speaker, text }) => ({ speaker, text })), topic.lines);
  assert.equal(value.state.current, null); assert.equal(value.state.meeting, null); assert.equal(value.mind.socialVisit, null);
  assert.equal(forestSocialHolding(value.state), null);
  assert.ok(value.state.nextEncounterAt > value.state.elapsed + 70, "another spontaneous chat cannot immediately follow");
});

test("a due invitation waits for the next quiet moment instead of missing short idle windows", () => {
  const value = fixture(); value.state.nextEncounterAt = 0;
  value.hero.available = false; value.hero.context = "busy";
  const decisions = value.mind.decisions;
  tick(value, 5);
  assert.equal(value.state.nextEncounterAt, 0); assert.equal(value.state.meeting, null);
  assert.equal(value.mind.decisions, decisions, "busy frames never run social pathfinding");
  value.hero.available = true; value.hero.context = "idle"; tick(value);
  assert.equal(value.state.meeting?.phase, "approach", "the next genuine idle window can accept a visit");
});

test("history varies complete subjects and bounds all dialogue memory", () => {
  const value = fixture(); const topics = [], lines = [];
  for (let iteration = 0; iteration < 16; iteration++) {
    reachMeeting(value);
    topics.push(value.state.topicHistory.at(-1));
    const recent = topics.slice(Math.max(0, topics.length - 5), -1);
    assert.ok(!recent.includes(topics.at(-1)));
    tick(value, 32, () => {
      const current = value.state.current;
      if (current && !lines.some(line => line.id === current.id)) lines.push(structuredClone(current));
    });
    assert.equal(value.state.meeting, null);
  }
  assert.ok(new Set(topics).size >= 8); assert.equal(value.state.topicHistory.length, 12); assert.equal(value.state.lineHistory.length, 48);
  assert.ok(lines.length >= 32);
});

test("real and ready construction preempt social visits at dt zero without replacing the work route", () => {
  for (const phase of ["approach", "talk"]) for (const ready of [false, true]) {
    const value = fixture(); if (phase === "talk") reachMeeting(value); else startMeeting(value);
    const feet = { ...value.mind.position };
    value.construction.jobs = [{ id: "upgrade", stationId: "home", targetLevel: 2,
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + (ready ? -1 : 600000)).toISOString() }];
    advanceBuilderMind(value.mind, value.scene, 0, { now, construction: value.construction });
    const route = value.mind.route, target = value.mind.target;
    advanceForestSocial(value.state, 0, value.env());
    assert.equal(value.state.meeting, null); assert.equal(value.state.current, null); assert.equal(value.mind.socialVisit, null);
    assert.equal(value.mind.route, route); assert.equal(value.mind.target, target); assert.deepEqual(value.mind.position, feet);
    assert.equal(value.mind.job.id, "upgrade"); assert.equal(value.mind.ready, ready);
    assert.equal(requestBuilderVisit(value.mind, value.scene, value.hero, value.env().occupants), false);
  }
});

test("manual activity, hiding, moved targets and disabled scenes release visits without teleportation", () => {
  for (const change of [value => { value.hero.available = false; }, value => { value.hero.visible = false; },
    value => { value.hero.position = { x: 160, y: 170 }; }, value => { value.enabled = false; }]) {
    for (const phase of ["approach", "talk"]) {
      const value = fixture(); if (phase === "talk") reachMeeting(value); else startMeeting(value);
      const before = { ...value.mind.position }; change(value);
      advanceForestSocial(value.state, 0, value.env());
      assert.equal(value.mind.socialVisit, null); assert.equal(value.state.meeting, null);
      assert.equal(value.state.current, null); assert.equal(value.state.queue.length, 0); assert.deepEqual(value.mind.position, before);
    }
  }
});

test("blocked approaches time out and failed destinations retain ordinary builder movement", () => {
  const value = fixture(); startMeeting(value);
  // Never advance the builder, as if a crowd denied every safe step.
  for (let i = 0; i < 20; i++) advanceForestSocial(value.state, 1, value.env());
  assert.equal(value.state.meeting, null); assert.equal(value.mind.socialVisit, null); assert.equal(value.state.queue.length, 0);
  assert.ok(value.state.nextEncounterAt - value.state.elapsed >= 23 && value.state.nextEncounterAt - value.state.elapsed <= 45,
    "an unsuccessful approach retries quietly without using the full conversation cooldown");
  tick(value, 4); const route = value.mind.route, before = { ...value.mind.position };
  const unreachable = { ...value.hero, position: { x: -1000, y: -1000 } };
  assert.equal(requestBuilderVisit(value.mind, value.scene, unreachable), false);
  assert.equal(value.mind.route, route); assert.deepEqual(value.mind.position, before);
});

test("animal replies consume events once, discard bursts and never queue delayed greetings", () => {
  const value = fixture(); value.state.nextEncounterAt = Infinity; value.state.nextAnimalAt = 0;
  value.animalEvents = [{ id: "one", speaker: "plesk", kind: "butterfly" }]; tick(value);
  assert.equal(value.state.current.speaker, "plesk"); assert.ok(FOREST_ANIMAL_LINES.butterfly.includes(value.state.current.text));
  value.animalEvents = [{ id: "two", speaker: "mochlik", kind: "firefly" }]; tick(value, 6);
  assert.equal(value.state.current, null); assert.equal(value.state.queue.length, 0);
  value.state.nextAnimalAt = value.state.elapsed; tick(value);
  assert.equal(value.state.current, null, "event seen during a bubble is not spoken later");
  value.animalEvents = [{ id: "three", speaker: "mochlik", kind: "bird" }]; tick(value);
  assert.ok(FOREST_ANIMAL_LINES.bird.includes(value.state.current.text));
  for (let i = 0; i < 40; i++) { value.animalEvents = [{ id: `overflow-${i}`, speaker: "mochlik", kind: "bird" }]; tick(value); }
  assert.equal(value.state.seenEvents.length, 16); assert.ok(value.state.queue.length <= 2);
});

test("still-mode expiry updates cooldowns without autonomous conversations or persistent state", () => {
  const value = fixture(); value.state.nextEncounterAt = 0;
  assert.equal(noticeForestSocial(value.state, "builder", value.env()), true);
  advanceForestSocial(value.state, 30, { ...value.env(), ambient: false });
  assert.equal(value.state.elapsed, 30); assert.equal(value.state.current, null); assert.equal(value.state.meeting, null);
  assert.equal(noticeForestSocial(value.state, "builder", value.env()), true);
  cancelForestSocial(value.state, value.env()); assert.equal(value.state.current, null);
  assert.deepEqual(createForestSocial("cold").lineHistory, []);
  assert.equal(createForestSocial("cold").current, null);
});

test("authored scripts stay whole, alternate real participants and fit a finite meeting", () => {
  assert.equal(FOREST_CONVERSATIONS.length, 42);
  assert.equal(new Set(FOREST_CONVERSATIONS.map(topic => topic.id)).size, 42);
  const lines = Object.values(FOREST_ANIMAL_LINES).flat();
  for (const pair of ["builder-mochlik", "builder-plesk", "mochlik-plesk"])
    assert.equal(FOREST_CONVERSATIONS.filter(topic => topic.pair === pair).length, 14);
  for (const topic of FOREST_CONVERSATIONS) {
    assert.ok(topic.lines.length >= 4 && topic.lines.length <= 6);
    assert.deepEqual([...new Set(topic.lines.map(line => line.speaker))].sort(), topic.pair.split("-").sort());
    topic.lines.forEach((line, index) => {
      assert.notEqual(line.speaker, topic.lines[index - 1]?.speaker);
      assert.ok(line.text.length > 0 && line.text.length <= 42, `${topic.id}: ${line.text}`);
      lines.push(line.text);
    });
    const duration = topic.lines.reduce((total, line) => total + Math.min(4.4, 2.8 + line.text.length * .027), 0)
      + (topic.lines.length - 1) * FOREST_SOCIAL_LIMITS.gap;
    assert.ok(duration + 1 < FOREST_SOCIAL_LIMITS.conversation, topic.id);
  }
  for (const id of ["mochlik", "plesk", "builder"]) for (const context of ["idle", "walk", "build", "ready", "fish", "cook", "trade", "busy", "animal"])
    lines.push(...forestClickLines(id, context));
  assert.ok(lines.every(line => line.length <= 42), "short captions fit a small character bubble");
  const value = fixture(); startMeeting(value); const before = { ...value.mind.position };
  cancelBuilderVisit(value.mind); assert.deepEqual(value.mind.position, before);
});

test("the builder can visit Plesk without holding or using Mochlik", () => {
  const value = fixture(); value.hero.available = false; value.plesk.available = true;
  reachMeeting(value);
  assert.equal(value.state.meeting.host, "plesk");
  assert.equal(forestSocialHolding(value.state), null);
  assert.equal(forestSocialPartner(value.state, "plesk"), "builder");
  assert.equal(forestSocialPartner(value.state, "builder"), "plesk");
  const topic = FOREST_CONVERSATIONS.find(item => item.id === value.state.topicHistory.at(-1));
  assert.equal(topic.pair, "builder-plesk");
  const spoken = [value.state.current.text];
  tick(value, 32, () => {
    if (value.state.current && spoken.at(-1) !== value.state.current.text) spoken.push(value.state.current.text);
  });
  assert.deepEqual(spoken, topic.lines.map(line => line.text));
  assert.equal(value.state.meeting, null);
});

test("Mochlik and Plesk chat only when already nearby, without asking the builder to move", () => {
  const value = fixture(); value.plesk.available = true; value.plesk.position = { x: 130, y: 170 };
  value.state.nextEncounterAt = 0;
  const env = { ...value.env(), builder: null, actors: [value.hero, value.plesk] };
  const before = structuredClone(value.mind);
  advanceForestSocial(value.state, .1, env);
  assert.equal(value.state.meeting.phase, "talk");
  assert.equal(forestSocialPartner(value.state, "mochlik"), "plesk");
  assert.equal(forestSocialPartner(value.state, "plesk"), "mochlik");
  assert.equal(forestSocialHolding(value.state), "mochlik");
  assert.equal(forestSocialPartner(value.state, "builder"), null);
  assert.deepEqual(value.mind, before);
  value.plesk.available = false;
  advanceForestSocial(value.state, 0, env);
  assert.equal(value.state.current, null); assert.equal(value.state.meeting, null);
  assert.deepEqual(value.mind, before);
});

test("busy, absent, distant or separated residents do not start a Plesk conversation", () => {
  for (const change of [value => { value.plesk.available = false; }, value => { value.plesk.visible = false; },
    value => { value.plesk.context = "fish"; }, value => { value.plesk.context = "trade"; },
    value => { value.plesk.context = "sleep"; }, value => { value.plesk.position.x = 300; },
    value => { value.scene.navigation.obstacles = [{ id: "water", points: rect(96, 0, 8, 280) }]; }]) {
    const value = fixture(); value.plesk.available = true; value.plesk.position = { x: 130, y: 170 };
    value.state.nextEncounterAt = 0; change(value);
    advanceForestSocial(value.state, .1, { ...value.env(), builder: null, actors: [value.hero, value.plesk] });
    assert.equal(value.state.meeting, null); assert.equal(value.state.current, null);
  }
});

test("weather and local scenery filter whole stories without inventing a nearby river", () => {
  for (const weather of [{ dusk: 0, rain: 0 }, { dusk: 1, rain: 0 }, { dusk: 0, rain: 1 }]) {
    const value = fixture(); const baseEnv = value.env;
    value.env = () => ({ ...baseEnv(), ...weather });
    for (let iteration = 0; iteration < 18; iteration++) {
      reachMeeting(value);
      const topic = FOREST_CONVERSATIONS.find(item => item.id === value.state.topicHistory.at(-1));
      assert.ok(!topic.weather || topic.weather === "night" && weather.dusk > .55
        || topic.weather === "rain" && weather.rain > .35 || topic.weather === "day" && !weather.dusk && !weather.rain);
      assert.ok(!topic.place, "this fixture has no scenery near the two residents");
      cancelForestSocial(value.state, value.env());
    }
  }
});
