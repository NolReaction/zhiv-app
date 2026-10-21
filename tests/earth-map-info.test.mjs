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
const { EarthMapInfo } = await vite.ssrLoadModule("/features/earth/earth-map-info.tsx");
const { EARTH_SATELLITE_INITIAL_STATE } = await vite.ssrLoadModule("/features/earth/satellite.ts");
const base = { satelliteState: EARTH_SATELLITE_INITIAL_STATE, satelliteAvailable: true, isOnline: true,
  satelliteMessage: "Fixture satellite status", onMapModeChange() {}, lightingMode: "auto", onLightingModeChange() {},
  buildings3d: true, onToggleBuildings() {}, cache: { storage: "device", persistence: "best-effort", storedBytes: 1024, diskLimitBytes: 4096 },
  persisting: false, onPersist() {}, locationDetails: createElement("section", null, "Fixture location details") };
function nodes(tree) {
  const result = [];
  const walk = value => { if (isValidElement(value)) { result.push(value); Children.forEach(value.props.children, walk); } };
  walk(tree); return result;
}
const label = node => Children.toArray(node.props.children).filter(value => typeof value === "string").join("");

test("primary map settings remain six compact controls while help, storage and complete legal credits stay collapsed", () => {
  const html = renderToStaticMarkup(createElement(EarthMapInfo, base));
  const primary = html.slice(0, html.indexOf("<details"));
  assert.equal([...primary.matchAll(/<button\b/g)].length, 6);
  assert.doesNotMatch(primary, /Fixture location details|Кеш ограничен|Источники карты|MapLibre|ODbL|Fixture satellite status/);
  const detailTag = html.match(/<details\b[^>]*data-earth-info-details[^>]*>/)?.[0];
  assert.ok(detailTag); assert.doesNotMatch(detailTag, /\sopen(?:[=>\s])/);
  assert.match(html, /Подробнее и источники/); assert.match(html, /Fixture location details/);
  for (const source of ["© OpenStreetMap", "OpenFreeMap", "OpenMapTiles", "Natural Earth", "ODbL", "CC BY 4.0", "MapLibre GL JS", "3D-модели", "Погода:"])
    assert.ok(html.includes(source), source);
  assert.match(html, /data-earth-model-credits/); assert.match(html, /\/LICENSE\.txt/);
});

test("compact controls delegate the existing choices and preserve a saved 3D preference on satellite", () => {
  const calls = [], tree = EarthMapInfo({ ...base, satelliteState: { ...base.satelliteState, enabled: true, imageryVisible: true, status: "ready" },
    onMapModeChange: value => calls.push(["map", value]), onLightingModeChange: value => calls.push(["light", value]),
    onToggleBuildings: () => calls.push(["buildings"]), onPersist: () => calls.push(["persist"]) });
  const all = nodes(tree), buttons = all.filter(node => node.type === "button");
  buttons.find(node => label(node) === "Карта").props.onClick();
  buttons.find(node => label(node) === "Спутник").props.onClick();
  buttons.find(node => label(node) === "Авто").props.onClick();
  buttons.find(node => label(node) === "День").props.onClick();
  buttons.find(node => label(node) === "Вечер").props.onClick();
  const buildings = buttons.find(node => node.props.role === "switch");
  assert.equal(buildings.props["aria-checked"], true); buildings.props.onClick();
  buttons.find(node => label(node) === "Закрепить карту").props.onClick();
  assert.deepEqual(calls, [["map", false], ["map", true], ["light", "day"], ["light", "evening"], ["buildings"], ["persist"]]);
  const html = renderToStaticMarkup(tree); assert.match(html, /3D-настройка сохранена для обычной карты/);
});

test("satellite availability, loading errors and storage persistence keep their actual disabled states", () => {
  for (const change of [{ satelliteAvailable: false }, { isOnline: false }]) {
    const controls = nodes(EarthMapInfo({ ...base, ...change }));
    assert.equal(controls.find(node => node.type === "button" && label(node) === "Спутник").props.disabled, true);
  }
  const selectedOffline = nodes(EarthMapInfo({ ...base, isOnline: false, satelliteState: { ...base.satelliteState, enabled: true, status: "offline" } }));
  assert.equal(selectedOffline.find(node => node.type === "button" && label(node) === "Спутник").props.disabled, false);
  const error = renderToStaticMarkup(createElement(EarthMapInfo, { ...base,
    satelliteState: { ...base.satelliteState, status: "error", error: "Fixture error" }, satelliteMessage: "Fixture error" }));
  assert.match(error.slice(0, error.indexOf("<details")), /role="status">Fixture error/);
  const persisting = nodes(EarthMapInfo({ ...base, persisting: true })).find(node => node.type === "button" && label(node) === "Сохраняем…");
  assert.equal(persisting.props.disabled, true);
  for (const cache of [{ ...base.cache, storage: "session" }, { ...base.cache, persistence: "granted" }]) {
    assert.equal(nodes(EarthMapInfo({ ...base, cache })).some(node => node.type === "button" && label(node) === "Закрепить карту"), false);
  }
});
