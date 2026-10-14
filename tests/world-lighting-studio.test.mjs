import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { worldDevStore, WORLD_DEV_DEFAULTS } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { worldLightingEditorStore: store } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-store.ts");
const { activateWorldLightingStudio, WorldLightingStudio, WorldLightingSourceInspector, focusLightingSelection } = await vite.ssrLoadModule("/features/world/dev/world-lighting-studio.tsx");
const { WorldLightingEditor, WorldLightingReceiverInspector, previewLightingCasterLevel } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor.tsx");
const { buildWorldStudioOutliner, filterWorldStudioOutliner, studioDefaultFolders, studioFolderAncestors } = await vite.ssrLoadModule("/features/world/dev/world-studio-outliner.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts");
const { takeWorldLightingEditorFocus } = await vite.ssrLoadModule("/features/world/dev/world-lighting-editor-map.ts");
const { claimWorldLightingStudio, releaseWorldLightingStudio, hasWorldLightingStudioOwner, takeWorldLightingStudioHandoff } = await vite.ssrLoadModule("/features/world/dev/world-lighting-studio-session.ts");
afterEach(() => { store.resetAll(); store.select(null); store.setEnabled(false); store.setPreviewDraft(true); store.setTool("select"); worldDevStore.reset(); takeWorldLightingEditorFocus(); takeWorldLightingStudioHandoff(); });
function markup(Component, props) {
  const serverSnapshot = store.getServerSnapshot;
  store.getServerSnapshot = store.getSnapshot;
  try { return renderToStaticMarkup(createElement(Component, props)); }
  finally { store.getServerSnapshot = serverSnapshot; }
}
const props = () => ({ state: worldDevStore.getSnapshot(), change() { assert.fail("Rendering must not change preview settings"); }, worldView: true, onClose() {} });

test("a direct studio launch opens the full map once and prepares the preview without changing authored data", () => {
  const source = JSON.stringify(TILED_WORLD), calls = [];
  activateWorldLightingStudio(false, () => calls.push("world"));
  assert.deepEqual(calls, ["world"]);
  assert.equal(store.getSnapshot().enabled, true);
  assert.equal(store.getSnapshot().tool, "select");
  assert.equal(store.getSnapshot().overlay, "selected");
  assert.equal(store.getSnapshot().previewDraft, true);
  const preview = worldDevStore.getSnapshot();
  assert.equal(preview.timeOfDay, "night");
  assert.equal(preview.lightShadows, true);
  assert.equal(preview.lightDebug, false);
  assert.equal(preview.lightTestLamp, false);
  activateWorldLightingStudio(true, () => assert.fail("A mounted map must not be reopened"));
  assert.equal(JSON.stringify(TILED_WORLD), source);
  assert.deepEqual(store.getSnapshot().dirtyIds, []);
  assert.deepEqual(store.getSnapshot().dirtyLightIds, []);
});

test("the non-modal studio provides separate tools, search, source presets, compare and saving without mutating a selection", () => {
  activateWorldLightingStudio(true);
  const before = store.getSnapshot(), beforeView = worldDevStore.getSnapshot();
  const html = markup(WorldLightingStudio, props());
  assert.match(html, /data-world-lighting-studio-panel/);
  assert.doesNotMatch(html, /role="dialog"|aria-modal|backdrop/i);
  assert.match(html, /aria-label="Инструменты студии"/);
  for (const label of ["Выбрать", "Двигать", "Контур", "Высота", "Источник", "Камера", "Найти · F", "Объекты", "Свойства", "Вид", "Фонарь", "Факел", "Свечение", "Черновик", "Сохранённое", "Сохранить сейчас", "Резервная копия", "Скачать JSON", "Загрузить JSON"]) assert.ok(html.includes(label), label);
  assert.match(html, /type="search" aria-label="Найти объект или источник"/);
  assert.match(html, /Свернуть/);
  assert.equal(store.getSnapshot(), before);
  assert.equal(worldDevStore.getSnapshot(), beforeView);
});

test("light properties expose the real source and distinguish disabling an original from deleting a new source", () => {
  activateWorldLightingStudio(true);
  store.selectLight(TILED_WORLD.lights[0].id);
  let light = store.getSnapshot().lights.find(item => item.id === store.getSnapshot().selectedId);
  let html = markup(WorldLightingSourceInspector, { light, state: WORLD_DEV_DEFAULTS });
  assert.match(html, /Свойства источника/);
  for (const label of ["Яркость", "Радиус", "Цвет света", "Высота источника", "Мерцание", "Дублировать", "Убрать источник"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, />Удалить источник</);
  const id = store.addLight({ x: 400, y: 500 }, "glow");
  light = store.getSnapshot().lights.find(item => item.id === id);
  html = markup(WorldLightingSourceInspector, { light, state: WORLD_DEV_DEFAULTS });
  assert.match(html, />Удалить источник</);
  assert.doesNotMatch(html, />Убрать источник</);
  store.setPreviewDraft(false);
  html = markup(WorldLightingSourceInspector, { light, state: WORLD_DEV_DEFAULTS });
  assert.match(html, /<fieldset[^>]*disabled/);
});

test("the selected caster inspector exposes height and an explicit active-level action without auto-changing the building", () => {
  activateWorldLightingStudio(true); store.select("home-shadow-2");
  const before = worldDevStore.getSnapshot();
  const html = markup(WorldLightingEditor, { state: before, change() { assert.fail("Inspecting cannot upgrade or preview a building automatically"); } });
  assert.match(html, />Высота</); assert.match(html, />Основание</); assert.match(html, />Верх</);
  assert.match(html, /Показать уровень 2/);
  assert.match(html, /Контур ·/);
  assert.equal(worldDevStore.getSnapshot(), before);
});

test("showing a hidden level enables preview even when that level equals the cached DEV default", () => {
  const caster = TILED_WORLD.shadowCasters.find(item => item.id === "home-shadow-1");
  const actual = { ...WORLD_DEV_DEFAULTS.levels, home: 3 };
  assert.equal(worldDevStore.getSnapshot().levels.home, 1);
  previewLightingCasterLevel(caster, actual, patch => worldDevStore.patch(patch));
  const preview = worldDevStore.getSnapshot();
  assert.equal(preview.previewBuildings, true);
  assert.equal(accountSceneLevels(TILED_WORLD, 3, preview).home, 1);
  for (const [id, level] of Object.entries(actual)) if (id !== "home") assert.equal(preview.levels[id], level);
});

test("attached source fields display the real rendered projection instead of guessing an authored height or location", () => {
  activateWorldLightingStudio(true);
  const light = TILED_WORLD.lights.find(item => item.id === "home-lantern");
  store.selectLight(light.id);
  store.setLightProjections([{ id: light.id, position: { x: 901.2, y: 702.3 }, height: 72 }]);
  const html = markup(WorldLightingSourceInspector, { light });
  assert.match(html, /value="901.2"/);
  assert.match(html, /value="702.3"/);
  assert.match(html, /value="72"/);
  assert.doesNotMatch(html, /Высота источника: авто/);
});

test("focus requests survive asynchronous map mounting and defer attached-source coordinates to the actual map", () => {
  store.addLight({ x: 400, y: 500 }, "lantern"); focusLightingSelection();
  assert.equal(takeWorldLightingEditorFocus(), "selection");
  store.select("clearing-north-crown"); focusLightingSelection();
  assert.equal(takeWorldLightingEditorFocus(), "selection");
  assert.equal(takeWorldLightingEditorFocus(), null);
});

test("a late home cleanup cannot disable editing after the full map claims studio ownership", () => {
  const home = {}, fullMap = {};
  claimWorldLightingStudio(home); store.setEnabled(true);
  claimWorldLightingStudio(fullMap);
  if (releaseWorldLightingStudio(home)) store.setEnabled(false);
  assert.equal(hasWorldLightingStudioOwner(), true);
  assert.equal(store.getSnapshot().enabled, true);
  assert.equal(releaseWorldLightingStudio(home), false);
  if (releaseWorldLightingStudio(fullMap)) store.setEnabled(false);
  assert.equal(hasWorldLightingStudioOwner(), false);
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(releaseWorldLightingStudio(fullMap), false);
});

test("automatic folders separate buildings, levels, tree parts and ground while search keeps ancestry", () => {
  const roots = buildWorldStudioOutliner(store.getSnapshot(), { ...WORLD_DEV_DEFAULTS.levels, home: 3 });
  const buildings = roots.find(node => node.id === "buildings"), home = buildings.children.find(node => node.id === "building:home");
  assert.equal(home.children.length, 5); assert.equal(home.children.find(node => node.id === "building:home:3").active, true);
  const defaults = studioDefaultFolders(roots); assert.ok(defaults.includes("building:home:3")); assert.ok(!defaults.includes("building:home:2"));
  assert.deepEqual(studioFolderAncestors(roots, "caster", "home-shadow-2"), ["buildings", "building:home", "building:home:2"]);
  const trees = roots.find(node => node.id === "trees"), tree = trees.children.find(node => node.id === "tree:clearing-north");
  assert.equal(tree.children.length, 2); assert.ok(!defaults.includes(tree.id));
  const filtered = filterWorldStudioOutliner(roots, "Северное дерево", "casters");
  assert.equal(filtered.length, 1); assert.equal(filtered[0].id, "trees"); assert.equal(filtered[0].children.length, 1);
  assert.equal(filtered[0].children[0].children.length, 2);
});

test("receiver inspection explains blue ground, uses its valid height limit and supports deletion and restore", () => {
  activateWorldLightingStudio(true); const receiver = store.getSnapshot().receivers[0]; store.selectReceiver(receiver.id);
  const html = markup(WorldLightingReceiverInspector, {});
  assert.match(html, /Синий контур ограничивает землю/); assert.match(html, /Поверхность, принимающая тень/);
  assert.match(html, /max="300"/); assert.match(html, /Удалить поверхность/); assert.match(html, /пока экспериментальные/);
  store.removeSelected(); assert.ok(!store.getSnapshot().receivers.some(item => item.id === receiver.id));
  const removed = buildWorldStudioOutliner(store.getSnapshot(), WORLD_DEV_DEFAULTS.levels).find(node => node.id === "removed");
  assert.ok(removed.children.some(node => node.id === receiver.id && node.removed));
  store.restoreElement("receiver", receiver.id); assert.ok(store.getSnapshot().receivers.some(item => item.id === receiver.id));
});

test("Studio keeps independent outliner and inspector panels and distinguishes autosave from a full backup", () => {
  activateWorldLightingStudio(true); const html = markup(WorldLightingStudio, props());
  assert.match(html, /data-world-studio-mode/); assert.match(html, /aria-label="Объекты студии"/); assert.match(html, /aria-label="Инспектор студии"/);
  assert.match(html, /data-studio-outliner-scroll/); assert.match(html, /data-studio-inspector-scroll/);
  assert.doesNotMatch(html, /role="tablist"|role="tabpanel"/);
  assert.match(html, /Черновик в браузере/); assert.match(html, /Файлы проекта/); assert.match(html, /JSON содержит все источники света, объёмы и поверхности/);
  assert.match(html, /День, ночь, солнце и качество меняют только предпросмотр/);
});

test("large tree inventories remain grouped and search prunes unrelated branches", () => {
  const snapshot = store.getSnapshot(), base = snapshot.casters.find(item => !item.when), casters = [];
  for (let at = 0; at < 500; at++) for (const part of ["trunk", "crown"]) casters.push({ ...base, id: `tree-${at}-${part}` });
  const roots = buildWorldStudioOutliner({ ...snapshot, casters, receivers: [], lights: [], deletedCasters: [], deletedReceivers: [] }, {});
  assert.equal(roots.length, 1); assert.equal(roots[0].children.length, 500); assert.equal(roots[0].children[0].children.length, 2);
  const filtered = filterWorldStudioOutliner(roots, "tree-499", "all"); assert.equal(filtered[0].children.length, 1); assert.equal(filtered[0].children[0].children.length, 2);
});
