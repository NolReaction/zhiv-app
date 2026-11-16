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
const { overviewCamera } = await vite.ssrLoadModule("/features/world/scene/camera.ts");

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
  assert.match(html, /aria-label="Дом Мохлика: идёт строительство, 30:00\. Открыть улучшение"/);
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
  const places = { home: "house", warehouse: "house", workshop: "workshop", kiln: "workshop", garden: "garden", woodlot: "lopukh-home", quarry: "quarry", dryer: "campfire", bridge: "bridge", lighthouse: "lighthouse" };
  for (const station of economyCatalog.buildings) assert.equal(constructionMapPlace(station.id), places[station.id]);
  for (const unknown of ["constructor", "unknown"]) assert.equal(constructionMapPlace(unknown), null);
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
  const underHud = projectConstructionAnchor(object, camera, view, { top: 150, bottom: 90 });
  assert.equal(underHud.y - 44, 158, "a visible roof keeps its full timer below the HUD");
  assert.equal(projectConstructionAnchor(object, camera, view, { top: 200, bottom: 90 }), null,
    "a roof itself covered by the HUD never gains a floating marker");
  assert.equal(projectConstructionAnchor(object, camera, view, { top: 0, bottom: 300 }), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, x: 321 }, view), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, x: -161 }, view), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, y: 500 }, view), null);
  assert.equal(projectConstructionAnchor(object, { ...camera, y: -300 }, view), null);
  const nearEdge = projectConstructionAnchor(object, { ...camera, x: 300 }, view);
  assert.equal(nearEdge.x, 57, "keep the fixed-size button fully inside the viewport");
  assert.equal(nearEdge.x + nearEdge.pointerOffset, 20, "its pointer still identifies the visible roof");
});

test("quarry and Lopukh timers remain visible at the authored map's maximum zoom out", () => {
  const scene = previewWorldScene(authoredWorld, { ...initialPreviewLevels(authoredWorld), quarry: 1, "lopukh-home": 1 });
  const hosts = interactiveMapObjects(scene).filter(object => ["quarry", "lopukh-home"].includes(object.place));
  assert.equal(hosts.length, 2);
  for (const view of [{ width: 320, height: 600 }, { width: 961, height: 959 }, { width: 1024, height: 768 }]) {
    const camera = overviewCamera(view, scene), insets = { top: view.width === 1024 ? 40 : 80, bottom: 50 };
    for (const host of hosts) {
      const before = structuredClone(host), anchor = projectConstructionAnchor(host, camera, view, insets);
      assert.ok(anchor, `${host.place} has a timer at ${view.width}×${view.height}`);
      assert.ok(anchor.y - 44 >= insets.top + 8, "the complete touch target clears the measured top HUD");
      assert.ok(anchor.y <= view.height - insets.bottom - 8);
      assert.ok(anchor.x - 49 >= 8 && anchor.x + 49 <= view.width - 8);
      assert.deepEqual(host, before, "timer placement never moves the authored building");
    }
  }
});

test("camera movement reuses immutable roof geometry while a replacement contour takes effect immediately", () => {
  let reads = 0;
  const points = [[100, 200], [220, 230], [180, 280]].map(([x, y]) => ({
    get x() { reads++; return x; }, get y() { reads++; return y; },
  }));
  const object = { id: "home", place: "house", hitArea: points };
  const view = { width: 400, height: 600 }, camera = { x: 200, y: 300, zoom: 1 };
  assert.equal(projectConstructionAnchor(object, camera, view).y, 190);
  const preparedReads = reads;
  for (let step = 1; step <= 120; step++) {
    const anchor = projectConstructionAnchor(object, { ...camera, x: camera.x + step / 4 }, view);
    assert.equal(anchor.x, Math.round(160 - step / 4));
  }
  assert.equal(reads, preparedReads, "120 camera positions do not rescan the immutable contour");
  const next = { ...object, hitArea: [{ x: 100, y: 160 }, { x: 220, y: 280 }] };
  assert.equal(projectConstructionAnchor(next, camera, view).y, 150, "new artwork immediately supplies its own roof");
  assert.equal(projectConstructionAnchor({ ...object, hitArea: [] }, camera, view), null);
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
  for (const [seconds, expected] of [[-2, "0:00"], [.1, "0:01"], [59, "0:59"], [60, "1:00"], [3600, "1:00:00"], [90061, "25:01:01"], [604800, "168:00:00"], [NaN, "0:00"], [Infinity, "0:00"]]) {
    assert.equal(constructionCountdown(seconds), expected);
  }
});
