import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EARTH_ATLAS_ENTRIES, earthAtlasEntry } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { createEarthAtlasDiscoveryFeedback, EARTH_ATLAS_DISCOVERY_DURATION_MS } = await vite.ssrLoadModule("/features/earth/earth-atlas-discovery-feedback.ts");
const { EarthAtlasDiscovery } = await vite.ssrLoadModule("/features/earth/earth-atlas-discovery.tsx");
const { createEarthAtlasStore } = await vite.ssrLoadModule("/features/earth/earth-atlas-storage.ts");
const { useEarthAtlas } = await vite.ssrLoadModule("/features/earth/use-earth-atlas.ts");
const sahara = earthAtlasEntry("region:sahara"), eiffel = earthAtlasEntry("landmark:eiffel-tower");

function clock() {
  let now = 0, next = 0;
  const pending = new Map(), callbacks = [];
  return {
    scheduler: {
      schedule(callback, delay) { const id = ++next; pending.set(id, { callback, due: now + delay }); callbacks.push(callback); return id; },
      cancel(id) { pending.delete(id); },
    },
    callbacks,
    pending,
    advance(time) { now += time; for (const [id, timer] of pending) if (timer.due <= now) { pending.delete(id); timer.callback(); } },
  };
}

test("discovery feedback requires a live owner and does not touch atlas persistence", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler);
  assert.equal(feedback.show(sahara, 1), false);
  assert.equal(feedback.getServerSnapshot(), null);
  const stop = feedback.activate();
  assert.equal(feedback.show(sahara, 1), true);
  assert.equal(feedback.getSnapshot().entry.id, sahara.id);
  stop();
  assert.equal(feedback.getSnapshot(), null);
  assert.equal(feedback.show(eiffel, 2), false);
  assert.equal(timer.pending.size, 0);
  const anonymous = createEarthAtlasDiscoveryFeedback(null, timer.scheduler); anonymous.activate();
  assert.equal(anonymous.show(sahara, 1), false);
});

test("feedback accepts only bounded catalogue progress and uses canonical public text", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler); feedback.activate();
  for (const count of [0, -1, NaN, Infinity, 1.5, EARTH_ATLAS_ENTRIES.length + 1]) assert.equal(feedback.show(sahara, count), false);
  assert.equal(feedback.show({ ...sahara, id: "unknown", title: "untrusted" }, 1), false);
  assert.equal(timer.pending.size, 0);
  assert.equal(feedback.show({ ...sahara, title: "untrusted" }, 1), true);
  assert.equal(feedback.getSnapshot().entry.title, "Сахара");
  assert.equal(feedback.getSnapshot().total, EARTH_ATLAS_ENTRIES.length);
});

test("duplicate callbacks do not repeat the announcement or extend its lifetime", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler); feedback.activate();
  let announcements = 0; feedback.subscribe(() => { announcements++; });
  feedback.show(sahara, 1);
  const first = feedback.getSnapshot();
  timer.advance(EARTH_ATLAS_DISCOVERY_DURATION_MS - 1);
  assert.equal(feedback.show(sahara, 1), false);
  assert.equal(feedback.getSnapshot(), first);
  assert.equal(announcements, 1);
  timer.advance(1);
  assert.equal(feedback.getSnapshot(), null);
  assert.equal(feedback.show(sahara, 1), false, "a delayed duplicate remains silent after expiry");
  assert.equal(announcements, 2);
  assert.equal(timer.pending.size, 0);
});

test("new openings replace one compact notice and stale timers cannot clear it", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler); feedback.activate();
  feedback.show(sahara, 1);
  const oldTimeout = timer.callbacks[0];
  timer.advance(1000);
  feedback.show(eiffel, 2);
  assert.equal(timer.pending.size, 1);
  oldTimeout();
  assert.equal(feedback.getSnapshot().entry.id, eiffel.id);
  timer.advance(EARTH_ATLAS_DISCOVERY_DURATION_MS - 1);
  assert.equal(feedback.getSnapshot().openedCount, 2);
  timer.advance(1);
  assert.equal(feedback.getSnapshot(), null);
});

test("leaving a view cancels old feedback and its callback stays inert on return", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler);
  const stop = feedback.activate(); feedback.show(sahara, 1);
  const oldTimeout = timer.callbacks[0];
  stop();
  feedback.activate(); feedback.show(eiffel, 2);
  oldTimeout();
  assert.equal(feedback.getSnapshot().entry.id, eiffel.id);
  assert.equal(timer.pending.size, 1);
});

test("clearing permits a new explicit opening after atlas reset, without retaining a timer", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler); feedback.activate();
  feedback.show(sahara, 1); feedback.clear();
  assert.equal(timer.pending.size, 0);
  assert.equal(feedback.getSnapshot(), null);
  assert.equal(feedback.show(sahara, 1), true);
});

test("a retired activation cannot deactivate its replacement and subscriptions dispose", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler);
  const oldStop = feedback.activate();
  let updates = 0; const unsubscribe = feedback.subscribe(() => { updates++; });
  feedback.activate(); oldStop();
  assert.equal(feedback.show(sahara, 1), true);
  assert.equal(updates, 1);
  unsubscribe(); feedback.clear();
  assert.equal(updates, 1);
});

test("a synchronous listener can dispose the announcement without leaving its timeout", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler);
  const stop = feedback.activate();
  feedback.subscribe(() => { if (feedback.getSnapshot()) stop(); });
  feedback.show(sahara, 1);
  assert.equal(feedback.getSnapshot(), null);
  assert.equal(timer.pending.size, 0);
});

test("the permanent polite status has one clear sentence, no dialog or focus target", () => {
  const timer = clock(), feedback = createEarthAtlasDiscoveryFeedback("owner", timer.scheduler); feedback.activate();
  const empty = renderToStaticMarkup(createElement(EarthAtlasDiscovery, { discovery: null }));
  assert.match(empty, /role="status" aria-live="polite" aria-atomic="true"/);
  feedback.show(eiffel, 2);
  const html = renderToStaticMarkup(createElement(EarthAtlasDiscovery, { discovery: feedback.getSnapshot() }));
  assert.match(html, /Открыто в атласе: Эйфелева башня\. 2 из 50\./);
  assert.match(html, /--atlas-progress-from:2%;--atlas-progress-to:4%/);
  assert.doesNotMatch(html, /<(?:button|input|a)[ >]|tabindex|role="dialog"/);
});

test("post-discovery progress includes discoveries merged from another tab before the write", () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const tab = createEarthAtlasStore("owner", () => storage), otherTab = createEarthAtlasStore("owner", () => storage);
  tab.activate(); otherTab.activate();
  tab.discover(sahara.id);
  const renderedSnapshot = tab.getSnapshot();
  otherTab.discover(eiffel.id);
  const meeting = earthAtlasEntry("meeting:friend"), feedback = createEarthAtlasDiscoveryFeedback("owner", clock().scheduler);
  feedback.activate();
  if (tab.discover(meeting.id)) feedback.show(meeting, tab.getSnapshot().ids.length);
  assert.equal(renderedSnapshot.ids.length, 1, "a render can still hold the old count");
  assert.equal(feedback.getSnapshot().openedCount, 3, "the live reader includes the merged opening and this click");
  const html = renderToStaticMarkup(createElement(EarthAtlasDiscovery, { discovery: feedback.getSnapshot() }));
  assert.match(html, /Встреча с близким\. 3 из 50\./);
  assert.match(html, /--atlas-progress-from:4%;--atlas-progress-to:6%/);
});

test("the hook exposes a synchronous reader without activating storage during SSR", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let storageReads = 0, atlas;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { storageReads++; throw new Error("SSR storage read"); } } });
  function AtlasReadFixture() { atlas = useEarthAtlas("owner"); return createElement("span", null, atlas.readSnapshot().ids.length); }
  try {
    assert.equal(renderToStaticMarkup(createElement(AtlasReadFixture)), "<span>0</span>");
    assert.equal(storageReads, 0);
    assert.equal(atlas.readSnapshot(), atlas.snapshot);
    assert.equal(atlas.readSnapshot().loaded, false);
    assert.equal(atlas.discover(sahara.id), false, "a server reader cannot activate an account");
    assert.deepEqual(atlas.readSnapshot().ids, []);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
});
