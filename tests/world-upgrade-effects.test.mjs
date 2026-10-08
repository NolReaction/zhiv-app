import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { constructionCompletions } = await vite.ssrLoadModule("/features/economy/domain/construction-completion.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { WorldUpgradeEffects } = await vite.ssrLoadModule("/features/world/ui/feedback/world-upgrade-effects.tsx");
const owner = "AAAA-0000-0001";
const job = (targetId = "home", targetLevel = 2) => ({ id: crypto.randomUUID(), kind: "construction", targetId, targetLevel });
const state = (revision = 0, jobs = []) => ({ ownerPublicId: owner, revision, serverTime: "2026-10-04T00:00:00.000Z", jobs, buildings: { home: 1 }, catalog: economyCatalog });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("completion requires a known paid job removed and its exact level confirmed in a newer account snapshot", () => {
  const construction = job(), before = state(3, [construction]), after = { ...state(4), buildings: { home: 2 } };
  const saved = structuredClone(before);
  assert.deepEqual(constructionCompletions(before, after), [{ id: construction.id, stationId: "home", level: 2 }]);
  for (const [previous, next] of [[null, after], [before, { ...after, ownerPublicId: "BBBB-0000-0001" }],
    [before, { ...after, revision: 3 }], [before, { ...after, revision: 2 }], [before, state(4)],
    [before, { ...after, jobs: [construction] }], [before, { ...after, buildings: { home: 3 } }],
    [state(3), after], [{ ...before, jobs: [{ ...construction, kind: "production" }] }, after]]) {
    assert.deepEqual(constructionCompletions(previous, next), []);
  }
  assert.deepEqual(before, saved, "visual completion detection cannot mutate a saved job");
});

test("all independently completed hosts retain their own event including first construction and interior stations", () => {
  const jobs = [job("home", 2), job("warehouse", 2), job("kiln", 1), job("garden", 2)];
  const before = { ...state(3, jobs), buildings: { home: 1, warehouse: 1, garden: 1 } };
  const after = { ...state(4), buildings: { home: 2, warehouse: 2, garden: 2, kiln: 1 } };
  assert.deepEqual(constructionCompletions(before, after), jobs.map(job => ({ id: job.id, stationId: job.targetId, level: job.targetLevel })));
});

test("a local ordinary or pearl claim emits once; loading and polling levels emit nothing", async () => {
  for (const action of ["claim_job", "speedup_construction"]) {
    const construction = job(), initial = state(1, [construction]), completed = { ...state(2), buildings: { home: 2 } };
    let current = initial;
    const session = createEconomySession(owner, { get: async () => current, send: async () => {
      current = completed;
      return { state: current, message: "Постройка готова", acceptedRevision: 2, replayed: false };
    } }, () => assert.fail());
    const stop = session.activate();
    await session.refresh();
    assert.deepEqual(session.getSnapshot().completedConstructions, []);
    session.act(action, construction.id); await flush();
    assert.deepEqual(session.getSnapshot().completedConstructions, [{ id: construction.id, stationId: "home", level: 2 }]);
    await session.refresh(); await session.retry();
    assert.equal(session.getSnapshot().completedConstructions.length, 1);
    stop();
    const loaded = createEconomySession(owner, { get: async () => completed }, () => assert.fail());
    const stopLoaded = loaded.activate(); await loaded.refresh();
    assert.deepEqual(loaded.getSnapshot().completedConstructions, []);
    stopLoaded();
  }
});

test("a lost command response celebrates only when its same receipt is confirmed; recreated sessions do not replay it", async () => {
  const construction = job(), initial = state(1, [construction]), completed = { ...state(2), buildings: { home: 2 } };
  let sends = 0, current = initial;
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const transport = { get: async () => current, send: async () => {
    current = completed;
    if (++sends === 1) throw Error("Response lost");
    return { state: current, message: "Постройка готова", acceptedRevision: 2, replayed: true };
  } };
  const session = createEconomySession(owner, transport, () => assert.fail(), storage);
  const stop = session.activate(); await session.refresh(); session.act("claim_job", construction.id); await flush();
  assert.deepEqual(session.getSnapshot().completedConstructions, []);
  await session.retry();
  assert.equal(session.getSnapshot().completedConstructions.length, 1);
  stop();

  sends = 0; current = initial;
  const interrupted = createEconomySession(owner, transport, () => assert.fail(), storage);
  const stopInterrupted = interrupted.activate(); await interrupted.refresh(); interrupted.act("claim_job", construction.id); await flush(); stopInterrupted();
  const resumed = createEconomySession(owner, transport, () => assert.fail(), storage);
  const stopResumed = resumed.activate(); await resumed.refresh(); await resumed.retry();
  assert.deepEqual(resumed.getSnapshot().completedConstructions, []);
  stopResumed();
});

test("construction seen complete only through a refresh is not a local celebration", async () => {
  const construction = job(); let current = state(1, [construction]);
  const session = createEconomySession(owner, { get: async () => current }, () => assert.fail());
  const stop = session.activate(); await session.refresh();
  current = { ...state(2), buildings: { home: 2 } }; await session.refresh();
  assert.deepEqual(session.getSnapshot().completedConstructions, []);
  stop();
});

test("effect begins hidden and follows the real host roof including horizontal edge compensation", () => {
  const event = { id: "construction", stationId: "warehouse", level: 2 };
  const economy = { snapshot: state(2), completedConstructions: [event] };
  const anchor = { objectId: "home", place: "house", x: 70, y: 240, pointerOffset: -50 };
  const html = renderToStaticMarkup(createElement(WorldUpgradeEffects, { economy, anchors: [anchor], ready: true }));
  assert.match(html, /hidden=""[^>]+data-upgrade-event="construction"/);
  assert.match(html, /data-upgrade-target="warehouse" data-map-object="home"/);
  assert.match(html, /left:20px;top:250px;--badge-offset:50px/);
  assert.match(html, /Уровень 2/);
  assert.match(html, /Кладовая/);
  const offscreen = renderToStaticMarkup(createElement(WorldUpgradeEffects, { economy, anchors: [], ready: true }));
  assert.doesNotMatch(offscreen, /data-upgrade-event/);
});
