import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestSocial, noticeForestSocial, advanceForestSocial, forestSocialFrames,
  forestSocialHolding, forestSocialPartner, forestSocialWaitingHost, cancelForestSocial, FOREST_SOCIAL_LIMITS } = await vite.ssrLoadModule("/features/world/characters/social/forest-social.ts");
const { createBuilderMind, advanceBuilderMind, requestBuilderVisit, cancelBuilderVisit } = await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { builderLocalPlaces } = await vite.ssrLoadModule("/features/world/characters/builder/builder-navigation.ts");
const { canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { residentClearance } = await vite.ssrLoadModule("/features/world/navigation/resident-traffic.ts");
const { FOREST_ANIMAL_LINES, forestClickLines, forestAnimalLines } = await vite.ssrLoadModule("/features/world/characters/social/forest-social-dialogue.ts");
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
  assert.equal(FOREST_CONVERSATIONS.length, 78);
  assert.equal(new Set(FOREST_CONVERSATIONS.map(topic => topic.id)).size, 78);
  const lines = Object.values(FOREST_ANIMAL_LINES).flat();
  for (const pair of ["builder-mochlik", "builder-plesk", "mochlik-plesk"])
    assert.equal(FOREST_CONVERSATIONS.filter(topic => topic.pair === pair).length, 14);
  const allSpeakers = ["builder", "mochlik", "plesk", "lopukh", "kamneshmyg", "leaftail"];
  for (let index = 0; index < allSpeakers.length; index++) for (const other of allSpeakers.slice(index + 1)) {
    const pair = [allSpeakers[index], other];
    if (!pair.some(id => ["lopukh", "kamneshmyg", "leaftail"].includes(id))) continue;
    assert.equal(FOREST_CONVERSATIONS.filter(topic => pair.every(id => topic.pair.split("-").includes(id))).length, 3, pair.join("-"));
  }
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
  for (const id of allSpeakers) for (const context of ["idle", "walk", "build", "ready", "fish", "cook", "trade", "busy", "animal", "chop", "mine", "arrive"])
    lines.push(...forestClickLines(id, context));
  assert.ok(lines.every(line => line.length <= 42), "short captions fit a small character bubble");
  const value = fixture(); startMeeting(value); const before = { ...value.mind.position };
  cancelBuilderVisit(value.mind); assert.deepEqual(value.mind.position, before);
});

function visitorFixture(guestId = "lopukh", hostId = "leaftail") {
  const base = fixture(), guest = { id: guestId, position: { x: 50, y: 170 }, size: 42,
    visible: true, available: true, context: "idle" };
  const host = { ...guest, id: hostId, position: { x: 190, y: 170 } };
  const third = { ...guest, id: "mochlik", position: { x: 370, y: 260 }, available: false, context: "busy" };
  const calls = [], status = new Map();
  const env = { scene: base.scene, builder: null, actors: [guest, host, third], occupants: [guest, host, third],
    requestVisit(id, target, occupants) {
      calls.push(["request", id, target.id, occupants]);
      // Only this guest supports visits. A rejected alternative owns no route.
      if (id !== guestId) return false;
      status.set(id, "approach"); guest.context = "walk"; return true;
    },
    cancelVisit(id) { calls.push(["cancel", id]); status.delete(id); },
    visitStatus(id) { return status.get(id) ?? null; },
  };
  base.state.nextEncounterAt = 0;
  return { state: base.state, guest, host, third, calls, status, env,
    arrive() { guest.position = { x: host.position.x - (guest.size + host.size) * .56, y: host.position.y };
      guest.context = "idle"; status.set(guestId, "arrived"); } };
}

test("all six neighbours can exchange complete stories in either host orientation without commandeering Mochlik", () => {
  const ids = ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"];
  for (let index = 0; index < ids.length; index++) for (const other of ids.slice(index + 1)) for (const reverse of [false, true]) {
    const pair = reverse ? [other, ids[index]] : [ids[index], other], value = visitorFixture(...pair);
    value.guest.position = { x: 130, y: 170 };
    const env = { scene: value.env.scene, builder: null, actors: [value.guest, value.host] };
    advanceForestSocial(value.state, .1, env);
    assert.equal(value.state.meeting?.phase, "talk", pair.join("-"));
    assert.equal(forestSocialPartner(value.state, pair[0]), pair[1]);
    assert.equal(forestSocialPartner(value.state, pair[1]), pair[0]);
    assert.equal(forestSocialHolding(value.state), pair.includes("mochlik") ? "mochlik" : null);
    const topic = FOREST_CONVERSATIONS.find(item => item.id === value.state.topicHistory.at(-1));
    assert.deepEqual(topic.pair.split("-").sort(), pair.slice().sort());
    const spoken = [value.state.current.text];
    for (let age = 0; age < 32; age++) {
      advanceForestSocial(value.state, 1, env);
      if (value.state.current && spoken.at(-1) !== value.state.current.text) spoken.push(value.state.current.text);
    }
    assert.deepEqual(spoken, topic.lines.map(line => line.text));
    assert.equal(value.state.meeting, null);
  }
});

test("villager visitors use their own callback route and hold only their actual partner after arrival", () => {
  for (const id of ["lopukh", "kamneshmyg", "leaftail"]) {
    const value = visitorFixture(id, "plesk");
    advanceForestSocial(value.state, .1, value.env);
    assert.equal(value.state.meeting?.phase, "approach");
    assert.equal(value.state.meeting.guest, id); assert.equal(value.state.current, null);
    assert.equal(forestSocialHolding(value.state), null);
    assert.equal(forestSocialPartner(value.state, "plesk"), null);
    assert.equal(forestSocialWaitingHost(value.state), "plesk", "the host can wait at the agreed place during approach");
    assert.equal(value.calls[0][3], value.env.occupants);
    value.arrive(); advanceForestSocial(value.state, 0, value.env);
    assert.equal(value.state.meeting.phase, "talk");
    assert.equal(forestSocialPartner(value.state, "plesk"), id);
    assert.equal(forestSocialWaitingHost(value.state), null);
    assert.equal(forestSocialHolding(value.state), null);
    cancelForestSocial(value.state, value.env);
    assert.equal(value.status.size, 0); assert.deepEqual(value.calls.at(-1), ["cancel", id]);
  }
});

test("an approaching visitor never reserves the player hero and busy hosts release their waiting promise immediately", () => {
  const hero = visitorFixture("lopukh", "mochlik");
  advanceForestSocial(hero.state, .1, hero.env);
  assert.equal(hero.state.meeting?.phase, "approach");
  assert.equal(forestSocialWaitingHost(hero.state), null); assert.equal(forestSocialHolding(hero.state), null);
  const value = visitorFixture("kamneshmyg", "leaftail");
  advanceForestSocial(value.state, .1, value.env); assert.equal(forestSocialWaitingHost(value.state), "leaftail");
  value.host.available = false; value.host.context = "trade";
  advanceForestSocial(value.state, 0, value.env);
  assert.equal(forestSocialWaitingHost(value.state), null); assert.equal(value.state.meeting, null);
});

test("new neighbours answer actual animals in their own roles without increasing the shared chatter budget", () => {
  for (const id of ["lopukh", "kamneshmyg", "leaftail"]) for (const kind of ["butterfly", "firefly", "bird"]) {
    const value = visitorFixture(id, "plesk"); value.host.available = false;
    value.state.nextEncounterAt = Infinity; value.state.nextAnimalAt = 0;
    value.env.animalEvents = [{ id: "actual-individual-1", speaker: id, kind }];
    advanceForestSocial(value.state, .1, value.env);
    assert.ok(forestAnimalLines(id, kind).includes(value.state.current.text));
    assert.ok(forestAnimalLines(id, kind).every(line => line.length <= 42));
    assert.equal(value.state.nextAnimalAt, value.state.elapsed + FOREST_SOCIAL_LIMITS.animal);
    const first = value.state.current.id;
    for (let age = 0; age < 10; age++) {
      value.env.animalEvents = [{ id: `actual-individual-${age + 2}`, speaker: id, kind }];
      advanceForestSocial(value.state, 1, value.env);
      assert.ok(!value.state.current || value.state.current.id === first);
    }
    assert.equal(value.state.queue.length, 0);
  }
});

test("new villager visits immediately yield to jobs, hidden maps, manual moves and withdrawn visit ownership", () => {
  for (const arrive of [false, true]) for (const change of [
    value => { value.guest.available = false; value.guest.context = "mine"; },
    value => { value.host.available = false; value.host.context = "trade"; },
    value => { value.guest.visible = false; },
    value => { value.host.context = "sleep"; },
    value => { value.host.position = { x: 220, y: 210 }; },
    value => { value.env.enabled = false; },
    value => { value.env.ambient = false; },
    value => { value.status.clear(); },
  ]) {
    const value = visitorFixture("kamneshmyg", "leaftail");
    advanceForestSocial(value.state, .1, value.env);
    if (arrive) { value.arrive(); advanceForestSocial(value.state, 0, value.env); }
    change(value); const feet = structuredClone(value.guest.position);
    advanceForestSocial(value.state, 0, value.env);
    assert.equal(value.state.meeting, null); assert.equal(value.state.current, null);
    assert.equal(value.state.queue.length, 0); assert.deepEqual(value.guest.position, feet);
    assert.deepEqual(value.calls.at(-1), ["cancel", "kamneshmyg"]);
  }
});

test("new neighbours never speak through water or buildings, including a callback claiming unsafe arrival", () => {
  for (const visiting of [false, true]) {
    const value = visitorFixture("lopukh", "kamneshmyg");
    value.env.scene.navigation.obstacles = [{ id: "wall", points: rect(164, 0, 8, 280) }];
    if (visiting) {
      advanceForestSocial(value.state, .1, value.env);
      assert.equal(value.state.meeting?.phase, "approach");
      value.arrive(); advanceForestSocial(value.state, 0, value.env);
    } else {
      value.guest.position.x = 145;
      advanceForestSocial(value.state, .1, { scene: value.env.scene, builder: null, actors: [value.guest, value.host] });
    }
    assert.equal(value.state.meeting, null); assert.equal(value.state.current, null);
  }
});

test("unavailable workers and arrivals cannot be recruited and independent owners never inherit a visit", () => {
  for (const context of ["chop", "mine", "trade", "arrive", "sleep"]) {
    const value = visitorFixture(); value.guest.context = context; value.host.available = false;
    advanceForestSocial(value.state, .1, value.env);
    assert.equal(value.state.meeting, null); assert.equal(value.calls.length, 0);
  }
  const a = visitorFixture(), b = visitorFixture();
  advanceForestSocial(a.state, .1, a.env); a.arrive(); advanceForestSocial(a.state, 0, a.env);
  assert.ok(a.state.current); assert.equal(b.state.current, null); assert.equal(b.state.meeting, null);
  assert.deepEqual(b.calls, []);
});

test("new neighbours answer taps with their own trade, mining, woodcutting and arrival voice", () => {
  for (const [speaker, context] of [["lopukh", "chop"], ["kamneshmyg", "mine"], ["kamneshmyg", "arrive"], ["leaftail", "trade"]]) {
    const value = visitorFixture(speaker, "mochlik"); value.guest.context = context; value.guest.available = false;
    assert.equal(noticeForestSocial(value.state, speaker, value.env), true);
    assert.ok(forestClickLines(speaker, context).includes(value.state.current.text));
    assert.equal(value.state.current.origin, "interaction"); assert.deepEqual(value.calls, []);
    assert.equal(noticeForestSocial(value.state, speaker, value.env), false);
  }
  assert.notDeepEqual(forestClickLines("leaftail", "trade"), forestClickLines("plesk", "trade"));
});

test("a crowded six-resident idle window bounds navigation work and retains the quiet retry", () => {
  const value = fixture(); value.state.nextEncounterAt = 0;
  const ids = ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"];
  let requests = 0;
  const positions = [{ x: 20, y: 20 }, { x: 280, y: 20 }, { x: 150, y: 260 },
    { x: 140, y: 140 }, { x: 170, y: 140 }, { x: 110, y: 140 }];
  const actors = ids.map((id, index) => ({ ...value.hero, id, position: positions[index] }));
  const env = { scene: value.scene, builder: null, actors,
    requestVisit() { requests++; return false; }, cancelVisit() {}, visitStatus() { return null; } };
  advanceForestSocial(value.state, .1, env);
  assert.ok(requests <= FOREST_SOCIAL_LIMITS.navigationAttempts);
  assert.equal(value.state.meeting, null); assert.equal(value.state.current, null);
  const before = requests;
  for (let elapsed = 0; elapsed < 10; elapsed++) advanceForestSocial(value.state, 1, env);
  assert.equal(requests, before, "unreachable visits cannot run pathfinding every frame");
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
