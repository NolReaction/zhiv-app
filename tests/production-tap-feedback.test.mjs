import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { jobTapBoostPercent } = await vite.ssrLoadModule("/features/economy/ui/production/tap-boost-work-badge.tsx");
const { WorldProductionSlots } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-slots.tsx");
const { WorldMiningProduction } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-mining-production.tsx");
const { TapBoostIndicator } = await vite.ssrLoadModule("/features/game/tap-boost-indicator.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const job = (id, patch = {}) => ({ id, kind: "production", targetId: "woodlot", recipeId: "make_rope", targetLevel: null,
  startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 180_000).toISOString(),
  rewards: { rope: 1 }, cost: { coins: 0, items: {} }, ...patch });
const state = (jobs, target = jobs[0].id) => ({ ownerPublicId: "ME", revision: 4, catalog: economyCatalog,
  buildings: { home: 5, quarry: 5, woodlot: 3, warehouse: 5 }, productionSlots: { woodlot: 3 }, jobs,
  inventory: {}, wallet: { coins: 100, pearls: 0 }, storage: { capacity: 250, available: 250, used: 0, reserved: 0 },
  tapBoost: { charge: 1000, powerBps: 2000, grantedAt: new Date(now).toISOString(), appliedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), jobId: target } });
const controller = snapshot => ({ snapshot, now, busy: false, uncertain: false, error: null, retryAt: 0,
  directActionsAvailable: true, act() { return true; }, refresh() {}, retry() {} });

test("help appears only on its confirmed eligible unfinished target and stops at expiration", () => {
  const snapshot = state([job("one"), job("two")]);
  assert.equal(jobTapBoostPercent(snapshot, "one", now), 20);
  assert.equal(jobTapBoostPercent(snapshot, "two", now), 0);
  assert.equal(jobTapBoostPercent(snapshot, "one", now + 60_000), 0);
  assert.equal(jobTapBoostPercent({ ...snapshot, jobs: [] }, "one", now), 0, "pending-only local job is not a confirmed target");
  assert.equal(jobTapBoostPercent({ ...snapshot, jobs: [job("one", { kind: "construction" })] }, "one", now), 0);
  assert.equal(jobTapBoostPercent({ ...snapshot, jobs: [job("one", { finishesAt: new Date(now).toISOString() })] }, "one", now), 0);
});

test("a station with multiple jobs highlights exactly one work and removes the mark after expiration", () => {
  const economy = controller(state([job("one"), job("two")]));
  const render = () => renderToStaticMarkup(createElement(WorldProductionSlots, { economy, stationId: "woodlot" }));
  const active = render();
  assert.equal((active.match(/data-tap-boost-power="20"/g) ?? []).length, 1);
  assert.equal((active.match(/aria-label="Помощь тапами: скорость выше на 20%"/g) ?? []).length, 1);
  economy.now += 60_000;
  assert.doesNotMatch(render(), /data-tap-boost-power|Помощь тапами: скорость/);
});

test("a partially ready mining batch keeps its targeted help but never marks another job", () => {
  const mining = job("mine", { kind: "exploration", actorId: "miner", targetId: "quarry_stone", recipeId: null,
    rewards: { stone: 1 }, startedAt: new Date(now - 600_000).toISOString(), finishesAt: new Date(now + 1200_000).toISOString(),
    miningBatch: { quantity: 10, claimed: 0, unitSeconds: 180, unitRewards: { stone: 1 } } });
  const economy = controller(state([mining]));
  const render = () => renderToStaticMarkup(createElement(WorldMiningProduction, { economy, onOpenPantry() {} }));
  assert.match(render(), /Помощь тапами · \+20%/);
  assert.match(render(), /Добыто 3 из 10/);
  economy.snapshot.tapBoost.jobId = "other";
  assert.doesNotMatch(render(), /data-tap-boost-power|Помощь тапами ·/);
});

test("compact companion offers exact details without a second always-visible countdown", () => {
  const snapshot = state([job("one")]);
  const html = renderToStaticMarkup(createElement(TapBoostIndicator, { snapshot, now }));
  const summary = html.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
  assert.match(summary, /\+20%/);
  assert.doesNotMatch(summary, /60 с|1000/);
  assert.match(html, /Время помощи.*60 с/);
  assert.match(html, /Заряд.*1000 \/ 1000/);
  assert.doesNotMatch(html, /role="progressbar"/);
});
