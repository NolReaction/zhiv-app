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
const now = Date.parse("2026-10-06T12:00:00Z");
const economy = (buildings = {}, jobs = []) => ({ ownerPublicId: "builder-diagnostic", revision: 1, catalog: economyCatalog, buildings, jobs });
const context = (state, preview = WORLD_DEV_DEFAULTS, source = TILED_WORLD) => builderWorkDiagnosticContext(source, preview, 1, state, now);
const station = (report, id = "home") => report.stations.find(station => station.id === id);
const render = (report, id = "home") => renderToStaticMarkup(createElement(BuilderWorkPointReport, { scene: report.scene, station: station(report, id) }));

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
