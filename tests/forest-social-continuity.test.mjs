import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = name => vite.ssrLoadModule(`/features/world/characters/social/${name}.ts`);
const { createForestSocial, advanceForestSocial, cancelForestSocial, requestForestSocialVisit } = await load("forest-social");
const { eligibleForestConversations, observeForestSocialContext } = await load("forest-social-context");
const { queueForestSocialFollowup, finishForestSocialFollowup } = await load("forest-social-followup");
const { forestConversationOutcome, pruneForestPromiseOutcomes, FOREST_SOCIAL_CONTINUITY_LIMITS } = await load("forest-social-continuity");
const { FOREST_CONVERSATIONS } = await load("forest-conversations");
const topic = id => FOREST_CONVERSATIONS.find(item => item.id === id);
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const scene = { id: "continuity", width: 400, height: 280, sites: [], paths: [], destinations: [],
  actor: { spawn: { x: 50, y: 170 }, size: 44 }, focus: { x: 0, y: 0, width: 400, height: 280 },
  navigation: { version: 1, cellSize: 6, areas: [{ id: "land", points: rect(0, 0, 400, 280) }], obstacles: [], interests: [] } };
function fixture(speaker = "builder", state = createForestSocial(`continuity-${speaker}`)) {
  const guest = { id: speaker, position: { x: 150, y: 170 }, size: 44, visible: true, available: true, context: "idle" };
  const host = { ...guest, id: "leaftail", position: { x: 190, y: 130 }, approach: { ...guest.position }, window: true,
    context: "trade", canReceiveVisit: true };
  const calls = []; let status = null;
  const env = { scene, builder: null, actors: [guest, host], requestFollowup(request) { calls.push(["request", request.id]); status = "approach"; return true; },
    cancelFollowup(id) { calls.push(["cancel", id]); status = null; }, followupStatus() { return status; } };
  state.nextEncounterAt = Infinity;
  return { state, guest, host, env, calls, arrive() { status = "arrived"; } };
}
function step(value, seconds) { for (let at = 0; at < seconds - 1e-6; at += .1) advanceForestSocial(value.state, .1, value.env); }
function pool(value) { return eligibleForestConversations(FOREST_CONVERSATIONS, value.state, value.guest, value.host, "window", true); }
function forceTopic(value, id) {
  value.state.topicHistory = pool(value).filter(item => item.id !== id).map(item => item.id);
  value.state.pairMemories = [];
  assert.equal(requestForestSocialVisit(value.state, value.guest.id, "leaftail", value.env), true);
  assert.equal(value.state.meeting.topicId, id);
}
function finishTalk(value) {
  for (let at = 0; at < 32 && value.state.meeting; at += .1) advanceForestSocial(value.state, .1, value.env);
  assert.equal(value.state.meeting, null);
}
function completeInspection(value, promise = value.guest.id === "builder" ? "window-builder-leaftail" : "window-lopukh-leaftail") {
  value.state.sequence++;
  queueForestSocialFollowup(value.state, topic(promise));
  advanceForestSocial(value.state, 0, value.env); assert.equal(value.state.followup.phase, "approach");
  value.arrive(); advanceForestSocial(value.state, 0, value.env); assert.equal(value.state.followup.phase, "inspect");
  step(value, 3.1); assert.equal(value.state.followup, null);
  return value.state.promiseOutcomes.at(-1);
}

test("the actual completed promise, checked arrival and timed inspection are needed before its pair can continue", () => {
  const value = fixture(), continuation = topic("window-builder-remembered");
  assert.equal(forestConversationOutcome(continuation, value.state, "builder", "leaftail"), undefined);
  forceTopic(value, "window-builder-leaftail"); step(value, 1);
  assert.deepEqual(value.state.promiseOutcomes, [], "speaking a promise is not proof of its completion");
  finishTalk(value); assert.equal(value.state.followup.phase, "approach"); assert.deepEqual(value.state.promiseOutcomes, []);
  value.arrive(); advanceForestSocial(value.state, 0, value.env); step(value, 2);
  assert.deepEqual(value.state.promiseOutcomes, [], "being at the window briefly is not yet the completed inspection");
  step(value, 1.1);
  const outcome = forestConversationOutcome(continuation, value.state, "builder", "leaftail");
  assert.equal(outcome.status, "completed"); assert.equal(outcome.pair, "builder:leaftail"); assert.equal(outcome.topicId, "window-builder-leaftail");
  assert.equal(outcome.consumedAt, undefined); assert.ok(pool(value).includes(continuation));
});

test("another pair and the global last result cannot fabricate, overwrite or steal an inspection continuation", () => {
  const builder = fixture(), builderOutcome = completeInspection(builder);
  const rabbit = fixture("lopukh", builder.state), rabbitOutcome = completeInspection(rabbit);
  assert.equal(builder.state.lastFollowupResult.kind, "check-woodpile");
  assert.equal(forestConversationOutcome(topic("window-builder-remembered"), builder.state, "builder", "leaftail").id, builderOutcome.id);
  assert.equal(forestConversationOutcome(topic("window-woodpile-lopukh-remembered"), rabbit.state, "leaftail", "lopukh").id, rabbitOutcome.id);
  const borrowed = { ...topic("window-builder-remembered"), pair: "mochlik-leaftail" };
  assert.equal(forestConversationOutcome(borrowed, builder.state, "mochlik", "leaftail"), undefined);
  const cold = fixture(); cold.state.lastFollowupResult = { speaker: "builder", kind: "inspect-window", status: "completed", at: 0 };
  assert.equal(pool(cold).some(item => item.id === "window-builder-remembered"), false, "the diagnostic last result is no longer sufficient evidence");
});

test("a continuation is consumed once only after every reply; an interrupted acknowledgement can continue later", () => {
  const value = fixture(), outcome = completeInspection(value);
  forceTopic(value, "window-builder-remembered");
  assert.equal(value.state.meeting.continuationId, outcome.id); assert.equal(outcome.consumedAt, undefined);
  step(value, 1); cancelForestSocial(value.state, value.env);
  assert.equal(outcome.consumedAt, undefined); assert.ok(pool(value).some(item => item.id === "window-builder-remembered"));
  forceTopic(value, "window-builder-remembered"); finishTalk(value);
  assert.equal(outcome.consumedAt, value.state.elapsed); assert.equal(value.state.followup, null, "acknowledgement never creates another promise walk");
  assert.equal(pool(value).some(item => item.id === "window-builder-remembered"), false);
  value.state.topicHistory = []; value.state.pairMemories = [];
  assert.equal(pool(value).some(item => item.id === "window-builder-remembered"), false, "forgetting old topic IDs cannot resurrect a consumed outcome");
});

test("cancelled promises cannot thank a completed repair or inspection, and an aborted source conversation creates no outcome", () => {
  const aborted = fixture(); forceTopic(aborted, "window-builder-leaftail"); step(aborted, 1); cancelForestSocial(aborted.state, aborted.env);
  assert.deepEqual(aborted.state.promiseOutcomes, []); assert.equal(aborted.state.followup, null);
  for (const interrupt of [value => { value.guest.available = false; }, value => { value.env.enabled = false; }, value => { value.env.rain = .8; }]) {
    const value = fixture(); queueForestSocialFollowup(value.state, topic("window-builder-leaftail"));
    advanceForestSocial(value.state, 0, value.env); interrupt(value); advanceForestSocial(value.state, 0, value.env);
    const outcome = value.state.promiseOutcomes.at(-1); assert.equal(outcome.status, "interrupted");
    assert.equal(pool(value).some(item => item.id === "window-builder-remembered"), false);
    assert.ok(pool(value).some(item => item.id === "window-builder-unfinished"));
    assert.equal(outcome.consumedAt, undefined);
  }
});

test("a later successful action supersedes the old unfinished promise and cannot revive its older failure", () => {
  const value = fixture("lopukh"); value.state.sequence++;
  queueForestSocialFollowup(value.state, topic("window-lopukh-leaftail")); advanceForestSocial(value.state, 0, value.env);
  finishForestSocialFollowup(value.state, value.env, "blocked");
  assert.ok(pool(value).some(item => item.id === "window-woodpile-lopukh-unfinished"));
  const completed = completeInspection(value);
  assert.equal(pool(value).some(item => item.id === "window-woodpile-lopukh-unfinished"), false);
  forceTopic(value, "window-woodpile-lopukh-remembered"); finishTalk(value); assert.ok(completed.consumedAt > 0);
  assert.equal(pool(value).some(item => item.continuation?.result === "unfinished" || item.condition === "woodpile-checked"), false);
});

test("outcomes are bounded primitive session records, expire on the owner active clock and clone without sharing", () => {
  const value = fixture("lopukh");
  for (let index = 0; index < 25; index++) {
    value.state.sequence++; queueForestSocialFollowup(value.state, topic("window-lopukh-leaftail"));
    advanceForestSocial(value.state, 0, value.env); finishForestSocialFollowup(value.state, value.env, "blocked");
  }
  assert.equal(value.state.promiseOutcomes.length, FOREST_SOCIAL_CONTINUITY_LIMITS.outcomes);
  assert.ok(value.state.promiseOutcomes.every(item => Object.values(item).every(field => ["string", "number"].includes(typeof field))));
  const clone = structuredClone(value.state); clone.promiseOutcomes[0].consumedAt = 10;
  assert.equal(value.state.promiseOutcomes[0].consumedAt, undefined);
  assert.deepEqual(createForestSocial("another-account").promiseOutcomes, []);
  advanceForestSocial(value.state, 86400, value.env); assert.equal(value.state.elapsed, 1);
  assert.equal(value.state.promiseOutcomes.length, 8, "an offline day cannot become an active day of continuation time");
  value.state.elapsed = 600; pruneForestPromiseOutcomes(value.state);
  assert.deepEqual(value.state.promiseOutcomes, []); assert.equal(pool(value).some(item => item.continuation), false);
});

test("invalid promise participants and an unobserved immediate completion cannot manufacture continuity", () => {
  const value = fixture(), invalid = { ...topic("window-builder-leaftail"), pair: "mochlik-leaftail" };
  queueForestSocialFollowup(value.state, invalid); assert.equal(value.state.followup, null);
  queueForestSocialFollowup(value.state, topic("window-builder-leaftail"), ["mochlik", "leaftail"]);
  assert.equal(value.state.followup, null);
  queueForestSocialFollowup(value.state, topic("window-builder-leaftail"));
  finishForestSocialFollowup(value.state, value.env, "completed"); assert.deepEqual(value.state.promiseOutcomes, []);
});


test("a real unacknowledged outcome takes priority over the same topic ID in ordinary short memory", () => {
  for (let seed = 0; seed < 8; seed++) {
    const value = fixture("builder", createForestSocial(seed)), outcome = completeInspection(value);
    value.state.topicHistory = ["window-builder-remembered"];
    value.state.pairMemories = [{ pair: "builder:leaftail", at: value.state.elapsed, topics: ["window-builder-remembered"] }];
    assert.equal(requestForestSocialVisit(value.state, "builder", "leaftail", value.env), true);
    assert.equal(value.state.meeting.topicId, "window-builder-remembered");
    assert.equal(value.state.meeting.continuationId, outcome.id);
    finishTalk(value); assert.notEqual(outcome.consumedAt, undefined);
  }
});

test("observation sanitizes expired, mismatched, duplicate and malformed outcome records before selection", () => {
  const value = fixture(); value.state.elapsed = 700;
  const valid = { id: "actual", pair: "builder:leaftail", speaker: "builder", host: "leaftail", kind: "inspect-window",
    status: "completed", topicId: "window-builder-leaftail", at: 650 };
  value.state.promiseOutcomes = [null, { ...valid, id: "stale", at: 0 }, { ...valid, id: "future", at: 701 },
    { ...valid, id: "wrong-pair", pair: "leaftail:mochlik" }, { ...valid, id: "wrong-kind", kind: "check-woodpile" },
    { ...valid, id: "bad-status", status: "assumed" }, { ...valid, id: "bad-time", consumedAt: NaN },
    { ...valid, id: "bad-topic", topicId: "" }, { ...valid, id: "actual", at: 640 }, valid];
  observeForestSocialContext(value.state);
  assert.deepEqual(value.state.promiseOutcomes, [valid]);
  assert.equal(forestConversationOutcome(topic("window-builder-remembered"), value.state, "builder", "leaftail").at, 650);
});
