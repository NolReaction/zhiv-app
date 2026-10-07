import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldDevBuilderPoints, BuilderWorkPointReport, builderWorkDiagnosticContext } = await vite.ssrLoadModule("/features/world/dev/world-dev-builder-points.tsx");
const { WORLD_DEV_DEFAULTS, worldDevStore } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { builderWorkMarkerChecks } = await vite.ssrLoadModule("/features/world/builder-navigation.ts");
const now = Date.parse("2026-10-06T12:00:00Z");
const economy = (buildings = {}, jobs = []) => ({ ownerPublicId: "builder-diagnostic", revision: 1, catalog: economyCatalog, buildings, jobs });
const context = (state, preview = WORLD_DEV_DEFAULTS, source = TILED_WORLD) => builderWorkDiagnosticContext(source, preview, 1, state, now);
const station = (report, id = "home") => report.stations.find(station => station.id === id);
const render = (report, id = "home") => renderToStaticMarkup(createElement(BuilderWorkPointReport, { scene: report.scene, station: station(report, id) }));
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function boundaryScene(position) {
  return { schemaVersion: 1, id: "builder-diagnostic-boundary", width: 300, height: 300, terrain: [],
    focus: { x: 0, y: 0, width: 300, height: 300 }, actor: { spawn: { x: 20, y: 200 }, size: 50 },
    sites: [{ id: "home", label: "Дом", initialLevel: 1, bounds: { x: 100, y: 50, width: 40, height: 50 },
      anchor: { x: 120, y: 75 }, entry: { x: 120, y: 120 }, doorway: { x: 120, y: 110 },
      collision: rect(100, 50, 40, 50), hitArea: rect(100, 50, 40, 50),
      states: [{ level: 1, label: "Дом", image: "/test-home.webp" }, { level: 2, label: "Дом2", image: "/test-home.webp" }] }],
    paths: [], destinations: [{ id: "builder-work-home", position }],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "ground", points: rect(0, 0, 300, 300) }], obstacles: [], interests: [] } };
}

test("builder diagnostics follow account geometry and explicit DEV previews while capping hypothetical upgrades", () => {
  const state = economy({ home: 3, warehouse: 2, workshop: 5 });
  const account = context(state);
  assert.equal(station(account).currentLevel, 3); assert.equal(station(account).job.targetLevel, 4);
  const home = account.scene.sites.find(site => site.id === "home");
  assert.deepEqual(home.entry, home.states.find(state => state.level === 3).geometry.entry);
  const preview = context(state, { ...WORLD_DEV_DEFAULTS, previewBuildings: true,
    levels: { ...WORLD_DEV_DEFAULTS.levels, home: 2 } });
  assert.equal(station(preview).currentLevel, 2); assert.equal(station(preview).job.targetLevel, 3);
  assert.equal(station(preview, "warehouse").currentLevel, 2, "an internal upgrade retains its account level, not the host's art level");
  assert.equal(station(account, "workshop").job.targetLevel, 5, "the catalogue has no sixth-level upgrade");
  assert.match(render(account, "workshop"), /проверка текущего уровня/);
});

test("an existing confirmed order determines its exact checked level and opens that station by default", () => {
  const state = economy({ home: 3, workshop: 1 }, [{ id: "existing-workshop", kind: "construction", targetId: "workshop", targetLevel: 3,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 3600_000).toISOString() }]);
  const report = context(state), selected = station(report, "workshop");
  assert.equal(report.activeStationId, "workshop"); assert.equal(selected.job.targetLevel, 3); assert.equal(selected.confirmed, true);
  const markup = renderToStaticMarkup(createElement(WorldDevBuilderPoints, { source: TILED_WORLD, preview: WORLD_DEV_DEFAULTS,
    houseLevel: 1, economy: state, now }));
  assert.match(markup, /<details[^>]*><summary>Рабочие точки Tiled/);
  assert.doesNotMatch(markup, /<details[^>]*\bopen/);
  assert.match(markup, /value="workshop" selected=""/);
  assert.match(markup, /подтверждённая стройка/);
  assert.doesNotMatch(markup, /<button/);
});

test("exported marker coordinates and physical rejection reasons stay visible beside the fallback candidate", () => {
  const source = structuredClone(TILED_WORLD), home = source.sites.find(site => site.id === "home");
  source.destinations.find(item => item.id === "builder-work-home").position = { ...home.entry };
  const report = context(economy({ home: 1 }), WORLD_DEV_DEFAULTS, source), markup = render(report);
  assert.match(markup, new RegExp(`X ${home.entry.x} · Y ${home.entry.y}`));
  assert.match(markup, /data-marker-issue="doorway"/); assert.match(markup, /Перекрывает вход или проход к нему/);
  assert.match(markup, /data-marker-issue="activity"/);
  assert.match(markup, /Первый безопасный кандидат:/); assert.match(markup, /Путь может выбрать следующий/);
  assert.doesNotMatch(markup, /Физические проверки пройдены/);
});

test("an authored marker beside transparent PNG padding is reported as accepted with its exported precision", () => {
  const source = structuredClone(TILED_WORLD);
  source.destinations.find(item => item.id === "builder-work-home").position = { x: 589.5761, y: 648 };
  const markup = render(context(economy({ home: 1 }), WORLD_DEV_DEFAULTS, source));
  assert.match(markup, /X 589\.5761 · Y 648/); assert.match(markup, /Физические проверки пройдены/);
  assert.doesNotMatch(markup, /data-marker-issue/);
});

test("inspecting a marker-free export or changing inspected stations cannot mutate account, DEV or map state", () => {
  const source = structuredClone(TILED_WORLD);
  source.destinations = source.destinations.filter(item => !item.id.startsWith("builder-work-"));
  const state = economy({ home: 1 }), preview = structuredClone(WORLD_DEV_DEFAULTS), store = worldDevStore.getSnapshot();
  const before = structuredClone({ source, state, preview });
  const report = context(state, preview, source);
  for (const selected of report.stations) render(report, selected.id);
  assert.match(render(report), /В экспорте нет рабочей точки/);
  assert.match(render(report), /Место подбирается автоматически/);
  assert.deepEqual({ source, state, preview }, before); assert.equal(worldDevStore.getSnapshot(), store);
});

test("the exact campfire screenshot marker is accepted and becomes the displayed first candidate", () => {
  const source = structuredClone(TILED_WORLD);
  source.destinations.find(item => item.id === "builder-work-dryer").position = { x: 722.510346320346, y: 657.937316017316 };
  const markup = render(context(economy({ dryer: 1 }), WORLD_DEV_DEFAULTS, source), "dryer");
  assert.match(markup, /Физические проверки пройдены/);
  assert.match(markup, /Первый безопасный кандидат: X 722\.510346320346 · Y 657\.937316017316/);
  assert.doesNotMatch(markup, /data-marker-issue/);
});

test("a campfire seat remains protected with the actual zero distance, clearance and exported conflict source", () => {
  const source = structuredClone(TILED_WORLD), fire = source.campfires.find(item => item.id === "clearing-campfire");
  source.destinations.find(item => item.id === "builder-work-dryer").position = { ...fire.seat };
  const markup = render(context(economy({ dryer: 1 }), WORLD_DEV_DEFAULTS, source), "dryer");
  assert.match(markup, /data-marker-issue="activity"/);
  assert.match(markup, /До места занятия 0 ед\.;/);
  assert.match(markup, /нужно ≥ 25,2/);
  assert.match(markup, /<details[^>]*><summary>Источник проверки<\/summary>/);
  assert.match(markup, /clearing-campfire:seat/);
  assert.ok(markup.includes(`X ${fire.seat.x} · Y ${fire.seat.y}`));
  assert.doesNotMatch(markup, /Перекрывает вход|data-marker-issue="doorway"/);
});

test("bush diagnostics name the real jump corridor rather than a building doorway", () => {
  const source = structuredClone(TILED_WORLD), bush = source.bushes.find(item => item.id === "clearing-bush");
  source.destinations.find(item => item.id === "builder-work-garden").position = { ...bush.entry };
  const markup = render(context(economy({ garden: 1 }), WORLD_DEV_DEFAULTS, source), "garden");
  assert.match(markup, /data-marker-issue="bush-access"/);
  assert.match(markup, /Перекрывает прыжок или проход в куст/);
  assert.match(markup, /clearing-bush:jump/);
  assert.doesNotMatch(markup, /Перекрывает вход или проход к нему/);
});

test("distance-to-contour failures name the host and show a maximum rather than a minimum clearance", () => {
  for (const [id, name] of [["dryer", "костра"], ["garden", "куста"], ["home", "здания"]]) {
    const source = structuredClone(TILED_WORLD);
    source.destinations.find(item => item.id === `builder-work-${id}`).position = { x: 0, y: 0 };
    const markup = render(context(economy({ [id]: 1 }), WORLD_DEV_DEFAULTS, source), id);
    assert.match(markup, new RegExp(`контура ${name}`));
    assert.match(markup, /не дальше 32/);
  }
});

test("only shared host markers get an alias explanation and absent candidates do not promise automatic placement", () => {
  const report = context(economy({ home: 1, warehouse: 1, kiln: 1 }));
  for (const id of ["warehouse", "kiln"]) assert.match(render(report, id), /Общая рабочая точка:/);
  assert.doesNotMatch(render(report), /Общая рабочая точка:/);
  const source = structuredClone(TILED_WORLD);
  source.destinations = source.destinations.filter(item => !item.id.startsWith("builder-work-"));
  source.navigation.areas = [];
  const markup = render(context(economy({ home: 1 }), WORLD_DEV_DEFAULTS, source));
  assert.match(markup, /В экспорте нет рабочей точки/);
  assert.match(markup, /Безопасных кандидатов нет/);
  assert.doesNotMatch(markup, /Место подбирается автоматически/);
});

test("SSR rejection measurements retain the difference near minimum and maximum clearance boundaries", () => {
  for (const [position, issue, expected] of [
    [{ x: 145.198, y: 120 }, "doorway", "До прохода 25,198 ед.; нужно ≥ 25,2."],
    [{ x: 172.001, y: 80 }, "far-from-building", "До контура здания 32,001 ед.; не дальше 32."],
    [{ x: 172 + 1e-12, y: 80 }, "far-from-building", "До контура здания 32,000000000001 ед.; не дальше 32."],
  ]) {
    const report = context(economy({ home: 1 }), WORLD_DEV_DEFAULTS, boundaryScene(position));
    const conflict = builderWorkMarkerChecks(report.scene, station(report).job)[0].conflicts.find(conflict => conflict.issue === issue);
    assert.ok(conflict, "the displayed rejection and measurements come from runtime validation");
    assert.notEqual(conflict.distance, conflict.limit);
    const markup = render(report);
    assert.ok(markup.includes(expected), `distinct validation values must stay distinct: ${expected}`);
    assert.doesNotMatch(markup, /До прохода 25,2 ед\.; нужно ≥ 25,2\.|До контура здания 32 ед\.; не дальше 32\./);
  }
});
