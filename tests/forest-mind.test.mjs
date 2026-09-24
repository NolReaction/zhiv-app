import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createForestMind, advanceForestMind, scoreForestAction, beginForestIntention, finishForestIntention,
  noticeForestMind, restoreForestMind, forestMindFrame, recordForestCandidates } = await vite.ssrLoadModule("/features/world/forest-mind.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { advanceForestDirector, noticeForestDirector, requestForestDirective } = await vite.ssrLoadModule("/features/world/forest-director.ts");
const { chooseForestGoal, createForestBehavior } = await vite.ssrLoadModule("/features/world/forest-behavior.ts");
const calm = { moving: false, resting: false, sleeping: false, sheltered: false, rain: 0, dusk: 0, engaged: false, grooming: false };
const conditions = { autoLife: true, blocked: false, rain: 0, dusk: 0, homeAvailable: false };
const rectangle = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function session(override = {}) {
  const handle = connectForestSession(undefined, { schemaVersion: 1, id: "mind-fixture", width: 400, height: 400,
    terrain: [], sites: [], paths: [], habitats: [], water: { surfaces: [], exclusions: [] },
    actor: { spawn: { x: 200, y: 210 }, size: 40 }, focus: { x: 50, y: 50, width: 300, height: 300 },
    navigation: { version: 1, cellSize: 5, areas: [{ id: "clearing", points: rectangle(140, 145, 140, 140) }], obstacles: [],
      interests: [{ id: "flowers", activity: "sniff", position: { x: 250, y: 210 } },
        { id: "rest", activity: "rest", position: { x: 200, y: 250 } }] }, ...override,
  }, "circle", 0, 0, () => {});
  const state = handle.state; state.clearing.seed = 17; handle.release(); return state;
}
function advance(state, seconds, options = conditions) {
  for (let elapsed = 0; elapsed < seconds; elapsed += .025) advanceForestDirector(state, .025, options);
}

test("fatigue and curiosity change utility ranking rather than merely the status label", () => {
  const rested = createForestMind(), tired = createForestMind();
  tired.needs.energy = .08; tired.needs.curiosity = .12;
  const score = (mind, action) => scoreForestAction(mind, action, action, { rain: 0, dusk: 0 }).score;
  assert.ok(score(rested, "sniff") > score(rested, "rest"));
  assert.ok(score(tired, "rest") > score(tired, "sniff"));
  const dry = createForestMind(), wet = createForestMind(); wet.needs.comfort = .12;
  assert.ok(score(wet, "groom") > score(dry, "groom"));
});

test("actual walking spends energy, sleep restores it and weather changes comfort within bounds", () => {
  const walking = createForestMind(), sleeping = createForestMind(), rainy = createForestMind();
  sleeping.needs.energy = .1;
  for (let i = 0; i < 1200; i++) {
    advanceForestMind(walking, .1, { ...calm, moving: true });
    advanceForestMind(sleeping, .1, { ...calm, sleeping: true, sheltered: true });
    advanceForestMind(rainy, .1, { ...calm, rain: 1 });
  }
  assert.ok(walking.needs.energy < .66); assert.equal(sleeping.needs.energy, 1);
  assert.ok(rainy.needs.comfort < .4); assert.ok(sleeping.needs.comfort > .95);
  for (const mind of [walking, sleeping, rainy]) for (const need of Object.values(mind.needs)) assert.ok(need >= 0 && need <= 1);
});

test("a tap interrupts an intention and prevents both outdoor and home sleep for the wake grace", () => {
  const mind = createForestMind();
  beginForestIntention(mind, "rest", "grass", "Устал", "clearing"); mind.elapsed = 12;
  noticeForestMind(mind);
  assert.equal(mind.intention, null); assert.equal(mind.recent[0].outcome, "interrupted");
  assert.equal(mind.needs.attention, 1);
  for (const action of ["rest", "home-sleep"]) assert.equal(scoreForestAction(mind, action, action, { rain: 1, dusk: 1 }).available, false);
  mind.elapsed = mind.attentionUntil;
  assert.equal(scoreForestAction(mind, "home-sleep", "home", { rain: 1, dusk: 1 }).available, true);
});

test("completed, failed and interrupted activities leave bounded memory and reduce immediate repetitions", () => {
  const mind = createForestMind(), base = scoreForestAction(mind, "leaf", "leaf", { rain: 0, dusk: 0 }).score;
  for (let i = 0; i < 40; i++) {
    beginForestIntention(mind, "leaf", "leaf", "Рядом листик", "director");
    mind.elapsed += .5;
    finishForestIntention(mind, ["completed", "interrupted", "failed"][i % 3], "Закончил");
  }
  assert.equal(mind.recent.length, 16); assert.equal(mind.events.length, 24);
  assert.deepEqual(new Set(mind.recent.map(item => item.outcome)), new Set(["completed", "interrupted", "failed"]));
  assert.ok(scoreForestAction(mind, "leaf", "leaf", { rain: 0, dusk: 0 }).score < base);
});

test("restoration validates untrusted stored needs and never resumes a transient intention", () => {
  const restored = restoreForestMind({ elapsed: 40, needs: { energy: NaN, comfort: -4, attention: 2, curiosity: "invalid" },
    attentionUntil: 99999, intention: { action: "bush" }, candidates: [{ key: "unsafe" }],
    recent: [{ key: "flowers", action: "sniff", outcome: "completed", at: 30, duration: 2 },
      { key: "future", action: "rest", outcome: "completed", at: 200, duration: 0 },
      { key: "bad", action: "made-up", outcome: "completed", at: 20, duration: 2 }] });
  assert.deepEqual(restored.needs, { energy: .82, comfort: 0, attention: 1, curiosity: .58 });
  assert.equal(restored.attentionUntil, 70); assert.equal(restored.intention, null); assert.deepEqual(restored.candidates, []);
  assert.deepEqual(restored.recent.map(item => item.key), ["flowers"]); assert.equal(restored.events[0].type, "restored");
});

test("DEV read snapshots are detached from the live mind", () => {
  const mind = createForestMind();
  beginForestIntention(mind, "look", "flowers", "Осматривается", "clearing");
  recordForestCandidates(mind, [scoreForestAction(mind, "look", "flowers", { rain: 0, dusk: 0 })], "flowers");
  const copy = forestMindFrame(mind); copy.needs.energy = 0; copy.intention.key = "changed"; copy.events[0].reason = "changed";
  copy.candidates[0].reasons[0] = "changed";
  assert.equal(mind.needs.energy, .82); assert.equal(mind.intention.key, "flowers");
  assert.notEqual(mind.events[0].reason, "changed"); assert.notEqual(mind.candidates[0].reasons[0], "changed");
});

test("repeated grass samples and authored ID collisions keep one candidate and one selected identity", () => {
  const state = session(), navigation = state.clearing.navigation;
  const context = { position: { x: 170, y: 170 }, size: 40, elapsed: 0, awakeUntil: 0, dusk: 0, rain: 0, random: () => .5 };
  const sampled = createForestBehavior();
  chooseForestGoal(navigation, [], sampled, context);
  assert.equal(sampled.mind.candidates.length, 1);
  assert.equal(sampled.mind.candidates.filter(item => item.selected).length, 1);
  const id = sampled.mind.candidates[0].key;
  const authored = createForestBehavior(), first = { id, activity: "look", position: { x: 250, y: 210 } };
  const result = chooseForestGoal(navigation, [first, { id, activity: "rest", position: { x: 200, y: 250 } }], authored, context);
  assert.equal(authored.mind.candidates.length, 1);
  assert.equal(authored.mind.candidates.filter(item => item.selected).length, 1);
  assert.deepEqual(result.position, first.position, "the authored landmark owns its identity over later duplicates and grass samples");
});

test("the director owns one need clock through movement and pauses it with blocked, reduced or disabled life", () => {
  const state = session(), mind = state.clearing.behavior.mind;
  advance(state, 8);
  assert.ok(mind.elapsed > 7.9 && mind.elapsed < 8.1); assert.ok(mind.intention);
  const before = structuredClone({ elapsed: mind.elapsed, needs: mind.needs });
  for (const options of [{ ...conditions, blocked: true }, { ...conditions, reducedMotion: true }, { ...conditions, autoLife: false }]) {
    advance(state, 3, options); assert.deepEqual({ elapsed: mind.elapsed, needs: mind.needs }, before);
  }
});

test("an autonomous intention survives weather changes until completion and is recorded once", () => {
  const state = session(), mind = state.clearing.behavior.mind;
  advance(state, 4);
  assert.equal(state.clearing.stage, "free-walk");
  const first = mind.intention, key = first.key;
  advance(state, .5, { ...conditions, rain: .3, dusk: .3 });
  assert.equal(mind.intention, first);
  for (let i = 0; i < 2400 && !mind.recent.some(item => item.key === key && item.outcome === "completed"); i++) advanceForestDirector(state, .025, conditions);
  assert.equal(mind.recent.filter(item => item.key === key && item.outcome === "completed").length, 1);
  assert.ok(mind.candidates.every(item => item.reasons.length));
});

test("a tap during an autonomous walk gives attention without a false completion or immediate sleep", () => {
  const state = session(), mind = state.clearing.behavior.mind;
  advance(state, 4); const key = mind.intention.key;
  noticeForestDirector(state); advance(state, 2);
  assert.ok(mind.recent.some(item => item.key === key && item.outcome === "interrupted"));
  assert.equal(mind.recent.some(item => item.key === key && item.outcome === "completed"), false);
  assert.ok(mind.attentionUntil > mind.elapsed); assert.notEqual(state.clearing.stage, "home-sleep");
});

test("failed explicit encounters report the failure without rewarding curiosity", () => {
  const state = session(), mind = state.clearing.behavior.mind;
  const curiosity = mind.needs.curiosity;
  requestForestDirective(state, "butterfly", conditions); advance(state, .05);
  assert.ok(mind.recent.some(item => item.action === "butterfly" && item.outcome === "failed"));
  assert.ok(mind.needs.curiosity >= curiosity);
});

test("a tired resident chooses the real house, restores energy indoors and does not immediately sleep again after a tap", () => {
  const state = session({ sites: [{ id: "home", entry: { x: 225, y: 175 }, doorway: { x: 225, y: 155 },
    anchor: { x: 225, y: 168 }, spriteBounds: { x: 215, y: 140, width: 30, height: 28 },
    bounds: { x: 215, y: 140, width: 30, height: 28 }, collision: rectangle(215, 140, 30, 28) }] });
  const options = { ...conditions, homeAvailable: true }, mind = state.clearing.behavior.mind;
  mind.needs.energy = .08; mind.needs.curiosity = .1; state.director.nextDecisionAt = 0;
  advance(state, .025, options);
  assert.equal(mind.intention.action, "home-sleep");
  assert.ok(mind.candidates.find(item => item.action === "home-sleep").selected);
  for (let i = 0; i < 2400 && state.clearing.stage !== "home-sleep"; i++) advanceForestDirector(state, .025, options);
  assert.equal(state.clearing.stage, "home-sleep");
  const energy = mind.needs.energy; advance(state, 6, options); assert.ok(mind.needs.energy > energy);
  noticeForestDirector(state); advance(state, 24, options);
  assert.notEqual(state.clearing.stage, "home-sleep");
  assert.ok(mind.recent.some(item => item.action === "home-sleep" && item.outcome === "completed"));
  assert.ok(mind.attentionUntil > mind.elapsed);
});

test("a weather-aborted fauna encounter is remembered as interrupted, not completed", () => {
  const state = session({ habitats: [{ id: "butterflies", species: "butterfly", capacity: 3,
    points: rectangle(155, 140, 100, 95), anchors: [] }] });
  requestForestDirective(state, "butterfly", conditions); advance(state, .1);
  assert.ok(state.fauna.encounter);
  advance(state, 1, { ...conditions, rain: 1 });
  const encounters = state.clearing.behavior.mind.recent.filter(item => item.action === "butterfly");
  assert.deepEqual(encounters.map(item => item.outcome), ["interrupted"]);
});
