import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthAtlasExplorer } = await vite.ssrLoadModule("/features/earth/use-earth-atlas-explorer.ts");
const { earthAtlasEntry, EARTH_ATLAS_MEETING_ID } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { EARTH_ATLAS_JOURNEYS, earthAtlasJourneyStop } = await vite.ssrLoadModule("/features/earth/earth-atlas-journeys.ts");
const eiffel = earthAtlasEntry("landmark:eiffel-tower"), sahara = earthAtlasEntry("region:sahara");
const context = { foreground: true, hidden: false, loaded: true };
function ready(controller, status = "ready") {
  const current = controller.getSnapshot();
  controller.setPreview({ entryId: current.entry.id, requestId: current.request.requestId, status });
}

test("catalogue choices create a canonical transient request without discovering or mutating v1 storage", () => {
  const c = createEarthAtlasExplorer("owner");
  assert.equal(c.selectEntry(eiffel), false);
  c.activate();
  assert.equal(c.selectEntry({ ...eiffel, center: [0, 0], zoom: 0 }), true);
  let value = c.getSnapshot();
  assert.equal(value.entry, eiffel); assert.deepEqual(value.request.center, eiffel.center);
  assert.equal(value.request.zoom, eiffel.zoom); assert.equal(value.request.entryId, eiffel.id);
  assert.equal(value.journeyState, null); assert.equal(value.preview, null);
  assert.equal(c.canDiscover(eiffel, context), false, "selecting is never actual preview readiness");
  assert.equal(c.selectEntry(earthAtlasEntry(EARTH_ATLAS_MEETING_ID)), false);
  assert.equal(c.selectEntry({ ...eiffel, id: "unknown" }), false);
  assert.equal(c.getSnapshot(), value);
  c.selectEntry(eiffel); assert.ok(c.getSnapshot().request.requestId > value.request.requestId, "repeat selection can explicitly reframe");
});

test("manual save requires the exact latest selected request, a ready frame and current foreground/storage", () => {
  const c = createEarthAtlasExplorer("owner"); c.activate(); c.selectEntry(eiffel);
  for (const status of ["moving", "loading", "away", "unavailable"]) {
    ready(c, status); assert.equal(c.canDiscover(eiffel, context), false, status);
  }
  ready(c); assert.equal(c.canDiscover(eiffel, context), true);
  assert.equal(c.canDiscover(sahara, context), false);
  for (const denied of [{ foreground: false }, { hidden: true }, { loaded: false }])
    assert.equal(c.canDiscover(eiffel, { ...context, ...denied }), false);
  const first = c.getSnapshot().request;
  c.selectEntry(sahara);
  c.setPreview({ entryId: eiffel.id, requestId: first.requestId, status: "ready" });
  assert.equal(c.previewRef.current, null); assert.equal(c.canDiscover(sahara, context), false);
  ready(c); assert.equal(c.canDiscover(sahara, context), true);
  c.setPreview({ entryId: eiffel.id, requestId: first.requestId, status: "ready" });
  assert.equal(c.canDiscover(sahara, context), true, "late callbacks cannot replace current readiness");
  c.focusEntry(sahara); assert.equal(c.canDiscover(sahara, context), false, "a same-entry request invalidates the old frame immediately");
  c.setPreview({ entryId: sahara.id, requestId: first.requestId, status: "ready" });
  assert.equal(c.canDiscover(sahara, context), false);
  ready(c); c.setPreview(null); assert.equal(c.canDiscover(sahara, context), false);
});

test("synchronous preview invalidation protects a previously rendered save handler before a new render", () => {
  const c = createEarthAtlasExplorer("owner"); c.activate(); c.selectEntry(eiffel); ready(c);
  const oldRendered = c.getSnapshot(), oldSave = () => c.canDiscover(oldRendered.entry, context);
  assert.equal(oldSave(), true);
  ready(c, "moving"); assert.equal(oldSave(), false);
  assert.equal(c.previewRef.current.status, "moving");
  ready(c); c.close(); assert.equal(oldSave(), false);
  assert.equal(c.getSnapshot().request, null);
});

test("journey survives catalogue unmount/reopen, direct jumps and explicit recenter; close preserves a resumable route", () => {
  const c = createEarthAtlasExplorer("owner"); c.activate();
  const route = EARTH_ATLAS_JOURNEYS[0];
  assert.equal(c.startJourney(route.id), true);
  const first = c.getSnapshot(), retainedRoute = first.journeyState;
  // A catalogue is just a subscriber and owns no route lifetime.
  const unsubscribe = c.subscribe(() => {}); unsubscribe();
  assert.equal(c.getSnapshot().journeyState, retainedRoute);
  assert.equal(c.navigate({ type: "select", stopIndex: route.stops.length - 1 }), true);
  const last = c.getSnapshot(); assert.equal(last.entry.id, route.stops.at(-1).entryId);
  assert.ok(last.request.requestId > first.request.requestId);
  assert.equal(c.focusEntry(last.entry), true); assert.equal(c.getSnapshot().journeyState, last.journeyState);
  c.close(); assert.equal(c.getSnapshot().entry, null); assert.equal(c.getSnapshot().request, null);
  assert.equal(c.getSnapshot().journeyState.stopIndex, route.stops.length - 1);
  c.navigate({ type: "select", stopIndex: 1 });
  assert.equal(c.getSnapshot().entry, earthAtlasJourneyStop(c.getSnapshot().journeyState).entry);
  const selected = c.getSnapshot();
  for (const stopIndex of [-1, NaN, 1.5, route.stops.length]) assert.equal(c.navigate({ type: "select", stopIndex }), false);
  assert.equal(c.getSnapshot(), selected);
  c.navigate({ type: "stop" }); assert.equal(c.getSnapshot().journeyState, null); assert.equal(c.getSnapshot().request, null);
});

test("deactivated and replaced owners cannot reuse a completed frame or alter the new owner", () => {
  const a = createEarthAtlasExplorer("owner-a"), b = createEarthAtlasExplorer("owner-b");
  const release = a.activate(); a.selectEntry(eiffel); ready(a); const old = a.getSnapshot().request;
  release(); b.activate();
  a.setPreview({ entryId: eiffel.id, requestId: old.requestId, status: "ready" });
  assert.equal(a.canDiscover(eiffel, context), false); assert.equal(a.selectEntry(sahara), false);
  assert.equal(b.getSnapshot().entry, null); assert.equal(b.getSnapshot().journeyState, null);
  assert.equal(b.canDiscover(eiffel, context), false);
  const anonymous = createEarthAtlasExplorer(null); anonymous.activate(); assert.equal(anonymous.selectEntry(eiffel), false);
});
