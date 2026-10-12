import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldConstructionStatus, constructionCountdown } = await vite.ssrLoadModule("/features/world/ui/hud/world-construction-status.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { constructionMapPlace, projectConstructionAnchor } = await vite.ssrLoadModule("/features/world/scene/construction-map-anchor.ts");
const { interactiveMapObjects } = await vite.ssrLoadModule("/features/world/scene/site-interactions.ts");
const { initialPreviewLevels, previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { default: authoredWorld } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");

const now = Date.parse("2026-10-03T12:00:00Z");
const construction = { id: "saved-construction", kind: "construction", targetId: "home", targetLevel: 2,
  startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 1_800_000).toISOString() };
const controller = (jobs = [construction], time = now) => ({ snapshot: { catalog: economyCatalog, jobs, buildings: { home: 1 } }, now: time });
const anchors = [{ objectId: "home", place: "house", x: 190, y: 240, pointerOffset: 0 }];
const markup = (economy, extra = {}) => renderToStaticMarkup(WorldConstructionStatus({ economy, anchors, onOpen() {}, ...extra }));

test("construction status stays absent until a real construction job exists", () => {
  for (const economy of [{ snapshot: null, now }, controller([]), controller([{ ...construction, kind: "production" }]), controller([{ ...construction, kind: "exploration" }])]) {
    assert.equal(markup(economy), "");
  }
});

test("saved construction shows its target level and server-clock countdown and opens that improvement", () => {
  const calls = [], economy = controller();
  const button = WorldConstructionStatus({ economy, anchors, onOpen: stationId => calls.push(stationId) });
  const html = renderToStaticMarkup(button);
  assert.match(html, /data-construction-status="true"/);
  assert.match(html, /title="Дом Мохлика · Уровень 2"/);
  assert.match(html, /data-map-object="home"/);
  assert.match(html, /left:190px;top:240px/);
  assert.match(html, /<strong>30:00<\/strong>/);
  assert.match(html, /aria-label="Дом Мохлика: идёт строительство\. Открыть улучшение"/);
  assert.doesNotMatch(html, /data-ready|Готово/);
  button.props.onClick();
  assert.deepEqual(calls, ["home"]);
  assert.equal(economy.snapshot.buildings.home, 1, "opening the badge must not complete the paid job");
  assert.match(markup(controller([construction], now + 1_000)), /<strong>29:59<\/strong>/);
});

test("a hidden or offscreen host cannot leave a floating construction marker behind", () => {
  assert.equal(markup(controller(), { anchors: [] }), "");
  assert.equal(markup(controller(), { hidden: true }), "");
  assert.equal(markup(controller([{ ...construction, targetId: "unknown" }])), "");
  const warehouse = WorldConstructionStatus({ economy: controller([{ ...construction, targetId: "warehouse" }]), anchors, onOpen() {} });
  assert.equal(warehouse.props["data-map-object"], "home");
  assert.equal(warehouse.props["data-construction-target"], "warehouse");
});

test("every economy construction maps to its existing map host including interior stations", () => {
  const places = { home: "house", warehouse: "house", workshop: "workshop", kiln: "workshop", garden: "garden", woodlot: "woodlot", quarry: "quarry", dryer: "campfire" };
  for (const station of economyCatalog.buildings) assert.equal(constructionMapPlace(station.id), places[station.id]);
  for (const unknown of ["bridge", "lighthouse", "constructor", "unknown"]) assert.equal(constructionMapPlace(unknown), null);
});

test("construction marker follows roof geometry through pan zoom resize and authored visual levels", () => {
  const object = { id: "home", place: "house", anchor: { x: 170, y: 260 }, hitArea: [{ x: 100, y: 200 }, { x: 220, y: 230 }, { x: 180, y: 280 }] };
  const view = { width: 400, height: 600 }, camera = { x: 200, y: 300, zoom: 1 };
  assert.deepEqual(projectConstructionAnchor(object, camera, view), { objectId: "home", place: "house", x: 160, y: 190, pointerOffset: 0 });
  assert.deepEqual(projectConstructionAnchor(object, { ...camera, x: 220, y: 270 }, view), { objectId: "home", place: "house", x: 140, y: 220, pointerOffset: 0 });
  assert.deepEqual(projectConstructionAnchor(object, { ...camera, zoom: 2 }, view), { objectId: "home", place: "house", x: 120, y: 90, pointerOffset: 0 });
  assert.deepEqual(projectConstructionAnchor(object, camera, { width: 520, height: 700 }), { objectId: "home", place: "house", x: 220, y: 240, pointerOffset: 0 });
  const levels = initialPreviewLevels(authoredWorld), source = structuredClone(authoredWorld);
  const [first, second] = [1, 2].map(home => {
    const scene = previewWorldScene(authoredWorld, { ...levels, home });
    const host = interactiveMapObjects(scene).find(entry => entry.id === "home");
    return projectConstructionAnchor(host, { x: 627, y: 627, zoom: 1 }, { width: 900, height: 900 });
  });
  assert.notDeepEqual(first, second, "the completed level's contour supplies the next timer position");
  assert.deepEqual(authoredWorld, source, "screen projection never changes Tiled placement");
});

test("construction marker clears measured HUD bounds and disappears when its roof leaves the viewport", () => {
  const object = { id: "home", place: "house", hitArea: [{ x: 100, y: 200 }, { x: 220, y: 280 }] };
  const view = { width: 320, height: 480 }, camera = { x: 160, y: 240, zoom: 1 };
  assert.ok(projectConstructionAnchor(object, camera, view, { top: 130, bottom: 90 }));
  assert.equal(projectConstructionAnchor(object, camera, view, { top: 150, bottom: 90 }), null);
  assert.equal(projectConstructionAnchor(object, camera, view, { top: 0, bottom: 300 }), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, x: 321 }, view), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, x: -161 }, view), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, y: 500 }, view), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, y: -300 }, view), null);
  const nearEdge = projectConstructionAnchor(object, { ...camera, x: 300 }, view);
  assert.equal(nearEdge.x, 70, "keep the fixed-size button fully inside the viewport");
  assert.equal(nearEdge.x + nearEdge.pointerOffset, 20, "its pointer still identifies the visible roof");
});

test("finished construction remains visible and ready without applying its level", () => {
  const economy = controller([construction], Date.parse(construction.finishesAt));
  const html = markup(economy);
  assert.match(html, /data-ready="true"/);
  assert.match(html, /<strong>Готово<\/strong>/);
  assert.match(html, /aria-label="Дом Мохлика: строительство завершено\. Открыть улучшение"/);
  assert.equal(economy.snapshot.jobs.length, 1);
  assert.equal(economy.snapshot.buildings.home, 1);
  assert.match(markup(controller([construction], now + 86_400_000)), /<strong>Готово<\/strong>/);
});

test("construction countdown preserves seconds and long build durations without negative output", () => {
  for (const [seconds, expected] of [[-2, "0:00"], [.1, "0:01"], [59, "0:59"], [60, "1:00"], [3600, "1:00:00"], [90061, "1 д 1:01:01"], [604800, "7 д 0:00:00"]]) {
    assert.equal(constructionCountdown(seconds), expected);
  }
});
