import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-workshop-status-vite",
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { mapProductionGroups, layoutProductionMarkers, workshopProductionSections, productionMarkerHeight } = await vite.ssrLoadModule("/features/world/ui/hud/world-production-state.ts");
const { WorldProductionStatus } = await vite.ssrLoadModule("/features/world/ui/hud/world-production-status.tsx");
const { WorldProductionEffects } = await vite.ssrLoadModule("/features/world/ui/feedback/world-production-effects.tsx");
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { constructionMapPlace, projectConstructionAnchor } = await vite.ssrLoadModule("/features/world/scene/construction-map-anchor.ts");
const { createInventoryGainPlayback } = await vite.ssrLoadModule("/features/world/ui/feedback/inventory-gain-playback.ts");
const start = Date.parse("2026-10-05T12:00:00Z"), finish = start + 3600_000, owner = "AAAA-0000-0001";
const iso = value => new Date(value).toISOString();
function job(stationId, extra = {}) {
  // A paid pre-redesign order: no live recipe may recreate this job.
  if (stationId === "quarry") return { id: "saved-quarry", kind: "production", targetId: "quarry", recipeId: "quarry_stone",
    startedAt: iso(start), finishesAt: iso(finish), rewards: { stone: 8 }, cost: { coins: 0, items: {} }, catalogVersion: 3, ...extra };
  const recipe = catalog.recipes.find(entry => entry.buildingId === stationId);
  return { id: stationId, kind: "production", targetId: stationId, recipeId: recipe.id, startedAt: iso(start), finishesAt: iso(finish),
    rewards: { ...recipe.rewards }, ...(recipe.collection ? { collection: { ...recipe.collection, startedAt: null, finishesAt: null } } : {}), ...extra };
}
const state = (jobs, available = 100) => ({ ownerPublicId: owner, catalog, jobs, storage: { available }, buildings: {}, fishing: { catches: {} } });
const anchor = (place, x = 200, y = 250) => ({ place, objectId: place, x, y, pointerOffset: 0 });

test("production statuses use paid job clocks without claiming or displaying idle/invalid jobs", () => {
  assert.deepEqual(mapProductionGroups(null, start), []);
  assert.deepEqual(mapProductionGroups(state([]), start), []);
  const saved = state([job("dryer"), job("quarry"), job("woodlot")]), original = structuredClone(saved);
  const groups = mapProductionGroups(saved, start + 30_000);
  assert.equal(groups.length, 3);
  assert.equal(groups.find(group => group.place === "campfire").entries[0].remaining, 3570);
  assert.ok(groups.every(group => group.entries[0].phase === "working"));
  assert.ok(mapProductionGroups(saved, finish).every(group => group.entries[0].phase === "ready"));
  assert.ok(mapProductionGroups({ ...saved, storage: { available: 0 } }, finish).every(group => group.entries[0].phase === "storage-blocked"));
  assert.deepEqual(saved, original);
  for (const change of [{ kind: "exploration" }, { kind: "construction" }, { targetId: "missing" }, { recipeId: "missing" }, { startedAt: "bad" }, { finishesAt: iso(start) }]) {
    assert.deepEqual(mapProductionGroups(state([job("dryer", change)]), start), []);
  }
  assert.deepEqual(mapProductionGroups(saved, start - 1), []);
  assert.deepEqual(mapProductionGroups(saved, NaN), []);
});

test("garden separates growth, ripe waiting, real gathering, paused gathering and stored-ready crops", () => {
  const crop = job("garden"), get = (value, now, collection = null, available = 100) => mapProductionGroups(state([value], available), now, collection)[0].entries[0];
  assert.equal(get(crop, start).phase, "working");
  assert.equal(get(crop, finish).phase, "awaiting-gather");
  assert.equal(get(crop, finish, null, 0).phase, "storage-blocked");
  const harvesting = { ...crop, collection: { ...crop.collection, startedAt: iso(finish), finishesAt: iso(finish + 8000) } };
  const active = { jobId: crop.id, phase: "walking", request: null };
  assert.equal(get(harvesting, finish + 2000, active).phase, "collecting");
  assert.equal(get(harvesting, finish + 2000, active).remaining, 6);
  assert.equal(get(harvesting, finish + 9000, active).phase, "collecting", "the real basket deposit may outlast the minimum server clock");
  assert.equal(get(harvesting, finish + 9000, { ...active, phase: "paused" }).phase, "paused");
  assert.equal(get(harvesting, finish + 9000, { ...active, phase: "claim-ready" }).phase, "ready");
});

test("workshop and kiln share one host and report all jobs including a simultaneous interior upgrade", () => {
  const construction = { ...job("kiln"), id: "upgrade", kind: "construction", targetLevel: 2 };
  const saved = state([job("workshop"), job("kiln", { finishesAt: iso(start + 20_000) })]);
  const groups = mapProductionGroups(saved, start + 30_000);
  assert.equal(groups.length, 1); assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[0].entries[0].stationId, "kiln", "the ready result gets the visible shortcut");
  const upgraded = mapProductionGroups(state([job("workshop"), construction]), start)[0];
  assert.equal(upgraded.construction.jobId, "upgrade");
  assert.equal(upgraded.place, "workshop");
  const calls = [], economy = { snapshot: saved, now: start + 30_000 };
  const component = WorldProductionStatus({ economy, groups, anchors: [anchor("workshop")], onOpen: id => calls.push(id) });
  const html = renderToStaticMarkup(component);
  assert.equal((html.match(/data-production-status=/g) ?? []).length, 2);
  assert.match(html, /data-production-host="workshop"/); assert.match(html, /Верстак/); assert.match(html, /Печь/);
  assert.match(html, /data-production-target="kiln"/); assert.doesNotMatch(html, /\+1/);
  assert.match(html, /data-item-icon="planks"/); assert.match(html, /data-item-icon="charcoal"/);
  assert.match(html, /Выжечь древесный уголь/); assert.match(html, /Распилить доску/);
  const sections = component.props.children[0].props.children;
  assert.equal(sections[0].props["data-production-status"], "working");
  assert.equal(sections[1].props["data-production-status"], "ready");
  sections[0].props.onClick(); sections[1].props.onClick(); assert.deepEqual(calls, ["workshop", "kiln"]);
  assert.equal(saved.jobs.length, 2, "the badge only opens a station and never starts or claims work");
});

test("three slots per station remain visible behind one workshop host badge", () => {
  const jobs = ["workshop", "kiln"].flatMap(station => Array.from({ length: 3 }, (_, index) => job(station, {
    id: `${station}-${index}`, finishesAt: iso(index ? finish + index * 1000 : start + 1000),
  })));
  const saved = state(jobs), now = start + 2000, groups = mapProductionGroups(saved, now);
  assert.equal(groups.length, 1); assert.equal(groups[0].entries.length, 6);
  assert.equal(groups[0].primary.phase, "ready");
  assert.deepEqual(new Set(groups[0].entries.map(entry => entry.jobId)), new Set(jobs.map(entry => entry.id)));
  const html = renderToStaticMarkup(WorldProductionStatus({ economy: { snapshot: saved, now }, groups, anchors: [anchor("workshop")], onOpen() {} }));
  assert.equal((html.match(/data-production-status=/g) ?? []).length, 2);
  assert.equal((html.match(/\+2/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\+5/);
  assert.match(html, /Выжечь древесный уголь/); assert.match(html, /Распилить доску/);
});

test("each shared queue keeps its own saved countdown, progress and extra paid jobs", () => {
  const jobs = [job("workshop", { id: "plank", finishesAt: iso(start + 120_000) }),
    ...Array.from({ length: 5 }, (_, index) => job("kiln", { id: `legacy-kiln-${index}`, finishesAt: iso(start + 300_000 + index * 1000) }))];
  const saved = state(jobs), before = structuredClone(saved), now = start + 60_000;
  const [group] = mapProductionGroups(saved, now), sections = workshopProductionSections(group);
  assert.equal(productionMarkerHeight(group), 88);
  assert.deepEqual(sections.map(section => [section.stationId, section.primary.remaining, section.entries.length]), [["workshop", 60, 1], ["kiln", 240, 5]]);
  assert.equal(sections[0].primary.progress, .5); assert.equal(sections[1].primary.progress, .2);
  const html = renderToStaticMarkup(WorldProductionStatus({ economy: { snapshot: saved, now }, groups: [group], anchors: [anchor("workshop")], onOpen() {} }));
  assert.match(html, /<strong>1:00<\/strong>/); assert.match(html, /<strong>4:00<\/strong>/);
  assert.match(html, /width:50%/); assert.match(html, /width:20%/); assert.match(html, /\+4/);
  for (const id of jobs.map(value => value.id)) assert.ok(group.entries.some(entry => entry.jobId === id));
  assert.deepEqual(saved, before, "the split badge never truncates or rewrites old paid queues");
});

test("a lone workbench or kiln keeps a single 44px button and names its equipment", () => {
  for (const [stationId, label] of [["workshop", "Верстак"], ["kiln", "Печь"]]) {
    const saved = state([job(stationId)]), groups = mapProductionGroups(saved, start), calls = [];
    assert.equal(productionMarkerHeight(groups[0]), 44);
    const component = WorldProductionStatus({ economy: { snapshot: saved, now: start }, groups, anchors: [anchor("workshop")], onOpen: id => calls.push(id) });
    const html = renderToStaticMarkup(component);
    assert.equal((html.match(/data-production-status=/g) ?? []).length, 1);
    assert.match(html, new RegExp(`<small>${label}<\\/small>`)); assert.doesNotMatch(html, /data-production-host=/);
    component.props.children[0].props.onClick(); assert.deepEqual(calls, [stationId]);
  }
});

test("a completed shared-host upgrade keeps its shortcut ahead of both production sections", () => {
  const construction = { ...job("kiln"), id: "upgrade", kind: "construction", targetLevel: 2, finishesAt: iso(start + 1000) };
  const saved = state([job("workshop"), job("kiln"), construction]), now = start + 2000, groups = mapProductionGroups(saved, now), calls = [];
  assert.equal(groups[0].primary.kind, "construction"); assert.equal(productionMarkerHeight(groups[0]), 44);
  assert.deepEqual(workshopProductionSections(groups[0]), []);
  const component = WorldProductionStatus({ economy: { snapshot: saved, now }, groups, anchors: [anchor("workshop")],
    onOpen: id => calls.push(`station:${id}`), onOpenConstruction: id => calls.push(`construction:${id}`) });
  const html = renderToStaticMarkup(component);
  assert.equal((html.match(/data-production-status=/g) ?? []).length, 1);
  assert.match(html, /\+2/); assert.match(html, /data-work-kind="construction"/);
  assert.match(html, /Распилить доску/); assert.match(html, /Выжечь древесный уголь/);
  component.props.children[0].props.onClick(); assert.deepEqual(calls, ["construction:kiln"]);
});

test("a finished kiln upgrade takes the shared host shortcut and keeps the workshop order visible", () => {
  const construction = { ...job("kiln"), id: "upgrade", kind: "construction", targetLevel: 2, finishesAt: iso(start + 20_000) };
  const saved = state([job("workshop"), construction, job("dryer")]), now = start + 30_000;
  const groups = mapProductionGroups(saved, now), shared = groups.find(group => group.place === "workshop");
  assert.equal(shared.primary.kind, "construction"); assert.equal(shared.primary.stationId, "kiln");
  assert.equal(shared.primary.phase, "ready"); assert.equal(shared.primary.progress, 1);
  assert.equal(shared.entries[0].remaining, 3570);
  const calls = [], component = WorldProductionStatus({ economy: { snapshot: saved, now }, groups,
    anchors: [anchor("workshop")], onOpen: id => calls.push(`station:${id}`), onOpenConstruction: id => calls.push(`upgrade:${id}`) });
  const html = renderToStaticMarkup(component);
  assert.match(html, /data-work-kind="construction"/); assert.match(html, /Строительство завершено/);
  assert.match(html, /Распилить доску, Изготовление, 59:30/); assert.match(html, /Уровень 2/);
  assert.match(html, /Открыть улучшение/); assert.match(html, /Завершить/); assert.match(html, /\+1/);
  component.props.children[0].props.onClick(); assert.deepEqual(calls, ["upgrade:kiln"]);
  const overlapping = [anchor("campfire", 200, 250), anchor("workshop", 205, 252)];
  assert.equal(layoutProductionMarkers(groups, overlapping)[0].group.place, "workshop", "a ready construction wins the shared screen footprint too");
  assert.equal(saved.jobs.length, 3, "opening the upgrade does not complete it");
});

test("working construction competes by finish time and all shared timers remain available", () => {
  const construction = { ...job("kiln"), id: "upgrade", kind: "construction", targetLevel: 2, finishesAt: iso(start + 300_000) };
  const saved = state([job("workshop"), construction]), now = start + 30_000, groups = mapProductionGroups(saved, now);
  assert.equal(groups[0].primary.kind, "construction"); assert.equal(groups[0].primary.remaining, 270);
  const html = renderToStaticMarkup(WorldProductionStatus({ economy: { snapshot: saved, now }, groups, anchors: [anchor("workshop")], onOpen() {}, onOpenConstruction() {} }));
  assert.match(html, /<strong>4:30<\/strong>/); assert.match(html, /Уровень 2, Строительство, 4:30/);
  assert.match(html, /Распилить доску, Изготовление, 59:30/); assert.match(html, /\+1/);
  const soonerProduction = mapProductionGroups(state([job("workshop", { finishesAt: iso(start + 60_000) }), construction]), now);
  assert.equal(soonerProduction[0].primary.kind, "production");
});

test("projected host coordinates follow pan/zoom and cull overlaps/offscreen badges on mobile", () => {
  const groups = mapProductionGroups(state([job("dryer"), job("quarry", { finishesAt: iso(start + 1000) })]), start + 2000);
  const close = [anchor("campfire", 160, 250), anchor("quarry", 180, 255)];
  assert.deepEqual(layoutProductionMarkers(groups, close).map(value => value.group.place), ["quarry"], "ready work wins an overlap");
  assert.equal(layoutProductionMarkers(groups, [close[0], anchor("quarry", 180, 310)]).length, 2);
  assert.equal(layoutProductionMarkers(groups, close, [anchor("house", 150, 250)]).length, 0, "a construction timer keeps its footprint");
  assert.equal(layoutProductionMarkers(groups, []).length, 0);
  const object = { id: "quarry", place: "quarry", hitArea: [{ x: 100, y: 200 }, { x: 220, y: 280 }] };
  const view = { width: 320, height: 600 }, camera = { x: 160, y: 240, zoom: 1 };
  const first = projectConstructionAnchor(object, camera, view, { top: 100, bottom: 90 });
  const moved = projectConstructionAnchor(object, { ...camera, x: 180, zoom: 1.2 }, view, { top: 100, bottom: 90 });
  assert.notDeepEqual(first, moved);
  assert.equal(projectConstructionAnchor(object, { ...camera, x: 900 }, view), null);
});

test("split workshop placement reserves its actual height and clears the measured top HUD", () => {
  const groups = mapProductionGroups(state([job("workshop"), job("kiln"), job("quarry", { finishesAt: iso(start + 1000) })]), start + 2000);
  const shared = groups.find(group => group.place === "workshop");
  const upperReady = [anchor("quarry", 200, 250), anchor("workshop", 200, 305)];
  assert.deepEqual(layoutProductionMarkers(groups, upperReady).map(value => value.group.place), ["quarry"],
    "the upper part of an 88px badge cannot cover a higher ready 44px badge");
  assert.equal(layoutProductionMarkers(groups, [anchor("workshop", 200, 250), anchor("quarry", 200, 305)]).length, 2,
    "the taller badge extends upward, so the same spacing below is safe");
  assert.equal(layoutProductionMarkers([shared], [anchor("workshop", 200, 250)], [anchor("house", 200, 200)]).length, 0);
  const object = { id: "workshop", place: "workshop", hitArea: [{ x: 100, y: 200 }, { x: 220, y: 280 }] };
  const camera = { x: 160, y: 240, zoom: 1 }, view = { width: 320, height: 480 };
  assert.ok(projectConstructionAnchor(object, camera, view, { top: 130, bottom: 90 }));
  assert.equal(projectConstructionAnchor(object, camera, view, { top: 130, bottom: 90 }, productionMarkerHeight(shared)), null);
  assert.ok(projectConstructionAnchor(object, camera, view, { top: 90, bottom: 90 }, productionMarkerHeight(shared)));
  assert.equal(projectConstructionAnchor(object, { ...camera, x: 900 }, view, { top: 0, bottom: 0 }, 88), null);
});

test("badges retain 44px targets, accessible detail, hidden modal state and server time", () => {
  const saved = state([job("quarry")]), economy = { snapshot: saved, now: start + 30_000 };
  const props = { economy, groups: mapProductionGroups(saved, economy.now), anchors: [anchor("quarry")], onOpen() {} };
  const html = renderToStaticMarkup(WorldProductionStatus(props));
  assert.match(html, /<strong>59:30<\/strong>/); assert.match(html, /Открыть здание/);
  assert.match(html, /data-production-status="working"/); assert.match(html, /data-map-object="quarry"/);
  assert.equal(renderToStaticMarkup(WorldProductionStatus({ ...props, hidden: true })), "");
  assert.equal(renderToStaticMarkup(WorldProductionStatus({ ...props, anchors: [] })), "");
});

test("only production receipt effects attach to an existing host, always initially hidden", () => {
  const gain = { id: "claim", ownerPublicId: owner, revision: 2, source: "claim", stationId: "kiln", items: [{ itemId: "charcoal", quantity: 4 }] };
  const economy = { snapshot: state([]), inventoryGains: [gain, { ...gain, id: "trip", stationId: undefined },
    { ...gain, id: "purchase", source: "purchase" }, { ...gain, id: "foreign", ownerPublicId: "someone-else" }] };
  const html = renderToStaticMarkup(createElement(WorldProductionEffects, { economy, anchors: [anchor(constructionMapPlace("kiln"))], ready: true }));
  assert.equal((html.match(/data-production-gain=/g) ?? []).length, 1);
  assert.match(html, /data-production-gain="claim"/); assert.match(html, /data-map-object="workshop"/);
  assert.match(html, /hidden=""/); assert.match(html, /\+4/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(WorldProductionEffects, { economy, anchors: [], ready: true })), /data-production-gain=/);
});

test("shared receipt playback does not replay production effects after mount, hidden pages or owner switches", () => {
  const event = id => ({ id, ownerPublicId: owner, source: "claim", stationId: "quarry", items: [{ itemId: "stone", quantity: 8 }] });
  const old = event("old"), fresh = event("fresh"), shown = [], hidden = [];
  const playback = createInventoryGainPlayback(owner, [old], { show: value => { shown.push(value.id); return true; }, hide: value => hidden.push(value.id), schedule: () => 1, cancel() {} });
  playback.receive(owner, [old], true); assert.deepEqual(shown, []);
  playback.receive(owner, [old, fresh], true); playback.receive(owner, [fresh], true); assert.deepEqual(shown, ["fresh"]);
  playback.receive(owner, [fresh, event("background")], false); assert.deepEqual(hidden, ["fresh"]);
  playback.receive(owner, [fresh, event("background")], true); assert.deepEqual(shown, ["fresh"]);
  playback.receive("another", [event("switch")], true); assert.deepEqual(shown, ["fresh"]);
});

test("map-local feedback stays under object menus and disables decorative motion", async () => {
  const files = await Promise.all(["ui/hud/world-production-status.module.css", "ui/feedback/world-production-effects.module.css", "scene/world-scene.tsx"].map(name => readFile(`${root}features/world/${name}`, "utf8")));
  assert.match(files[0], /width: 124px; height: 44px; min-height: 44px/);
  assert.match(files[0], /markerSplit\.markerSplit \{ height: 88px; min-height: 88px/);
  assert.match(files[0], /sectionButton\.sectionButton[\s\S]*height: 44px; min-height: 44px/);
  assert.match(files[0], /sectionButton\.sectionButton:focus-visible/);
  assert.match(files[0], /prefers-reduced-motion: reduce/);
  assert.match(files[1], /z-index: 3; pointer-events: none/);
  assert.match(files[1], /prefers-reduced-motion: reduce[\s\S]*animation: none/);
  assert.match(files[2], /constructionAnchors.*anchors.filter/);
  assert.match(files[2], /objectMarkerHeight: place => markerHeights\.current\.get\(place\)/);
});


test("retired mine badges preserve saved quantities and deadlines, including unknown old recipes", () => {
  assert.equal(catalog.recipes.some(recipe => recipe.buildingId === "quarry"), false);
  const oldJob = job("quarry", { recipeId: "quarry_retired_v1", rewards: { stone: 17 }, catalogVersion: 1 });
  const saved = state([oldJob], 16), before = structuredClone(saved);
  const working = mapProductionGroups(saved, start + 30_000)[0].primary;
  assert.equal(working.recipeName, "Сохранённая добыча");
  assert.equal(working.remaining, 3570);
  assert.equal(working.phase, "working");
  assert.equal(mapProductionGroups(saved, finish)[0].primary.phase, "storage-blocked");
  saved.storage.available = 17;
  assert.equal(mapProductionGroups(saved, finish)[0].primary.phase, "ready");
  assert.deepEqual(saved.jobs, before.jobs);
  assert.deepEqual(mapProductionGroups(state([{ ...oldJob, kind: "exploration", targetId: "quarry_stone" }]), start), [],
    "new mining is an actor activity and never duplicates a production badge");
});

test("independent miner work belongs to the quarry badge without a hero journey badge or changed saved clock", () => {
  const route = catalog.explorations.find(entry => entry.id === "quarry_stone");
  const miner = { id: "miner", kind: "exploration", actorId: "miner", targetId: route.id,
    startedAt: iso(start), finishesAt: iso(start + route.seconds * 1000), rewards: { stone: 1 } };
  const saved = state([miner], 0), before = structuredClone(saved);
  const [group] = mapProductionGroups(saved, start + 60_000);
  assert.equal(group.place, "quarry"); assert.equal(group.entries.length, 1);
  assert.equal(group.primary.kind, "exploration"); assert.equal(group.primary.stationId, "quarry");
  assert.equal(group.primary.label, "Шахтёр добывает"); assert.equal(group.primary.remaining, 120);
  assert.equal(group.primary.recipeName, route.name);
  const readyAt = start + route.seconds * 1000;
  assert.equal(mapProductionGroups(saved, readyAt)[0].primary.phase, "storage-blocked");
  saved.storage.available = 1;
  assert.equal(mapProductionGroups(saved, readyAt)[0].primary.phase, "ready");
  assert.deepEqual(saved.jobs, before.jobs);
  for (const actorId of [undefined, null, "mochlik"]) {
    assert.deepEqual(mapProductionGroups(state([{ ...miner, actorId }]), start), [], "legacy mining remains a Mochlik journey");
  }
});
