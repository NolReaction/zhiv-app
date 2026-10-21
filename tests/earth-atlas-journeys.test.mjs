import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EARTH_ATLAS_JOURNEYS, earthAtlasJourney, earthAtlasJourneyStop, transitionEarthAtlasJourney: transition } = await vite.ssrLoadModule("/features/earth/earth-atlas-journeys.ts");
const { earthAtlasEntry, earthAtlasCandidate } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { createEarthAtlasStore } = await vite.ssrLoadModule("/features/earth/earth-atlas-storage.ts");
const { EarthAtlasJourneys } = await vite.ssrLoadModule("/features/earth/earth-atlas-journey-panel.tsx");

test("short authored journeys resolve only existing geographic catalog entries and canonical focus views", () => {
  assert.equal(EARTH_ATLAS_JOURNEYS.length, 3);
  assert.equal(new Set(EARTH_ATLAS_JOURNEYS.map(item => item.id)).size, 3);
  for (const journey of EARTH_ATLAS_JOURNEYS) {
    assert.ok(journey.stops.length >= 4 && journey.stops.length <= 5);
    assert.equal(new Set(journey.stops.map(stop => stop.entryId)).size, journey.stops.length);
    assert.ok(journey.title && journey.description);
    for (let stopIndex = 0; stopIndex < journey.stops.length; stopIndex++) {
      const stop = earthAtlasJourneyStop({ journeyId: journey.id, stopIndex });
      assert.equal(stop.journey, journey);
      assert.equal(stop.entry, earthAtlasEntry(journey.stops[stopIndex].entryId));
      assert.notEqual(stop.entry.kind, "meeting");
      assert.ok(stop.stop.note.length > 40 && stop.stop.note.length <= 200);
      assert.equal(earthAtlasCandidate({ center: stop.entry.center, zoom: stop.entry.zoom })?.id, stop.entry.id);
      assert.deepEqual(Object.keys(journey.stops[stopIndex]).sort(), ["entryId", "note"], "routes do not duplicate coordinates, rewards or GPS records");
    }
  }
});

test("journeys advance one explicit step, stop at boundaries and finish only on request", () => {
  for (const journey of EARTH_ATLAS_JOURNEYS) {
    let state = transition(null, { type: "start", journeyId: journey.id });
    assert.equal(state.stopIndex, 0);
    assert.equal(transition(state, { type: "previous" }), state);
    for (let index = 1; index < journey.stops.length; index++) {
      state = transition(state, { type: "next" });
      assert.equal(state.stopIndex, index);
    }
    assert.equal(transition(state, { type: "next" }), state, "last stop remains visible until explicit finish");
    assert.equal(transition(state, { type: "previous" }).stopIndex, journey.stops.length - 2);
    assert.equal(transition(state, { type: "stop" }), null);
    assert.equal(transition(null, { type: "next" }), null);
  }
});

test("selection and restarting are bounded; malformed and unavailable stops cannot produce a camera target", () => {
  const journey = EARTH_ATLAS_JOURNEYS[0];
  let state = transition(null, { type: "start", journeyId: journey.id });
  state = transition(state, { type: "select", stopIndex: 2 });
  assert.equal(state.stopIndex, 2);
  assert.equal(transition(state, { type: "select", stopIndex: 2 }), state);
  for (const stopIndex of [-1, NaN, Infinity, 0.5, 99]) {
    assert.equal(transition(state, { type: "select", stopIndex }), state);
    assert.equal(earthAtlasJourneyStop({ journeyId: journey.id, stopIndex }), null);
  }
  assert.equal(transition(state, { type: "start", journeyId: "missing" }), state);
  assert.equal(earthAtlasJourney("missing"), null);
  assert.equal(earthAtlasJourneyStop({ journeyId: "missing", stopIndex: 0 }), null);
  assert.equal(transition({ journeyId: "missing", stopIndex: 0 }, { type: "next" }), null);
  assert.equal(transition(state, { type: "start", journeyId: journey.id }).stopIndex, 0);
});

test("navigating an entire route creates no discoveries; a separate explicit discovery stores only its catalog ID", () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = createEarthAtlasStore("journey-test", () => storage), deactivate = store.activate();
  const journey = EARTH_ATLAS_JOURNEYS[0];
  let state = transition(null, { type: "start", journeyId: journey.id });
  const first = earthAtlasJourneyStop(state).entry;
  for (let index = 1; index < journey.stops.length; index++) state = transition(state, { type: "next" });
  state = transition(state, { type: "stop" });
  assert.equal(state, null);
  assert.deepEqual(store.getSnapshot().ids, []);
  assert.equal(values.size, 0);
  assert.equal(store.discover(first.id), true);
  assert.deepEqual(JSON.parse(values.get(store.storageKey)), { version: 1, ids: [first.id] });
  assert.equal(store.discover(first.id), false);
  deactivate();
});

test("the stateless journey chooser offers explicit starts and searchable direct stop selection", () => {
  const calls = [];
  const html = renderToStaticMarkup(createElement(EarthAtlasJourneys, {
    openedIds: [], onStartJourney: id => calls.push(["start", id]),
  }));
  assert.deepEqual(calls, []);
  for (const journey of EARTH_ATLAS_JOURNEYS) assert.ok(html.includes(`Начать маршрут: ${journey.title}`));
  assert.match(html, /Мини-путешествия по атласу/);
  assert.match(html, /Сохранение каждого открытия — отдельной кнопкой на карте/);
  assert.doesNotMatch(html, /Открыть в атласе|Текущий маршрут/);
  const route = EARTH_ATLAS_JOURNEYS.find(item => item.id === "five-silhouettes");
  const active = renderToStaticMarkup(createElement(EarthAtlasJourneys, {
    openedIds: [], journeyState: { journeyId: route.id, stopIndex: 0 }, query: "Эйфел", onStartJourney: id => calls.push(id), onSelectStop: index => calls.push(index),
  }));
  assert.match(active, /Остановки текущего маршрута/);
  assert.match(active, /Остановка 1: Эйфелева башня/);
  assert.match(active, /aria-current="step"/);
  assert.match(active, /Заметка об остановке: Эйфелева башня/);
  assert.doesNotMatch(active, /<details[^>]*\sopen(?:[=>\s])/);
  assert.doesNotMatch(active, /Остановка 2: Колизей/);
  assert.deepEqual(calls, []);
});
