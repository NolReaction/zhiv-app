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
const { EARTH_ATLAS_ENTRIES, EARTH_ATLAS_MEETING_ID, earthAtlasCandidate, earthAtlasEntry } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { createEarthAtlasStore, earthAtlasStorageKey, parseEarthAtlas } = await vite.ssrLoadModule("/features/earth/earth-atlas-storage.ts");
const { EarthAtlasPanel } = await vite.ssrLoadModule("/features/earth/earth-atlas-panel.tsx");
const id = "landmark:eiffel-tower", sahara = "region:sahara";
const memoryStorage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("atlas has unique existing landmarks, all authored regions and a non-geographic meeting", () => {
  assert.equal(EARTH_ATLAS_ENTRIES.length, 50);
  assert.equal(new Set(EARTH_ATLAS_ENTRIES.map(entry => entry.id)).size, 50);
  assert.equal(EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === "region").length, 40);
  assert.equal(EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === "landmark").length, 9);
  // A catalogue target now requests its real street model, after full opacity.
  // Actual fit is viewport-aware, using the published model placement/bounds.
  for (const entry of EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === "landmark")) {
    assert.ok(entry.zoom >= 15.6 && entry.zoom <= 18, `${entry.id}: focus keeps the detail model visible`);
    assert.equal(entry.focus.kind, "model");
    assert.equal(entry.focus.modelId, entry.id.slice("landmark:".length));
  }
  assert.equal(earthAtlasEntry(EARTH_ATLAS_MEETING_ID).center, null);
  for (const entry of EARTH_ATLAS_ENTRIES.filter(entry => entry.center)) {
    assert.ok(entry.center.every(Number.isFinite));
    assert.ok(Math.abs(entry.center[0]) <= 180 && Math.abs(entry.center[1]) <= 90);
    assert.equal(earthAtlasCandidate({ center: entry.center, zoom: entry.zoom })?.id, entry.id, entry.id);
  }
});

test("camera candidates require deliberate zoom and a real clipped core, never GPS or distant overview", () => {
  const eiffel = earthAtlasEntry(id);
  assert.equal(earthAtlasCandidate({ center: eiffel.center, zoom: 4.49 }), null);
  assert.equal(earthAtlasCandidate({ center: eiffel.center, zoom: 4.5 }).id, id);
  assert.equal(earthAtlasCandidate({ center: [12, 24], zoom: 2.19 }), null);
  assert.equal(earthAtlasCandidate({ center: [12, 24], zoom: 2.2 }).id, sahara);
  for (const center of [[0, 0], [-30, 25], [-89, 48], [-43, 73], [NaN, 0], [0, 91]]) {
    assert.equal(earthAtlasCandidate({ center, zoom: 3 }), null, String(center));
  }
  assert.equal(earthAtlasCandidate(null), null);
  assert.equal(earthAtlasCandidate({ center: [12, 24], zoom: NaN }), null);
  assert.equal(earthAtlasCandidate({ center: [372, 24], zoom: 3 }).id, sahara);
});

test("untrusted atlas storage is bounded, versioned, filtered and deduplicated", () => {
  assert.deepEqual(parseEarthAtlas('{"version":1,"ids":["landmark:eiffel-tower","unknown","landmark:eiffel-tower",12]}'), [id]);
  for (const raw of [null, "bad", "[]", '{"version":2,"ids":[]}', '{"ids":[]}', '{"version":1,"ids":{}}', " ".repeat(8001),
    JSON.stringify({ version: 1, ids: Array(51).fill(id) })]) assert.deepEqual(parseEarthAtlas(raw), []);
});

test("explicit discoveries are account-scoped, idempotent and contain public IDs only", () => {
  const storage = memoryStorage(), a = createEarthAtlasStore("owner:a", () => storage), b = createEarthAtlasStore("owner:b", () => storage);
  assert.notEqual(a.storageKey, b.storageKey);
  assert.match(a.storageKey, /owner%3Aa$/);
  assert.equal(a.discover(id), false, "an unmounted account cannot write");
  const stop = a.activate(); b.activate();
  assert.deepEqual(a.getSnapshot().ids, []);
  assert.equal(a.discover("no-such-entry"), false);
  assert.equal(a.discover(id), true);
  assert.equal(a.discover(id), false);
  assert.deepEqual(b.getSnapshot().ids, []);
  assert.deepEqual(JSON.parse(storage.getItem(a.storageKey)), { version: 1, ids: [id] });
  assert.equal(a.discover(EARTH_ATLAS_MEETING_ID), true);
  stop();
  assert.equal(a.discover(sahara), false, "a late callback after leaving the account is inert");
  a.reset();
  assert.deepEqual(parseEarthAtlas(storage.getItem(a.storageKey)), [id, EARTH_ATLAS_MEETING_ID]);
  const restored = createEarthAtlasStore("owner:a", () => storage); restored.activate();
  assert.deepEqual(restored.getSnapshot().ids, [id, EARTH_ATLAS_MEETING_ID]);
});

test("another tab's discoveries merge before writes; explicit clear/reset is authoritative", () => {
  const storage = memoryStorage(), a = createEarthAtlasStore("owner", () => storage), b = createEarthAtlasStore("owner", () => storage);
  a.activate(); b.activate();
  a.discover(id); b.discover(sahara); a.restore(true);
  assert.deepEqual(a.getSnapshot().ids, [id, sahara]);
  b.reset(); a.restore(true);
  assert.deepEqual(a.getSnapshot().ids, []);
  a.discover(id); storage.values.clear(); a.restore(true);
  assert.deepEqual(a.getSnapshot().ids, []);
});

test("denied storage keeps a bounded session fallback and reports it; reset still clears memory", () => {
  let denied = true;
  const storage = memoryStorage(), a = createEarthAtlasStore("owner", () => {
    if (denied) throw new Error("blocked");
    return storage;
  });
  const stop = a.activate();
  assert.equal(a.getSnapshot().persistent, false);
  assert.equal(a.discover(id), true);
  assert.deepEqual(a.getSnapshot().ids, [id]);
  a.restore(); assert.deepEqual(a.getSnapshot().ids, [id]);
  a.reset(); assert.deepEqual(a.getSnapshot().ids, []);
  a.discover(sahara); denied = false; a.discover(id);
  assert.equal(a.getSnapshot().persistent, true);
  assert.deepEqual(parseEarthAtlas(storage.getItem(a.storageKey)), [sahara, id]);
  stop(); assert.equal(a.discover(EARTH_ATLAS_MEETING_ID), false);
  const anonymous = createEarthAtlasStore(null, () => storage); anonymous.activate();
  assert.equal(anonymous.discover(id), false);
  assert.equal(earthAtlasStorageKey("owner"), a.storageKey);
});

test("the searchable catalogue selects views without saving or rendering exploration controls", () => {
  const calls = [], atlas = { snapshot: { loaded: true, ids: [], persistent: true }, discover: value => calls.push(value), reset: () => calls.push("reset") };
  const html = renderToStaticMarkup(createElement(EarthAtlasPanel, { atlas, onFocus: entry => calls.push(["focus", entry.id]), onStartJourney: id => calls.push(["journey", id]) }));
  assert.deepEqual(calls, []);
  assert.match(html, /Каталог атласа/);
  assert.match(html, /Поиск по атласу/);
  assert.match(html, /Места на глобусе/);
  assert.match(html, /Эйфелева башня: показать на карте/);
  assert.match(html, /не отметки о поездках/);
  assert.match(html, /Встреча с близким отмечается через значок друга/);
  assert.doesNotMatch(html, /Предыдущие открытия|Следующие открытия|Открыть в атласе|Сохранить в атлас/);
  const fallback = renderToStaticMarkup(createElement(EarthAtlasPanel, { atlas: { ...atlas, snapshot: { loaded: true, ids: [sahara], persistent: false } }, onFocus: () => {}, onStartJourney: () => {} }));
  assert.match(fallback, /Хранилище недоступно/);
  assert.match(fallback, /Открытия останутся до закрытия карты/);
});
