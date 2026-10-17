import assert from "node:assert/strict";
import test from "node:test";
import { browser, compactVillagerFixture, confirmedVillagers, finishVillagerArtwork, mapProjection,
  modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

test("visible villager body taps greet their own resident without opening a menu, with or without a UI callback", async () => {
  const { createMapEngine, connectForestSession, forgetForestSession, forestVillagerFrames,
    TILED_WORLD, worldDevStore } = await modules(compactVillagerFixture());
  const env = browser(), owner = "resident-body-tap-regression", key = `zhiv:mochlik:presence:${owner}`;
  let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const canvas = env.surface(460), places = [], menus = [], interactions = {};
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { home: 3, quarry: 1 }, economyResidents: { ...confirmedVillagers(owner), buildings: { home: 3, quarry: 1 } },
      merchantArrival: { seen: true, enabled: false, onComplete() { assert.fail("a saved merchant arrival does not replay on a body tap"); } },
      residentArrival: { seen: true, enabled: false, onComplete() { assert.fail("a saved arrival does not replay on a body tap"); } } };
    const loading = createMapEngine(canvas, initial, place => places.push(place), [], undefined, {}, interactions);
    await finishVillagerArtwork(env); engine = await loading;
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    const send = (name, event) => canvas.events.get(name)({ ...event, type: name });
    const bodyPoint = id => {
      engine.control("overview");
      const frame = forestVillagerFrames(state.villagers).find(frame => frame.id === id && (frame.opacity ?? 1) > .95);
      assert.ok(frame, `${id} has a visible body on the live map`);
      const projection = mapProjection(canvas);
      return { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + frame.x * projection.zoom,
        clientY: projection.top + (frame.y - frame.size * .48) * projection.zoom };
    };
    for (const [index, id] of ["lopukh", "kamneshmyg", "leaftail"].entries()) {
      const mind = state.villagers.residents[id];
      if (id === "leaftail") clock.until(() => mind.doorPhase === "outside",
        "the merchant naturally finishes his indoor stay and walks outside before a body tap", 1800);
      if (index === 1) interactions.onResident = value => menus.push(value);
      assert.equal(state.social.current, null, "the previous greeting has expired before the next tap");
      const sequence = state.social.sequence, notice = mind.noticePending;
      let point = bodyPoint(id);
      send("pointerdown", point); send("pointermove", { ...point, clientX: point.clientX + 30 });
      send("pointerup", { ...point, clientX: point.clientX + 30 });
      point = bodyPoint(id); send("pointerdown", point); send("pointercancel", point);
      point = bodyPoint(id);
      const second = { ...point, pointerId: 2, clientX: point.clientX + 35 };
      send("pointerdown", point); send("pointerdown", second);
      send("pointermove", { ...second, clientX: second.clientX + 10 });
      send("pointerup", point); send("pointerup", { ...second, clientX: second.clientX + 10 });
      assert.equal(state.social.sequence, sequence, `${id}: drag, cancellation and pinch do not produce a greeting`);
      assert.equal(mind.noticePending, notice); assert.deepEqual(places, []); assert.deepEqual(menus, []);

      point = bodyPoint(id);
      const heroFeet = { ...state.clearing.position };
      const otherNotices = Object.fromEntries(Object.entries(state.villagers.residents)
        .filter(([other]) => other !== id).map(([other, resident]) => [other, resident.noticePending]));
      send("pointerdown", point); send("pointerup", point);
      assert.equal(state.social.current?.speaker, id, `${id}: the actual pointer hit produces its own speech`);
      assert.equal(state.social.current?.origin, "interaction"); assert.equal(state.social.sequence, sequence + 1);
      assert.equal(mind.noticePending, true, `${id}: the tap notifies this resident's own mind`);
      for (const [other, pending] of Object.entries(otherNotices)) assert.equal(state.villagers.residents[other].noticePending, pending);
      assert.deepEqual(state.clearing.position, heroFeet, "a resident greeting never moves or greets Mochlik instead");
      assert.deepEqual(menus, [], "body taps remain greetings even when an optional menu callback is present");
      assert.deepEqual(places, [], "an overlapping home/building does not steal the visible body tap");
      clock.advance(6);
    }
  } finally { engine?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});
