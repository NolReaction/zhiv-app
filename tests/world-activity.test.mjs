import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { worldActivity, activityRouteKind, activityStatus, activityTime } = await vite.ssrLoadModule("/features/world/ui/hud/world-activity.ts");
const { WorldActivityBadge, WorldActivityDescription } = await vite.ssrLoadModule("/features/world/ui/hud/world-activity-badge.tsx");
const { MochlikTerrarium } = await vite.ssrLoadModule("/features/mochlik/mochlik-terrarium.tsx");
const { economySceneJourney, economySceneActivity } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
after(() => vite.close());
const now = Date.parse("2026-10-04T12:00:00Z");
const time = value => new Date(now + value).toISOString();
const activity = (overrides = {}) => ({ id: "trip", kind: "exploration", label: "Лесная разведка", routeId: "forest", startedAt: time(-30_000), finishesAt: time(30_000), ...overrides });
const production = (overrides = {}) => ({ id: "berries", kind: "production", targetId: "garden", recipeId: "grow_berries", rewards: { berries: 6 }, startedAt: time(-600_000), finishesAt: time(0), ...overrides });
const economy = jobs => ({ jobs, catalog: economyCatalog });

test("circle progress uses saved timestamps and keeps returned finds until the actual claim", () => {
  const route = activity();
  assert.equal(worldActivity(route, undefined, now).progress, .5);
  assert.equal(worldActivity(route, undefined, now - 60_000).progress, 0);
  assert.equal(worldActivity(route, undefined, now + 30_000).progress, 1);
  assert.equal(activityStatus(worldActivity(route, undefined, now + 86_400_000)), "Находки ждут");
  assert.equal(worldActivity(null, undefined, now), null);
  for (const bad of [{ startedAt: "invalid" }, { finishesAt: time(-30_000) }, { finishesAt: time(-31_000) }]) assert.equal(worldActivity(activity(bad), undefined, now), null);
  assert.equal(worldActivity(route, undefined, NaN), null);
});

test("every route has a recognizable sector icon, including saved fishing journeys", () => {
  const expected = { forest: "forest", forest_camp: "forest", old_woodland: "forest", uplands: "forest", shore: "fishing", shore_camp: "fishing", coastal_deposits: "fishing", cave: "cave", deep_cave: "cave", abandoned_quarry: "cave",
    quarry_stone: "cave", quarry_stone_overnight: "cave", quarry_ore: "cave", quarry_clay: "cave", quarry_sand: "cave", quarry_shift: "cave", quarry_deep_face: "cave", quarry_supply: "cave" };
  for (const route of economyCatalog.explorations) assert.equal(activityRouteKind(route.id), expected[route.id]);
  for (const routeId of ["fishing_5", "fishing_15", "fishing_30", "fishing_60", "brook_path"]) {
    assert.equal(worldActivity(null, { journeys: [{ ...activity(), routeId }] }, now).kind, "fishing");
  }
  assert.equal(worldActivity(activity({ label: "Лесной лагерь · 2 ч" }), undefined, now).label, "Лесной лагерь");
});

test("home activity prioritizes an unclaimed exploration, then earliest production, without making work an absence", () => {
  const later = production({ id: "later", finishesAt: time(500_000) });
  const ready = production({ id: "ready", finishesAt: time(-1_000) });
  const trip = { ...activity({ finishesAt: time(-1) }), targetId: "shore", rewards: { fish: 2 } };
  const jobs = [later, ready, trip];
  const status = economySceneActivity(economy(jobs));
  assert.equal(status.id, "trip"); assert.equal(status.routeId, "shore"); assert.equal(status.kind, "exploration");
  const work = economySceneActivity(economy(jobs.slice(0, 2)));
  assert.equal(work.id, "ready"); assert.equal(work.itemId, "berries"); assert.equal(work.kind, "production");
  assert.equal(economySceneJourney(economy(jobs.slice(0, 2))), null);
  assert.deepEqual(jobs.map(job => job.id), ["later", "ready", "trip"]);
  assert.equal(economySceneActivity(economy([{ ...later, kind: "construction" }])), null);
});

test("berries distinguish growing, ripe and confirmed gathering, including delayed visual return", () => {
  const collection = { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null };
  let value = economySceneActivity(economy([production({ finishesAt: time(30_000), collection })]));
  assert.equal(worldActivity(value, undefined, now).collectionPhase, undefined);
  value = economySceneActivity(economy([production({ collection })]));
  assert.equal(activityStatus(worldActivity(value, undefined, now)), "Ягоды созрели");
  value = economySceneActivity(economy([production({ collection: { ...collection, startedAt: time(-4_000), finishesAt: time(4_000) } })]));
  const gathering = worldActivity(value, undefined, now);
  assert.equal(gathering.progress, 1, "The crop is grown; the server's eight-second minimum is not the duration of the visible walk"); assert.equal(gathering.ready, false); assert.equal(activityStatus(gathering), "Собирает ягоды");
  const returning = worldActivity(value, undefined, now + 30_000);
  assert.equal(returning.progress, 1); assert.equal(returning.ready, false); assert.equal(activityStatus(returning), "Собирает ягоды");
  assert.equal(activityStatus(worldActivity(economySceneActivity(economy([production()])), undefined, now)), "Можно забрать", "Legacy production without a collection still uses ordinary completion");
});

test("compact activity time stays readable across seconds, minutes, hours and days", () => {
  assert.equal(activityTime(5), "5 с"); assert.equal(activityTime(59.1), "1 мин");
  assert.equal(activityTime(61), "2 мин"); assert.equal(activityTime(3600), "1 ч");
  assert.equal(activityTime(3660), "1 ч 1 мин"); assert.equal(activityTime(90000), "1 д 1 ч");
});

test("circle shows an item or route dial and exposes a separate accessible progress description", () => {
  const status = worldActivity(activity({ routeId: "shore" }), undefined, now);
  const badge = renderToStaticMarkup(createElement(WorldActivityBadge, { activity: status }));
  assert.match(badge, /data-world-activity="fishing"/); assert.match(badge, /stroke-dashoffset="50"/); assert.match(badge, /Ещё 30 с/);
  assert.doesNotMatch(badge, /<button|<canvas/);
  const work = worldActivity(economySceneActivity(economy([production()])), undefined, now);
  assert.match(renderToStaticMarkup(createElement(WorldActivityBadge, { activity: work })), /data-item-icon="berries"/);
  const description = renderToStaticMarkup(createElement(WorldActivityDescription, { activity: status, id: "activity" }));
  assert.match(description, /role="progressbar" aria-label="Лесная разведка"/); assert.match(description, /aria-valuenow="50"/); assert.match(description, /aria-valuetext="Ещё 30 с"/);
  const html = renderToStaticMarkup(createElement(MochlikTerrarium, { wakeSignal: 0, nowMs: now, timeZone: "UTC", activity: status }));
  assert.match(html, /aria-hidden="true"[\s\S]*data-world-activity="fishing"[\s\S]*<\/div><span id="mochlik-activity-status"/);
});

test("harvesting is accessible as ongoing work before and after the server minimum, without a countdown", () => {
  const value = economySceneActivity(economy([production({ collection: {
    kind: "berry_harvest", seconds: 8, startedAt: time(-4_000), finishesAt: time(4_000),
  } })]));
  for (const checkedAt of [now, now + 30_000]) {
    const status = worldActivity(value, undefined, checkedAt);
    const badge = renderToStaticMarkup(createElement(WorldActivityBadge, { activity: status }));
    assert.match(badge, /Сбор ягод/);
    assert.doesNotMatch(badge, /Готово|Ещё|\d+ с<|data-ready="true"/);
    const description = renderToStaticMarkup(createElement(WorldActivityDescription, { activity: status, id: "activity" }));
    assert.match(description, /role="progressbar" aria-label="Ягодный куст"/);
    assert.match(description, /aria-valuetext="Собирает ягоды"/);
    assert.doesNotMatch(description, /aria-valuenow=|Откройте мир, чтобы забрать/);
  }
});

test("ready expeditions are explicit in the keyboard-accessible map dock", async () => {
  const { default: WorldView } = await vite.ssrLoadModule("/features/world/world-view.tsx");
  const state = { resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshop: false, journeys: [], collection: [], inventory: [], equipment: {}, completedJourneys: 0 };
  const trip = { ...activity({ finishesAt: time(-1) }), targetId: "forest", rewards: {} };
  const snapshot = { ...economy([trip]), wallet: { coins: 0, pearls: 0 }, buildings: { home: 1 }, storage: { used: 0, reserved: 0, capacity: 200, available: 200 } };
  const props = { world: { snapshot: { state, gifts: [] }, now, act() {} }, economy: { snapshot, now, busy: false, uncertain: false, error: null, retryAt: 0 }, ownerPublicId: "test", timeZone: "UTC", onClose() {}, displayName: "Мохлик", level: 1, wakeSignal: 0, bestStreakDays: 0 };
  let html = renderToStaticMarkup(createElement(WorldView, props));
  assert.match(html, /<button[^>]+data-world-quick="expeditions" data-expedition-ready="true"/);
  assert.match(html, /aria-label="В путь\. Вылазка завершена — забрать находки"/); assert.match(html, /Находки ждут/);
  snapshot.jobs[0].finishesAt = time(30_000);
  html = renderToStaticMarkup(createElement(WorldView, props));
  assert.doesNotMatch(html, /data-expedition-ready="true"/); assert.match(html, /aria-label="В путь\. Мохлик в пути"/);
});
