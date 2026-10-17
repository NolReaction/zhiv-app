import assert from "node:assert/strict";
import test from "node:test";
import {
  browser, compactVillagerFixture, confirmedVillagers, distanceBetween, finishVillagerArtwork,
  mapProjection, modules, options, quietClearing, residentFixture, sceneClock, tradingFixture,
} from "./helpers/new-map-scene.mjs";

function tapBody(engine, canvas, point, size) {
  engine.control("overview");
  const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
    clientX: projection.left + point.x * projection.zoom,
    clientY: projection.top + (point.y - size * .48) * projection.zoom };
  canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
  canvas.events.get("pointerup")({ ...event, type: "pointerup" });
}

function restrictPair(state, first, second) {
  const speakers = ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"];
  const allowed = [first, second].sort().join(":");
  state.social.pairAfter = Object.fromEntries(speakers.flatMap((id, index) => speakers.slice(index + 1)
    .map(other => [id, other].sort().join(":"))).filter(pair => pair !== allowed).map(pair => [pair, 10_000]));
  state.social.nextPassingAt = state.social.nextAnimalAt = 10_000;
  state.social.nextEncounterAt = state.social.elapsed;
  state.clearing.waitSeconds = state.director.nextDecisionAt = 10_000;
}

test("real hero body taps preserve every shop-visit phase and the same trip eventually returns home", async () => {
  const { createMapEngine, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    isClearingAtPoint, canTraverse } = await modules(tradingFixture());
  const env = browser(), key = "shop-body-taps-preserve-trip"; let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const canvas = env.surface(500), places = [], initial = {
      ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
    };
    const loading = createMapEngine(canvas, initial, place => places.push(place), []);
    await finishVillagerArtwork(env); engine = await loading;
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, home = { ...state.clearing.home }, clock = sceneClock(env);
    assert.equal(engine.activateObject("plesk-shop"), true);
    assert.deepEqual(places, ["plesk-shop"]);
    const visit = state.director.tradeVisit, intention = state.clearing.behavior.mind.intention;
    assert.equal(visit?.phase, "outbound");
    const initialFeet = { ...state.clearing.position }; clock.advance(.3);
    assert.ok(distanceBetween(initialFeet, state.clearing.position) > 0, "the genuine shop route starts before the touch");
    for (const phase of ["outbound", "waiting", "visiting", "returning"]) {
      clock.until(() => visit.phase === phase, `the original visit reaches ${phase}`, 1500);
      const feet = { ...state.clearing.position }, target = state.clearing.requestedPoint;
      const route = state.clearing.freeRoute, age = visit.phaseElapsed, sequence = state.social.sequence;
      for (let repeat = 0; repeat < 20; repeat++) tapBody(engine, canvas, state.clearing.position, state.clearing.size);
      assert.equal(state.director.tradeVisit, visit, `${phase}: body taps keep the same visit owner`);
      assert.equal(state.clearing.requestedPoint, target, `${phase}: the destination remains reserved`);
      assert.equal(state.clearing.freeRoute, route, `${phase}: the path is not replaced by a new decision`);
      assert.equal(state.clearing.behavior.mind.intention, intention, `${phase}: greeting does not record a failed intention`);
      assert.equal(visit.phaseElapsed, age, `${phase}: repeated taps cannot restart the phase`);
      assert.deepEqual(state.clearing.position, feet, "input never moves the actor's feet");
      assert.equal(state.reaction, 0, "feedback does not acquire the manual pose's movement block");
      assert.ok(state.social.sequence - sequence <= 1, "tap spam creates at most one finite speech line");
      for (let frame = 0; frame < 12 && visit.phase === phase; frame++) {
        const previous = { ...state.clearing.position };
        tapBody(engine, canvas, state.clearing.position, state.clearing.size); clock.step();
        assert.equal(state.director.tradeVisit, visit, "continued touches cannot cancel the active trip");
        assert.ok(canTraverse(state.clearing.navigation, previous, state.clearing.position));
        assert.ok(distanceBetween(previous, state.clearing.position) <= state.clearing.size * .36 * .05 + 1e-7,
          "feedback never creates a catch-up jump");
      }
    }
    clock.until(() => state.director.tradeVisit === null, "the original trip completes without reopening the shop", 1500);
    assert.ok(isClearingAtPoint(state.clearing, home));
    assert.equal(state.clearing.requestedPoint, null);
    const outcomes = state.clearing.behavior.mind.recent.filter(item => item.key === "trade:plesk-shop");
    assert.deepEqual(outcomes.map(item => item.outcome), ["completed"], "only the real return completes this trip");
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("related and unrelated body taps leave a real neighbour approach and its complete conversation intact", async () => {
  const { createMapEngine, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    requestClearingPoint, builderMindFrame, pleskMindFrame, FOREST_CONVERSATIONS } = await modules(residentFixture());
  const env = browser(), key = "body-taps-preserve-social-visit"; let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const canvas = env.surface(500), places = [], initial = {
      ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
    };
    const loading = createMapEngine(canvas, initial, place => places.push(place), []);
    await finishVillagerArtwork(env); engine = await loading;
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, builder = state.builderMind, plesk = state.pleskMind;
    builder.position = { x: 600, y: 715 }; builder.route = null; builder.target = null;
    builder.action = "idle"; builder.wait = 10_000;
    plesk.intent = "fish"; plesk.stage = { ...plesk.stage, action: "fish", duration: 90 };
    plesk.age = 2; plesk.queue = [];
    assert.equal(requestClearingPoint(state.clearing, { x: 590, y: 660 }), true);
    restrictPair(state, "builder", "plesk");
    const clock = sceneClock(env);
    clock.until(() => state.social.meeting?.phase === "approach", "the real social director starts a builder visit", 30);
    const meeting = state.social.meeting, visit = builder.socialVisit, route = builder.route;
    assert.equal(meeting.guest, "builder"); assert.equal(meeting.host, "plesk"); assert.ok(route);
    const touchSpeakers = () => {
      for (const frame of [builderMindFrame(builder, TILED_WORLD, false), pleskMindFrame(plesk, TILED_WORLD, false)]) {
        assert.ok(frame); tapBody(engine, canvas, frame, frame.size);
      }
      tapBody(engine, canvas, state.clearing.position, state.clearing.size);
    };
    touchSpeakers();
    assert.equal(state.social.meeting, meeting); assert.equal(builder.socialVisit, visit); assert.equal(builder.route, route);
    assert.equal(builder.noticePending, false); assert.equal(plesk.noticePending, false);
    const startingFeet = { ...builder.position };
    clock.until(() => {
      touchSpeakers(); assert.equal(state.social.meeting, meeting); assert.equal(builder.socialVisit, visit);
      return meeting.phase === "talk";
    }, "the visitor reaches the promised stop despite continued touches", 250);
    assert.ok(distanceBetween(startingFeet, builder.position) > 10, "the actual visitor walked rather than being marked arrived");
    const script = FOREST_CONVERSATIONS.find(topic => topic.id === meeting.topicId), heard = new Map();
    assert.ok(script);
    clock.until(() => {
      if (!state.social.meeting) return true;
      const line = state.social.current, queue = [...state.social.queue];
      if (line) heard.set(line.id, { speaker: line.speaker, text: line.text });
      touchSpeakers();
      assert.equal(state.social.meeting, meeting); assert.equal(state.social.current, line);
      assert.deepEqual(state.social.queue, queue, "tapping a speaker neither drops nor duplicates remaining replies");
      return false;
    }, "the finite original script finishes under tap spam", 900);
    assert.equal(state.social.lastMeetingResult?.status, "completed");
    assert.deepEqual([...heard.values()], script.lines);
    assert.equal(builder.socialVisit, null); assert.deepEqual(places, []);
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("body taps preserve a real promised woodpile inspection during its walk and finite inspection", async () => {
  const { createMapEngine, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore,
    forestVillagerFrames, FOREST_CONVERSATIONS } = await modules(compactVillagerFixture());
  const env = browser(), owner = "body-tap-woodpile-promise", key = `zhiv:mochlik:presence:${owner}`;
  let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const canvas = env.surface(500), initial = {
      ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
      economyBuildings: { home: 3, quarry: 1 }, economyResidents: {
        ...confirmedVillagers(owner), buildings: { home: 3, quarry: 1 },
      },
      merchantArrival: { seen: true, enabled: false, onComplete: assert.fail },
      residentArrival: { seen: true, enabled: false, onComplete: assert.fail },
    };
    const loading = createMapEngine(canvas, initial, assert.fail, []);
    await finishVillagerArtwork(env); engine = await loading;
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, rabbit = state.villagers.residents.lopukh, merchant = state.villagers.residents.leaftail;
    state.social.nextEncounterAt = state.social.nextPassingAt = state.director.nextDecisionAt = 10_000;
    state.clearing.waitSeconds = 10_000; state.builderMind.wait = 10_000;
    rabbit.route = null; rabbit.action = "idle"; rabbit.intent = "wander"; rabbit.wait = 10_000;
    rabbit.socialNeed = 1; rabbit.noticePending = false;
    const clock = sceneClock(env);
    clock.until(() => merchant.doorPhase === "inside", "the merchant first enters his actual caravan", 600);
    restrictPair(state, "lopukh", "leaftail");
    state.social.topicHistory = FOREST_CONVERSATIONS.filter(topic => topic.id !== "window-lopukh-leaftail").map(topic => topic.id);
    clock.until(() => state.social.meeting?.phase === "talk", "the rabbit reaches the real caravan window", 500);
    assert.equal(state.social.meeting.topicId, "window-lopukh-leaftail", "the authored conversation makes a woodpile promise");
    clock.until(() => state.social.followup?.phase === "approach", "the completed conversation starts its actual woodpile walk", 900);
    const followup = state.social.followup, visit = rabbit.socialVisit, start = { ...rabbit.position };
    assert.equal(followup.kind, "check-woodpile"); assert.ok(rabbit.route);
    assert.equal(visit.targetId, `followup:${followup.id}`);
    const touch = () => {
      const frame = forestVillagerFrames(state.villagers).find(frame => frame.id === "lopukh");
      assert.ok(frame); tapBody(engine, canvas, frame, frame.size);
      tapBody(engine, canvas, state.clearing.position, state.clearing.size);
    };
    touch();
    assert.equal(state.social.followup, followup); assert.equal(rabbit.socialVisit, visit);
    assert.equal(rabbit.noticePending, false);
    clock.until(() => {
      touch(); assert.equal(state.social.followup, followup); assert.equal(rabbit.socialVisit, visit);
      return followup.phase === "inspect";
    }, "touches during the walk cannot cancel the promised inspection", 900);
    assert.ok(distanceBetween(start, rabbit.position) > 40, "the promised followup reaches another real place");
    const feet = { ...rabbit.position }, inspectStarted = state.social.elapsed;
    clock.until(() => {
      if (!state.social.followup) return true;
      touch(); assert.equal(state.social.followup, followup); assert.deepEqual(rabbit.position, feet);
      return false;
    }, "the three-second inspection completes even under repeated body taps", 100);
    assert.ok(state.social.elapsed - inspectStarted <= 3.1, "taps cannot restart the finite inspection clock");
    assert.equal(state.social.lastFollowupResult?.status, "completed");
    assert.equal(state.social.promiseOutcomes.at(-1)?.status, "completed");
    assert.equal(rabbit.socialVisit, null);
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("hidden body taps and reduced-motion greetings preserve visibility and finite response boundaries", async () => {
  for (const mode of ["hidden", "reduced-motion"]) {
    const fixture = tradingFixture();
    if (mode === "hidden") fixture.occluders = [{ id: "body-canopy", frontY: 720, points: [
      { x: 620, y: 625 }, { x: 650, y: 625 }, { x: 650, y: 685 }, { x: 620, y: 685 },
    ] }];
    const { createMapEngine, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules(fixture);
    const env = browser(), key = `body-taps-${mode}`; let engine, probe;
    try {
      worldDevStore.patch({ ...quietClearing, autoLife: false });
      const canvas = env.surface(500), initial = {
        ...options, reducedMotion: mode === "reduced-motion", serverNow: 100_000, presenceKey: key,
      };
      const loading = createMapEngine(canvas, initial, () => {}, []);
      await finishVillagerArtwork(env); engine = await loading;
      probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
      const state = probe.state;
      if (mode === "hidden") {
        assert.equal(engine.activateObject("plesk-shop"), true);
        const visit = state.director.tradeVisit, route = state.clearing.freeRoute, target = state.clearing.requestedPoint;
        const sequence = state.social.sequence;
        tapBody(engine, canvas, state.clearing.position, state.clearing.size);
        assert.equal(state.social.sequence, sequence, "a canopy-hidden body cannot receive an invisible greeting hit");
        assert.equal(state.director.tradeVisit, visit); assert.equal(state.clearing.freeRoute, route);
        assert.equal(state.clearing.requestedPoint, target);
      } else {
        tapBody(engine, canvas, state.clearing.position, state.clearing.size);
        const speech = state.social.current, reaction = state.reaction;
        assert.equal(speech?.speaker, "mochlik");
        assert.ok(reaction > 0, "the still hero retains visible one-shot feedback");
        for (let repeat = 0; repeat < 30; repeat++) tapBody(engine, canvas, state.clearing.position, state.clearing.size);
        assert.equal(state.social.current, speech); assert.equal(state.reaction, reaction);
        const elapsed = state.elapsed;
        env.tick(100); // Flush the map's single coalesced pointer redraw.
        assert.equal(env.frames.size, 0, "still feedback does not start an autonomous animation loop");
        assert.equal(state.elapsed, elapsed, "painting a still response cannot advance shared simulation time");
        assert.equal(env.timers.size, 2, "tap spam retains one finite gesture and one finite speech expiry");
        for (const timer of [...env.timers.keys()]) env.fireTimer(timer);
        env.tick(200);
        assert.equal(state.reaction, 0); assert.equal(state.social.current, null);
        assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
        assert.equal(state.director.tradeVisit, null); assert.equal(state.clearing.requestedPoint, null);
      }
    } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
  }
});
