import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement, Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EARTH_ATLAS_ENTRIES, earthAtlasEntry } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { EARTH_ATLAS_PLACES, earthAtlasPlaces, earthAtlasPlaceProgress } = await vite.ssrLoadModule("/features/earth/earth-atlas-visible.ts");
const { createEarthAtlasStore } = await vite.ssrLoadModule("/features/earth/earth-atlas-storage.ts");
const { EarthAtlasPanel } = await vite.ssrLoadModule("/features/earth/earth-atlas-panel.tsx");
const { EarthAtlasExplorer } = await vite.ssrLoadModule("/features/earth/earth-atlas-explorer.tsx");
const eiffel = earthAtlasEntry("landmark:eiffel-tower");

function nodes(tree) {
  const result = [];
  const walk = value => { if (isValidElement(value)) { result.push(value); Children.forEach(value.props.children, walk); } };
  walk(tree); return result;
}

test("the visible atlas contains only its nine useful places and searches their names", () => {
  assert.equal(EARTH_ATLAS_PLACES.length, 9);
  assert.equal(new Set(EARTH_ATLAS_PLACES.map(entry => entry.id)).size, 9);
  assert.ok(EARTH_ATLAS_PLACES.every(entry => entry.kind === "landmark" && earthAtlasEntry(entry.id) === entry));
  assert.deepEqual(earthAtlasPlaces("   ЭЙФЕЛЕВА   ").map(entry => entry.id), [eiffel.id]);
  assert.deepEqual(earthAtlasPlaces("Колизей").map(entry => entry.id), ["landmark:colosseum"]);
  for (const query of ["Сахара", "Биомы", "Маршруты", "no such place"]) assert.deepEqual(earthAtlasPlaces(query), []);
  const atlas = { snapshot: { loaded: true, persistent: true, ids: [] } };
  const html = renderToStaticMarkup(createElement(EarthAtlasPanel, { atlas, onFocus() {} }));
  assert.equal([...html.matchAll(/: показать на карте/g)].length, 9);
  assert.doesNotMatch(html, /Биомы|Маршруты|Предыдущая остановка|Следующая остановка|<[^>]+data-biome/);
});

test("visible progress counts places separately while every historical v1 ID survives the next save", () => {
  const legacy = EARTH_ATLAS_ENTRIES.filter(entry => entry.kind !== "landmark").map(entry => entry.id);
  assert.equal(legacy.length, 41);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const atlas = createEarthAtlasStore("atlas-places-test", () => storage);
  storage.setItem(atlas.storageKey, JSON.stringify({ version: 1, ids: legacy }));
  const deactivate = atlas.activate();
  try {
    assert.deepEqual(earthAtlasPlaceProgress(atlas.getSnapshot().ids), { opened: 0, total: 9, otherSaved: 41 });
    assert.equal(atlas.discover(eiffel.id), true);
    const restored = JSON.parse(storage.getItem(atlas.storageKey));
    assert.equal(restored.version, 1); assert.deepEqual(restored.ids, [...legacy, eiffel.id]);
    assert.deepEqual(earthAtlasPlaceProgress([...restored.ids, eiffel.id, "unknown"]), { opened: 1, total: 9, otherSaved: 41 });
    const html = renderToStaticMarkup(createElement(EarthAtlasPanel, { atlas: { snapshot: atlas.getSnapshot() }, onFocus() {} }));
    assert.match(html, /Эйфелева башня: сохранено в атласе/); assert.match(html, /Ранние отметки: 41/);
    assert.doesNotMatch(html, /Сахара|Встреча с близким: показать/);
  } finally { deactivate(); }
});

test("the compact place card keeps explicit readiness-checked save and session-storage feedback", () => {
  const calls = [], props = { entry: eiffel, opened: false, loaded: true, persistent: true,
    preview: { entryId: eiffel.id, requestId: 1, status: "ready" },
    onDiscover: () => calls.push("save"), onFocus: () => calls.push("focus"), onClose: () => calls.push("close") };
  const tree = EarthAtlasExplorer(props), buttons = nodes(tree).filter(node => node.type === "button");
  assert.equal(buttons.length, 3, "one place needs only refocus, close and save");
  buttons.find(node => node.props["aria-label"] === `Сохранить в атлас: ${eiffel.title}`).props.onClick();
  assert.deepEqual(calls, ["save"]);
  for (const change of [{ loaded: false }, { opened: true }, { preview: null },
    { preview: { entryId: "landmark:colosseum", requestId: 1, status: "ready" } },
    { preview: { entryId: eiffel.id, requestId: 1, status: "moving" } }]) {
    const controls = nodes(EarthAtlasExplorer({ ...props, ...change }));
    const save = controls.find(node => node.type === "button" && node.props["aria-label"]?.includes("атлас"));
    assert.equal(save.props.disabled, true); save.props.onClick();
  }
  assert.deepEqual(calls, ["save"], "disabled or stale cards do not call the storage action");
  const fallback = renderToStaticMarkup(createElement(EarthAtlasExplorer, { ...props, opened: true, persistent: false }));
  assert.match(fallback, /До закрытия карты · хранилище недоступно/);
  assert.doesNotMatch(fallback, /Сохранено в атласе|Остановка|маршрут/);
  assert.equal(EarthAtlasExplorer({ ...props, entry: earthAtlasEntry("region:sahara") }), null);
});
