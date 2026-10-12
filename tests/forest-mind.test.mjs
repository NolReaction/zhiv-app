import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createForestMind, advanceForestMind, scoreForestAction, beginForestIntention, finishForestIntention,
  noticeForestMind, restoreForestMind, forestMindFrame, forestMindMotives, recordForestCandidates } = await vite.ssrLoadModule("/features/world/simulation/forest-mind.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { advanceForestDirector, noticeForestDirector, requestForestDirective } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { chooseForestGoal, createForestBehavior } = await vite.ssrLoadModule("/features/world/simulation/forest-behavior.ts");
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

test("useful garden care competes with idle but yields to fatigue, weather and recent player attention", () => {
  const rested = createForestMind(), tired = createForestMind();
  tired.needs.energy = .08;
  const score = (mind, action, weather = {}) => scoreForestAction(mind, action, action, { rain: 0, dusk: 0, ...weather });
  for (const action of ["water-bush", "harvest-berries"]) {
    const ready = score(rested, action);
    assert.ok(ready.score > score(rested, "idle").score);
    assert.ok(score(tired, "home-sleep").score > score(tired, action).score + 2);
    assert.ok(score(rested, action, { rain: 1 }).score < ready.score);
    assert.ok(score(rested, action, { dusk: 1 }).score < ready.score);
    const called = structuredClone(rested); called.needs.attention = 1;
    assert.ok(score(called, action).score < ready.score);
    assert.match(ready.reasons.join(" "), /Кусту|Ягоды/);
  }
});

test("finishing garden care calms activation without granting energy, and failure grants no satisfaction", () => {
  for (const action of ["water-bush", "harvest-berries"]) {
    for (const outcome of ["completed", "interrupted", "failed"]) {
      const mind = createForestMind(); mind.arousal = .8;
      beginForestIntention(mind, action, `${action}:clearing-bush`, "Куст рядом", "director");
      mind.elapsed = 14;
      const needs = { ...mind.needs };
      finishForestIntention(mind, outcome, "Закончил попытку");
      assert.deepEqual(mind.needs, needs, "garden care must not create rest, food or grooming rewards");
      assert.equal(forestMindMotives(mind).saturation, 0, "care is not a new wildlife impression");
      if (outcome === "completed") assert.ok(mind.arousal < .8 && mind.arousal > .22);
      else assert.equal(mind.arousal, .8);
      const restored = restoreForestMind(mind);
      assert.equal(restored.recent[0].action, action);
      assert.equal(restored.recent[0].outcome, outcome);
    }
    const quiet = createForestMind(); quiet.arousal = .1;
    beginForestIntention(quiet, action, action, "Куст рядом", "director");
    finishForestIntention(quiet, "completed", "Закончил");
    assert.equal(quiet.arousal, .1, "satisfaction must not excite an already calm resident");
  }
});

test("needed recovery survives recent completed rests while failed and interrupted rest routes retain cooldown", () => {
  for (const action of ["rest", "home-sleep"]) {
    const tired = createForestMind(); tired.needs.energy = .08;
    tired.recent = Array.from({ length: 3 }, (_, index) => ({ key: action, action, outcome: "completed", at: 0, duration: 6 + index }));
    const score = (mind, candidate) => scoreForestAction(mind, candidate, candidate, { rain: 0, dusk: 0 });
    const recovery = score(tired, action);
    assert.ok(recovery.score > score(tired, "water-bush").score + 2);
    assert.ok(recovery.score > score(tired, "leaf").score + 2);
    assert.match(recovery.reasons.join(" "), /отдыха не хватило/);
    for (const outcome of ["failed", "interrupted"]) {
      const blocked = structuredClone(tired);
      blocked.recent = blocked.recent.map(item => ({ ...item, outcome }));
      assert.ok(score(blocked, action).score < recovery.score - 5, "do not repeatedly retry a broken rest route");
    }
    const rested = structuredClone(tired); rested.needs.energy = .82;
    assert.ok(score(rested, action).score < score({ ...rested, recent: [] }, action).score - 5);
  }
});

test("ten minutes of decisions mix available garden work with leisure and recovery without exhausting interest", () => {
  for (const seed of [17, 82, 1337]) {
    const mind = createForestMind(); mind.needs.energy = .43;
    const counts = new Map(), lastCare = { "water-bush": -100, "harvest-berries": -180 };
    let randomState = seed, next = 0, active = "idle", duration = 0;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
    for (let frame = 0; frame < 6000; frame++) {
      if (mind.elapsed + .001 >= next) {
        if (mind.intention) {
          finishForestIntention(mind, "completed", "Закончил занятие");
          counts.set(active, (counts.get(active) ?? 0) + 1);
          if (active in lastCare) lastCare[active] = mind.elapsed;
        }
        const available = ["look", "sniff", "leaf", "rest"];
        if (mind.needs.energy > .4) {
          if (mind.elapsed - lastCare["water-bush"] >= 90) available.push("water-bush");
          if (mind.elapsed - lastCare["harvest-berries"] >= 180) available.push("harvest-berries");
        }
        const selected = available.map(action => scoreForestAction(mind, action, action, { rain: 0, dusk: 0, noise: random() * .3 }))
          .sort((a, b) => b.score - a.score)[0];
        active = selected.action;
        duration = active === "rest" ? 15 : active === "harvest-berries" ? 20 : active === "water-bush" ? 14 : 10;
        next = mind.elapsed + duration;
        beginForestIntention(mind, active, active, selected.reasons[0], "director");
      }
      const moving = active !== "rest" && mind.elapsed - mind.intention.startedAt < 4;
      advanceForestMind(mind, .1, { ...calm, moving, engaged: active !== "rest" && !moving, resting: active === "rest" });
      assert.ok(mind.needs.energy > .1, `care must not drive exhaustion: seed=${seed}`);
      assert.ok(mind.needs.curiosity > .15, `interest must remain responsive: seed=${seed}`);
    }
    for (const action of ["water-bush", "harvest-berries", "rest"]) assert.ok((counts.get(action) ?? 0) >= 2,
      `expected recurring ${action}, got ${JSON.stringify([...counts])}, seed=${seed}`);
    assert.ok(counts.size >= 5);
    assert.ok(mind.needs.energy > .3 && mind.needs.curiosity > .2);
  }
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

test("interesting activity satisfies curiosity while grooming and walks revive it, including an old zero", () => {
  const exploring = createForestMind(), grooming = createForestMind(), walking = createForestMind();
  beginForestIntention(exploring, "sniff", "flowers", "Изучает цветы", "clearing");
  beginForestIntention(grooming, "groom", "care", "Приводит себя в порядок", "clearing");
  walking.needs.curiosity = 0;
  for (let i = 0; i < 1200; i++) {
    advanceForestMind(exploring, .1, { ...calm, engaged: true });
    advanceForestMind(grooming, .1, { ...calm, engaged: true, grooming: true });
    advanceForestMind(walking, .1, { ...calm, moving: true });
  }
  assert.ok(exploring.needs.curiosity > .2 && exploring.needs.curiosity < .4);
  assert.ok(grooming.needs.curiosity > .7, "care poses must not masquerade as new impressions");
  assert.ok(walking.needs.curiosity > .45, "a stored zero must recover through ordinary active life");
});

test("activation responds to actual movement, rain, quiet and taps and changes quiet versus lively choices", () => {
  const walking = createForestMind(), quiet = createForestMind(), wet = createForestMind();
  for (let i = 0; i < 400; i++) {
    advanceForestMind(walking, .1, { ...calm, moving: true });
    advanceForestMind(quiet, .1, { ...calm, resting: true, sheltered: true });
    advanceForestMind(wet, .1, { ...calm, rain: 1 });
  }
  assert.ok(walking.arousal > wet.arousal && wet.arousal > quiet.arousal);
  const mind = createForestMind(), score = action => scoreForestAction(mind, action, action, { rain: 0, dusk: 0 });
  mind.arousal = .1; assert.ok(score("leaf").score > score("mushroom").score);
  mind.arousal = .9; assert.ok(score("mushroom").score > score("leaf").score);
  assert.match(score("mushroom").reasons.join(" "), /спокойному/);
  mind.needs.energy = .05;
  assert.ok(score("home-sleep").score > score("mushroom").score, "tempo cannot outweigh severe fatigue");
  noticeForestMind(quiet); assert.ok(quiet.arousal >= .7);
  assert.equal(scoreForestAction(quiet, "rest", "rest", { rain: 0, dusk: 0 }).available, false);
});

test("completed impressions favor quieter activities, while failed and interrupted attempts do not satisfy them", () => {
  const completed = createForestMind(), failed = createForestMind();
  const history = ["leaf", "sniff", "look"].map((action, index) => ({ key: `earlier-${index}`, action, at: 0, duration: 8, outcome: "completed" }));
  completed.recent = history;
  failed.recent = history.map((item, index) => ({ ...item, outcome: index % 2 ? "failed" : "interrupted" }));
  assert.ok(forestMindMotives(completed).saturation > .7);
  assert.equal(forestMindMotives(completed).variety, 0, "three different families are already varied");
  assert.equal(forestMindMotives(failed).saturation, 0); assert.equal(forestMindMotives(failed).variety, 0);
  const score = (mind, action) => scoreForestAction(mind, action, `new-${action}`, { rain: 0, dusk: 0 });
  assert.ok(score(completed, "firefly").score > score(failed, "firefly").score);
  assert.ok(score(completed, "butterfly").score < score(failed, "butterfly").score);
  assert.match(score(completed, "firefly").reasons.join(" "), /впечатлений/);
  const before = structuredClone(completed);
  score(completed, "leaf"); forestMindMotives(completed);
  assert.deepEqual(completed, before, "scoring and diagnostics are read-only");
  completed.elapsed = 121;
  assert.equal(forestMindMotives(completed).saturation, 0);
});

test("family repetition adds a wish for variety without suppressing necessary rest", () => {
  const repeated = createForestMind(), failed = createForestMind();
  repeated.recent = Array.from({ length: 4 }, (_, index) => ({ key: `care-${index}`, action: "groom", at: 0, duration: 5, outcome: "completed" }));
  failed.recent = repeated.recent.map(item => ({ ...item, outcome: "failed" }));
  assert.deepEqual(forestMindMotives(repeated), { arousal: .244, saturation: 0, variety: 1 });
  const score = (mind, action) => scoreForestAction(mind, action, `new-${action}`, { rain: 0, dusk: 0 });
  assert.ok(score(repeated, "groom").score < score(failed, "groom").score);
  assert.ok(score(repeated, "sniff").score > score(failed, "sniff").score);
  assert.match(score(repeated, "sniff").reasons.join(" "), /разнообразие/);
  assert.equal(score(repeated, "rest").score, score(failed, "rest").score);
  repeated.elapsed = 121; assert.equal(forestMindMotives(repeated).variety, 0);
});

test("derived motives survive old four-need snapshots and a missing or invalid transient activation", () => {
  const original = createForestMind(); original.elapsed = 50; original.needs.attention = .7;
  original.recent = ["leaf", "butterfly", "leaf"].map((action, index) => ({ key: `play-${index}`, action, at: 40 + index, duration: 4, outcome: "completed" }));
  const saved = { elapsed: original.elapsed, needs: original.needs, recent: original.recent, attentionUntil: 70 };
  const restored = restoreForestMind(saved), suppliedTransient = restoreForestMind({ ...saved, arousal: 999 });
  assert.deepEqual(forestMindMotives(restored), forestMindMotives(suppliedTransient), "transient state is reconstructed, never trusted from storage");
  assert.equal(forestMindMotives(restored).saturation, forestMindMotives(original).saturation);
  assert.equal(forestMindMotives(restored).variety, forestMindMotives(original).variety);
  delete restored.arousal;
  const expected = forestMindMotives(restored);
  restored.arousal = NaN; assert.deepEqual(forestMindMotives(restored), expected);
  const view = forestMindMotives(restored); view.saturation = 0;
  assert.ok(forestMindMotives(restored).saturation > .5);
  advanceForestMind(restored, .1, calm);
  for (const value of Object.values(forestMindMotives(restored))) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
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
  // Grass sampling now follows the authored neighbourhood. Probe the same
  // landmarks before assigning their colliding ID, keeping those bounds fixed.
  const landmarks = [{ id: "first", activity: "look", position: { x: 250, y: 210 } },
    { id: "second", activity: "rest", position: { x: 200, y: 250 } }];
  const nearby = createForestBehavior();
  chooseForestGoal(navigation, landmarks, nearby, context);
  const id = nearby.mind.candidates.find(item => item.key.startsWith("grass-"))?.key;
  assert.ok(id, "the fixture samples grass beside these landmarks");
  const authored = createForestBehavior(), first = { ...landmarks[0], id };
  const result = chooseForestGoal(navigation, [first, { ...landmarks[1], id }], authored, context);
  assert.equal(authored.mind.candidates.length, 1);
  assert.equal(authored.mind.candidates.filter(item => item.selected).length, 1);
  assert.deepEqual(result.position, first.position, "the authored landmark owns its identity over later duplicates and grass samples");
});

test("the director owns one need clock through movement and pauses it with blocked, reduced or disabled life", () => {
  const state = session(), mind = state.clearing.behavior.mind;
  advance(state, 8);
  assert.ok(mind.elapsed > 7.9 && mind.elapsed < 8.1); assert.ok(mind.intention);
  const before = structuredClone({ elapsed: mind.elapsed, needs: mind.needs, motives: forestMindMotives(mind) });
  for (const options of [{ ...conditions, blocked: true }, { ...conditions, reducedMotion: true }, { ...conditions, autoLife: false }]) {
    advance(state, 3, options); assert.deepEqual({ elapsed: mind.elapsed, needs: mind.needs, motives: forestMindMotives(mind) }, before);
  }
});

test("ten minutes of seeded autonomous life keeps interest responsive in dry and rainy scenes", () => {
  for (const rain of [0, 1]) for (const seed of [17, 82, 1337]) {
    const state = session(), mind = state.clearing.behavior.mind;
    state.clearing.seed = seed; state.director.seed = seed;
    const counts = new Map(); let nearZero = 0, last = null;
    for (let frame = 0; frame < 6000; frame++) {
      advanceForestDirector(state, .1, { ...conditions, rain });
      if (mind.needs.curiosity < .01) nearZero++;
      const recent = mind.recent.at(-1);
      if (recent && recent !== last && recent.outcome === "completed") counts.set(recent.action, (counts.get(recent.action) ?? 0) + 1);
      last = recent;
    }
    assert.ok(nearZero / 6000 < .05, `interest stuck near zero: rain=${rain}, seed=${seed}`);
    assert.ok(counts.size >= 3, `too few distinct completed activities: rain=${rain}, seed=${seed}`);
    assert.ok(mind.needs.curiosity > .2 && mind.needs.curiosity < .8);
    assert.ok((counts.get(rain ? "groom" : "rest") ?? 0) > 0, "self-care remains available");
    assert.ok(mind.recent.length <= 16 && mind.events.length <= 24);
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
