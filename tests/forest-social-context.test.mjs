import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestSocial, advanceForestSocial, requestForestSocialVisit, cancelForestSocial,
  forestSocialFollowupHolding } = await vite.ssrLoadModule("/features/world/characters/social/forest-social.ts");
const { eligibleForestConversations, observeForestSocialContext, rememberForestConversation,
  FOREST_SOCIAL_CONTEXT_LIMITS } = await vite.ssrLoadModule("/features/world/characters/social/forest-social-context.ts");
const { FOREST_CONVERSATIONS } = await vite.ssrLoadModule("/features/world/characters/social/forest-conversations.ts");
const { FOREST_CONTEXT_CONVERSATIONS } = await vite.ssrLoadModule("/features/world/characters/social/forest-context-conversations.ts");
const { queueForestSocialFollowup } = await vite.ssrLoadModule("/features/world/characters/social/forest-social-followup.ts");
const { forestClickLines, forestAnimalLines } = await vite.ssrLoadModule("/features/world/characters/social/forest-social-dialogue.ts");
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const scene = { id: "social-context", width: 500, height: 320, sites: [], paths: [], destinations: [],
  actor: { spawn: { x: 50, y: 170 }, size: 44 }, focus: { x: 0, y: 0, width: 500, height: 320 },
  navigation: { version: 1, cellSize: 6, areas: [{ id: "ground", points: rect(0, 0, 500, 320) }], obstacles: [], interests: [] } };
const actor = (id, patch = {}) => ({ id, position: { x: 150, y: 170 }, size: 44, visible: true, available: true, context: "idle", ...patch });
const topic = id => FOREST_CONVERSATIONS.find(item => item.id === id);
function fixture(seed = "context", guestId = "builder", hostId = "leaftail") {
  const state = createForestSocial(seed), guest = actor(guestId), host = actor(hostId, { position: { x: 190, y: 170 } });
  const env = { scene, builder: null, actors: [guest, host] };
  const calls = []; let status = null;
  Object.assign(env, { requestFollowup(request) { calls.push(["request", structuredClone(request)]); status = "approach"; return true; },
    cancelFollowup(id) { calls.push(["cancel", id]); status = null; }, followupStatus() { return status; } });
  return { state, guest, host, env, calls, arrive() { status = "arrived"; }, withdraw() { status = null; } };
}
function step(value, seconds) { for (let age = 0; age < seconds; age += .1) advanceForestSocial(value.state, .1, value.env); }
function eligible(value, purpose = "trade", followup = true) {
  return eligibleForestConversations(FOREST_CONVERSATIONS, value.state, value.guest, value.host, purpose, followup);
}

test("purposeful visits keep ordinary complete stories and have additional role-specific variants", () => {
  for (const purpose of ["fish", "trade", "window"]) {
    const value = fixture("context", "kamneshmyg", purpose === "fish" ? "plesk" : "leaftail");
    if (purpose === "window") Object.assign(value.host, { window: true, context: "trade", canReceiveVisit: true });
    const pool = eligible(value, purpose);
    assert.ok(pool.filter(item => item.purpose === purpose).length >= 2, purpose);
    if (purpose !== "window") assert.ok(pool.some(item => !item.purpose && !item.condition && !item.weather), "an idle outdoor host keeps ordinary complete stories");
    else assert.ok(pool.every(item => item.purpose === "window"), "an indoor window host never receives an outdoor-only story");
    assert.ok(pool.every(item => item.purpose !== "passing"));
  }
  assert.equal(FOREST_CONTEXT_CONVERSATIONS.length, 82);
  assert.equal(FOREST_CONVERSATIONS.reduce((sum, item) => sum + item.lines.length, 0), 712);
});

test("a receiving fisher and an indoor window host keep conversation content grounded in their actual activity", () => {
  for (const guest of ["mochlik", "builder", "lopukh", "kamneshmyg", "leaftail"]) {
    const value = fixture("fishing-content", guest, "plesk");
    Object.assign(value.host, { context: "fish", canReceiveVisit: true });
    const pool = eligible(value, "fish"); assert.ok(pool.length >= 2);
    assert.ok(pool.every(item => item.purpose === "fish" || item.condition === "fishing"));
    assert.ok(pool.every(item => /рыб|улов|снаст|корзин|леск|поплав|грузил|удоч|крюч|нажив/iu.test(item.lines.map(line => line.text).join(" "))));
    observeForestSocialContext(value.state, { events: [{ id: "actual-catch", kind: "fishing", speaker: "plesk" }] });
    assert.ok(eligible(value, "fish").some(item => item.condition === "fishing"));
  }
  for (const guest of ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg"]) {
    const value = fixture("window-content", guest, "leaftail");
    Object.assign(value.host, { context: "trade", canReceiveVisit: true, window: true });
    assert.ok(eligible(value, "window").every(item => item.purpose === "window"));
    value.host.window = false; value.host.context = "idle";
    assert.ok(eligible(value).some(item => !item.purpose && !item.condition && !item.weather), "ordinary stories return when the merchant walks outside");
  }
});

test("recent work and construction cannot be claimed from an idle pose or an absent/unrelated event", () => {
  for (const [kind, worker] of [["wood", "lopukh"], ["mining", "kamneshmyg"], ["fishing", "plesk"], ["construction", "builder"]]) {
    const value = fixture("facts", "mochlik", worker);
    assert.equal(eligible(value, "neighbour").some(item => item.condition === kind), false);
    const event = kind === "construction" ? { id: "actual-42", kind, siteId: "workshop", level: 2 }
      : { id: "actual-42", kind, speaker: worker };
    observeForestSocialContext(value.state, { events: [event] });
    const pool = eligible(value, "neighbour"), story = pool.find(item => item.condition === kind);
    assert.ok(story, kind); const before = structuredClone(event);
    rememberForestConversation(value.state, story, value.guest.id, value.host.id);
    assert.deepEqual(event, before, "confirmed context is readonly");
    assert.equal(eligible(value, "neighbour").some(item => item.condition === kind), false, "one real event is not endlessly retold to the same pair");
    observeForestSocialContext(value.state, { events: [event] }); assert.equal(value.state.contextFacts.length, 1);
    assert.equal(value.state.eventStoryHistory.length, 1);
    const unrelated = fixture("unrelated", "mochlik", "leaftail");
    observeForestSocialContext(unrelated.state, { events: [event] });
    if (kind !== "construction") assert.equal(eligible(unrelated).some(item => item.condition === kind), false);
  }
});

test("event facts expire on active time, reject malformed input and keep bounded session-only memory", () => {
  const value = fixture();
  observeForestSocialContext(value.state, { events: [null, { id: "", kind: "wood", speaker: "lopukh" },
    { id: "bad", kind: "construction", siteId: "home", level: NaN }, { id: "alien", kind: "mining", speaker: "alien" }] });
  assert.equal(value.state.contextFacts.length, 0);
  for (let index = 0; index < 70; index++) observeForestSocialContext(value.state, { events: [
    { id: `work-${index}`, kind: "wood", speaker: "lopukh" }] });
  assert.equal(value.state.contextFacts.length, FOREST_SOCIAL_CONTEXT_LIMITS.facts);
  assert.equal(value.state.seenContextFacts.length, FOREST_SOCIAL_CONTEXT_LIMITS.seenFacts);
  const snapshot = structuredClone(value.state.contextFacts); advanceForestSocial(value.state, 86400, value.env);
  assert.equal(value.state.elapsed, 1); assert.deepEqual(value.state.contextFacts, snapshot, "offline elapsed never ages a full day of dialogue facts");
  value.state.elapsed = FOREST_SOCIAL_CONTEXT_LIMITS.factLife + 1; observeForestSocialContext(value.state);
  assert.deepEqual(value.state.contextFacts, []); assert.deepEqual(createForestSocial("other-owner").contextFacts, []);
});

test("pair memory is specific, bounded and permits a familiar crossing only after a real exchange", () => {
  const value = fixture("pair", "lopukh", "kamneshmyg");
  assert.equal(eligible(value, "passing").some(item => item.condition === "recent-pair"), false);
  const story = topic("passing-lopukh-kamneshmyg"); rememberForestConversation(value.state, story, "lopukh", "kamneshmyg");
  assert.equal(eligible(value, "passing").some(item => item.condition === "recent-pair"), true);
  assert.equal(eligible(value, "passing").every(item => item.lines.length === 2), true);
  value.state.elapsed = 601; assert.equal(eligible(value, "passing").some(item => item.condition === "recent-pair"), false);
  for (const item of FOREST_CONVERSATIONS) rememberForestConversation(value.state, item, ...item.pair.split("-"));
  assert.equal(value.state.pairMemories.length, 15);
  assert.ok(value.state.pairMemories.every(item => item.topics.length <= 3));
});

test("rain and night can lead purposeful visits but never appear under incompatible weather", () => {
  const chosen = new Set();
  for (const [weather, context] of [["rain", { rain: .5 }], ["night", { dusk: .65 }]]) {
    let seen = 0;
    for (let seed = 0; seed < 20; seed++) {
      const value = fixture(seed, "lopukh", "plesk"); Object.assign(value.env, context);
      assert.equal(requestForestSocialVisit(value.state, "lopukh", "plesk", value.env), true);
      const script = topic(value.state.topicHistory.at(-1)); chosen.add(script.id);
      if (script.weather === weather) seen++;
    }
    assert.ok(seen >= 10, `${weather} contextual variety should usually lead the exchange, saw ${seen}/20`);
  }
  for (let seed = 0; seed < 20; seed++) {
    const value = fixture(seed, "lopukh", "plesk"); requestForestSocialVisit(value.state, "lopukh", "plesk", value.env);
    assert.notEqual(topic(value.state.topicHistory.at(-1)).weather, "rain");
    assert.notEqual(topic(value.state.topicHistory.at(-1)).weather, "night");
  }
  assert.ok(chosen.size >= 3);
});

test("a completed window promise starts one checked followup only after all replies finish", () => {
  const value = fixture(); Object.assign(value.host, { window: true, context: "trade", canReceiveVisit: true,
    approach: { ...value.guest.position } });
  // Preserve all routing and complete-script behavior while making this test's
  // authored promise deterministic among the intentionally larger topic pool.
  const alternatives = eligible(value, "window").filter(item => item.id !== "window-builder-leaftail");
  value.state.topicHistory = alternatives.map(item => item.id);
  assert.equal(requestForestSocialVisit(value.state, "builder", "leaftail", value.env), true);
  assert.equal(value.state.meeting.topicId, "window-builder-leaftail");
  assert.equal(value.calls.length, 0); assert.equal(value.state.followup, null);
  for (let age = 0; age < 30 && value.state.meeting; age += .1) advanceForestSocial(value.state, .1, value.env);
  assert.equal(value.state.lastMeetingResult.status, "completed");
  assert.equal(value.calls.filter(item => item[0] === "request").length, 1);
  assert.equal(value.state.followup.phase, "approach"); assert.equal(forestSocialFollowupHolding(value.state, "builder"), false);
  value.arrive(); advanceForestSocial(value.state, 0, value.env);
  assert.equal(forestSocialFollowupHolding(value.state, "builder"), true);
  assert.equal(value.state.lastFollowupResult, undefined, "inspection must spend actual active time at the destination");
  step(value, 3.1); assert.equal(value.state.followup, null); assert.equal(value.state.lastFollowupResult.status, "completed");
  assert.equal(value.calls.filter(item => item[0] === "cancel").length, 1);
  assert.ok(eligible(value, "window").some(item => item.condition === "window-inspected"));
  assert.equal(eligible(value, "window").some(item => item.id === "window-builder-leaftail"), false, "the same promise never creates a conversation-walk loop");
});

test("interrupted conversations make no promise; missing adapters cannot offer an impossible followup", () => {
  const value = fixture(); delete value.env.requestFollowup;
  assert.equal(eligible(value, "window", false).some(item => item.followup), false);
  value.state.meeting = { guest: "builder", host: "leaftail", phase: "talk", visit: null, purpose: "window", topicId: "window-builder-leaftail", age: 0,
    anchor: value.host.position, guestAnchor: value.guest.position };
  cancelForestSocial(value.state, value.env); assert.equal(value.state.followup, null); assert.equal(value.calls.length, 0);
  assert.equal(value.state.lastMeetingResult.status, "interrupted");
});

test("followups yield at zero time to work, doors, player cancellation and lost checked-route ownership", () => {
  for (const interrupt of [value => { value.guest.available = false; }, value => { value.guest.visible = false; },
    value => { value.guest.context = "build"; }, value => { value.env.ambient = false; }, value => { value.env.enabled = false; },
    value => { value.env.dusk = .9; }, value => { value.env.rain = .8; }, value => value.withdraw()]) {
    for (const arrived of [false, true]) {
      const value = fixture("preempt", "lopukh", "leaftail"); queueForestSocialFollowup(value.state, topic("trade-lopukh-leaftail"));
      advanceForestSocial(value.state, 0, value.env); if (arrived) { value.arrive(); advanceForestSocial(value.state, 0, value.env); }
      const age = value.state.elapsed; interrupt(value); advanceForestSocial(value.state, 0, value.env);
      assert.equal(value.state.followup, null); assert.equal(value.state.lastFollowupResult.status, "interrupted");
      assert.equal(value.state.elapsed, age); assert.equal(forestSocialFollowupHolding(value.state, "lopukh"), false);
    }
  }
  const manual = fixture(); queueForestSocialFollowup(manual.state, topic("window-builder-leaftail"));
  cancelForestSocial(manual.state, manual.env); assert.equal(manual.state.followup, null);
});

test("blocked followups have a finite retry/approach budget and never report a repair or resource award", () => {
  const value = fixture("blocked", "lopukh", "leaftail"); queueForestSocialFollowup(value.state, topic("trade-lopukh-leaftail"));
  step(value, 46); assert.equal(value.state.followup, null); assert.equal(value.state.lastFollowupResult.status, "blocked");
  assert.equal(value.calls.filter(item => item[0] === "request").length, 1); assert.equal(value.state.sequence, 0);
  assert.equal(eligible(value).some(item => item.condition === "woodpile-checked"), false);
  assert.equal(eligible(value).some(item => item.id === "trade-lopukh-leaftail"), false);
  assert.deepEqual(Object.keys(value.state).filter(key => /reward|inventory|wallet|coins/i.test(key)), []);
});

test("the miner's direct and animal captions match his free-handed artwork", () => {
  const lines = ["idle", "walk", "mine", "ready", "arrive", "busy"].flatMap(context => forestClickLines("kamneshmyg", context));
  for (const kind of ["butterfly", "firefly", "bird"]) lines.push(...forestAnimalLines("kamneshmyg", kind));
  assert.ok(lines.every(line => !/кирк/iu.test(line))); assert.ok(lines.some(line => /шлем/iu.test(line)));
});
