import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const store = await vite.ssrLoadModule("/features/earth/model-placement.ts");
const { createEarthModelEditorHistory } = await vite.ssrLoadModule("/features/earth/dev/earth-model-editor-history.ts");
const histories = new Set();
afterEach(() => {
  for (const history of histories) history.dispose();
  histories.clear();
  store.resetEarthModelPlacements();
});
function createHistory(connect = true) {
  const history = createEarthModelEditorHistory();
  histories.add(history);
  if (connect) history.connect();
  return history;
}
const placement = () => store.getEarthModelPlacements()[0];
const document = () => store.exportEarthModelPlacements();
const update = patch => store.updateEarthModelPlacement("eiffel-tower", patch);

test("construction is side-effect-free and connection captures the hydrated baseline", () => {
  const history = createHistory(false), empty = history.getSnapshot();
  update({ headingDegrees: 20 });
  assert.equal(history.getSnapshot(), empty);
  assert.equal(history.undo(), false);
  const hydrated = document();
  history.connect();
  assert.equal(history.getSnapshot(), empty);
  assert.equal(history.undo(), false);
  update({ headingDegrees: 45 });
  assert.equal(history.undo(), true);
  assert.equal(document(), hydrated, "undo stops at the connected draft rather than published defaults");
});

test("one drag transaction groups all coordinates and separates surrounding actions", () => {
  const history = createHistory(), initial = document();
  update({ headingDegrees: 5 });
  const beforeDrag = document();
  history.beginTransaction();
  history.beginTransaction();
  for (let index = 1; index <= 20; index++) update({ longitude: 2.29 + index / 10_000, latitude: 48.85 + index / 10_000 });
  assert.equal(history.getSnapshot().undoCount, 2);
  history.endTransaction();
  const afterDrag = document();
  update({ heightMeters: 250 });
  assert.equal(history.getSnapshot().undoCount, 3);
  assert.equal(history.undo(), true); assert.equal(document(), afterDrag);
  assert.equal(history.undo(), true); assert.equal(document(), beforeDrag);
  assert.equal(history.undo(), true); assert.equal(document(), initial);
  assert.equal(history.undo(), false);
  assert.equal(history.redo(), true); assert.equal(document(), beforeDrag);
  assert.equal(history.redo(), true); assert.equal(document(), afterDrag);
});

test("snapshots are immutable and stable across reads and transaction updates with the same controls state", () => {
  const history = createHistory();
  let notifications = 0;
  const unsubscribe = history.subscribe(() => notifications++);
  const initial = history.getSnapshot();
  assert.equal(history.getSnapshot(), initial);
  assert.throws(() => { initial.canUndo = true; });
  history.beginTransaction();
  assert.equal(history.getSnapshot(), initial);
  update({ headingDegrees: 10 });
  const pending = history.getSnapshot();
  assert.notEqual(pending, initial);
  assert.deepEqual(pending, { canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 });
  update({ headingDegrees: 20 });
  assert.equal(history.getSnapshot(), pending);
  history.endTransaction();
  assert.equal(history.getSnapshot(), pending);
  assert.equal(notifications, 1, "live drag frames do not publish duplicate control snapshots");
  unsubscribe(); history.undo(); assert.equal(notifications, 1);
});

test("undo during an unfinished gesture restores its complete start and leaves no stale transaction after redo", () => {
  const history = createHistory(), initial = document();
  history.beginTransaction();
  update({ headingDegrees: 25, longitude: 2.3, elevationMeters: 10 });
  update({ headingDegrees: 30, longitude: 2.4, elevationMeters: 20 });
  const gesture = document();
  assert.equal(history.getSnapshot().canUndo, true);
  assert.equal(history.undo(), true); assert.equal(document(), initial);
  assert.equal(history.redo(), true); assert.equal(document(), gesture);
  update({ exclusionRadiusMeters: 70 });
  assert.equal(history.getSnapshot().undoCount, 2);
  assert.equal(history.undo(), true); assert.equal(document(), gesture);
  assert.equal(history.undo(), true); assert.equal(document(), initial);
});

test("reset and imported full documents are ordinary undoable actions", () => {
  const history = createHistory(), initial = document();
  update({ longitude: 3, latitude: 49, heightMeters: 280, headingDegrees: 45,
    elevationMeters: -5, exclusionRadiusMeters: 90, excludeBuildings: false });
  const edited = document();
  store.resetEarthModelPlacements();
  assert.equal(document(), initial);
  assert.equal(history.undo(), true); assert.equal(document(), edited);
  assert.equal(history.redo(), true); assert.equal(document(), initial);
  const imported = { version: 1, placements: [{ ...placement(), longitude: 100, latitude: -30, headingDegrees: -90 }] };
  store.importEarthModelPlacements(JSON.stringify(imported));
  const importedState = document();
  assert.equal(history.undo(), true); assert.equal(document(), initial);
  assert.equal(history.undo(), true); assert.equal(document(), edited);
  assert.equal(history.redo(), true); assert.equal(document(), initial);
  assert.equal(history.redo(), true); assert.equal(document(), importedState);
  assert.deepEqual(Object.keys(JSON.parse(importedState)).sort(), ["placements", "version"], "history metadata is never exported with models");
});

test("invalid updates and net no-op transactions preserve the redo branch", () => {
  const history = createHistory(), initial = document();
  update({ headingDegrees: 30 });
  history.undo();
  const before = history.getSnapshot();
  assert.throws(() => update({ heightMeters: 0 }));
  assert.throws(() => store.importEarthModelPlacements("{broken"));
  update({ headingDegrees: placement().headingDegrees });
  history.beginTransaction(); history.endTransaction();
  assert.equal(history.getSnapshot(), before);
  history.beginTransaction();
  update({ headingDegrees: 20 });
  assert.equal(history.getSnapshot().canUndo, true);
  assert.equal(history.getSnapshot().canRedo, false);
  store.importEarthModelPlacements(initial);
  assert.equal(history.getSnapshot().canRedo, true);
  history.endTransaction();
  assert.deepEqual(history.getSnapshot(), before);
  assert.equal(history.redo(), true); assert.equal(placement().headingDegrees, 30);
  history.undo();
  update({ heightMeters: 300 });
  assert.equal(history.getSnapshot().canRedo, false, "a committed real change starts a new branch");
});

test("redo during a real active transaction commits that new action and retires the old redo branch", () => {
  const history = createHistory();
  update({ headingDegrees: 30 }); history.undo();
  history.beginTransaction(); update({ heightMeters: 290 });
  assert.equal(history.redo(), false);
  assert.equal(placement().heightMeters, 290);
  update({ elevationMeters: 5 });
  assert.equal(history.getSnapshot().undoCount, 2, "redo has closed the earlier transaction");
  history.undo(); assert.equal(placement().heightMeters, 290); assert.equal(placement().elevationMeters, 0);
});

test("history retains at most 100 complete actions including a pending transaction", () => {
  const history = createHistory();
  for (let index = 1; index <= 105; index++) update({ headingDegrees: index });
  assert.equal(history.getSnapshot().undoCount, 100);
  history.beginTransaction(); update({ headingDegrees: 106 });
  assert.equal(history.getSnapshot().undoCount, 100);
  history.endTransaction();
  let undone = 0;
  while (history.undo()) undone++;
  assert.equal(undone, 100); assert.equal(placement().headingDegrees, 6);
  assert.equal(history.getSnapshot().redoCount, 100);
  let redone = 0;
  while (history.redo()) redone++;
  assert.equal(redone, 100); assert.equal(placement().headingDegrees, 106);
});

test("disconnect and disposal release store tracking and allow an isolated StrictMode reconnect", () => {
  const history = createHistory(false);
  const cleanupOld = history.connect();
  update({ headingDegrees: 10 });
  cleanupOld();
  update({ headingDegrees: 20 });
  assert.equal(history.getSnapshot().canUndo, false);
  assert.equal(history.undo(), false);
  const cleanupNew = history.connect();
  cleanupOld();
  update({ headingDegrees: 30 });
  assert.equal(history.undo(), true); assert.equal(placement().headingDegrees, 20);
  cleanupNew(); history.dispose(); history.dispose();
  update({ headingDegrees: 40 });
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
  history.connect(); update({ headingDegrees: 50 });
  assert.equal(history.undo(), true); assert.equal(placement().headingDegrees, 40);
});
