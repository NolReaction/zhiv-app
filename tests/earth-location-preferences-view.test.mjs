import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:earth-location-preferences-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "location-preference-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) {
      if (id === `\0${hooksId}`) return `
        let current, cursor = 0;
        const slot = create => { const i = cursor++; return current.slots[i] ??= create(); };
        export const create = () => ({ slots: [], effects: new Set(), pending: new Map(), dirty: false, hydrating: true });
        export function begin(root) { current = root; cursor = 0; root.dirty = false; }
        export function flush(root) { const work = [...root.pending]; root.pending.clear(); for (const [effect, callback] of work) { effect.cleanup?.(); effect.cleanup = callback(); } if (root.hydrating) { root.hydrating = false; root.dirty = true; } }
        export function destroy(root) { for (const effect of root.effects) effect.cleanup?.(); root.effects.clear(); }
        export function useMemo(create, deps) { const memo = slot(() => ({})); if (!memo.deps || deps.some((value, i) => !Object.is(value, memo.deps[i]))) { memo.deps = deps; memo.value = create(); } return memo.value; }
        export const useCallback = (callback, deps) => useMemo(() => callback, deps);
        export function useLayoutEffect(callback, deps) { const root = current, effect = slot(() => ({})); root.effects.add(effect); if (!effect.deps || deps.some((value, i) => !Object.is(value, effect.deps[i]))) { effect.deps = deps; root.pending.set(effect, callback); } }
        export function useSyncExternalStore(subscribe, snapshot, server) { const root = current; useLayoutEffect(() => subscribe(() => { root.dirty = true; }), [subscribe, snapshot]); return root.hydrating ? server() : snapshot(); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/earth/use-earth-location.ts") || id.endsWith("/features/earth/use-earth-sharing.ts")) return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { useEarthLocation: renderLocationHook } = await vite.ssrLoadModule("/features/earth/use-earth-location.ts");
const { useEarthSharing: renderSharingHook } = await vite.ssrLoadModule("/features/earth/use-earth-sharing.ts");
const { getEarthLocationPreferenceStore, earthLocationPreferenceKey } = await vite.ssrLoadModule("/features/earth/location-preferences.ts");

test("a persisted OFF fences hydration auto-start; shared controls stop GPS before React rerenders and ON stays idle", async () => {
  const descriptors = new Map(["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = new Map([[earthLocationPreferenceKey("preference-view-owner"), "off"]]);
  const window = new EventTarget(), document = new EventTarget(), permission = new EventTarget();
  window.isSecureContext = true;
  window.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  document.visibilityState = "visible"; permission.state = "granted";
  const watches = [], cleared = [], queries = [];
  const navigator = { permissions: { query: async value => { queries.push(value); return permission; } }, geolocation: {
    watchPosition(success, failure) { watches.push({ success, failure }); return watches.length - 1; }, clearWatch(id) { cleared.push(id); },
  } };
  for (const [name, value] of Object.entries({ window, document, navigator })) Object.defineProperty(globalThis, name, { value, configurable: true });
  const state = hooks.create(), props = { ownerPublicId: "preference-view-owner", enabled: true, autoStartWhenGranted: true };
  function render() {
    let value, passes = 0;
    do { hooks.begin(state); value = renderLocationHook(props); hooks.flush(state); assert.ok(++passes < 10, "hook settles"); } while (state.dirty);
    return value;
  }
  try {
    let location = render(); await Promise.resolve();
    assert.equal(location.allowed, false);
    assert.equal(watches.length, 0);
    assert.deepEqual(queries, [], "an initial hydrated OFF cannot even probe permission");
    location.start(); location.locate();
    assert.equal(watches.length, 0);
    const preference = getEarthLocationPreferenceStore(props.ownerPublicId);
    preference.setEnabled(true);
    location = render(); await Promise.resolve();
    assert.equal(location.allowed, true);
    assert.equal(watches.length, 0, "ON is not permission to restart a prior lookup");
    location.locate();
    assert.equal(watches.length, 1);
    watches[0].success({ coords: { latitude: 55, longitude: 37, accuracy: 40 }, timestamp: 1_000 });
    location = render();
    assert.equal(location.position.latitude, 55);
    preference.setEnabled(false);
    assert.deepEqual(cleared, [0], "the common preference retires watch synchronously before a rerender");
    watches[0].success({ coords: { latitude: 10, longitude: 20, accuracy: 1 }, timestamp: 2_000 });
    location.locate();
    location = render();
    assert.equal(location.position, null);
    assert.equal(location.allowed, false);
    assert.equal(watches.length, 1);
    assert.equal(values.get(earthLocationPreferenceKey(props.ownerPublicId)), "off");
  } finally {
    hooks.destroy(state);
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});

test("master OFF synchronously aborts publication, persists one full revoke and fences stale sharing actions", async () => {
  const names = ["window", "document", "fetch", "BroadcastChannel"];
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const window = new EventTarget(), document = new EventTarget(), values = new Map();
  window.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  document.hidden = false;
  const owner = "AAAA-BBBB-CCCC", circle = "11111111-1111-4111-8111-111111111111", epoch = "22222222-2222-4222-8222-222222222222";
  const iso = () => new Date().toISOString(), calls = [], positionCalls = [], pendingEnables = [];
  let deferEnable = false;
  let server = { ownerPublicId: owner, mode: "SHARING", revision: 1, precision: "PRECISE", recipientCircleIds: [circle], frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: iso() };
  const response = value => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    if (url.endsWith("/people")) return response({ ownerPublicId: owner, people: [], serverTime: iso() });
    if (url.endsWith("/location")) {
      if (init.method === "DELETE") return response({ ownerPublicId: owner, serverTime: iso() });
      positionCalls.push({ write: JSON.parse(init.body), signal: init.signal });
      return response({ ownerPublicId: owner, acceptedAt: iso(), expiresAt: new Date(Date.now() + 60_000).toISOString(), serverTime: iso() });
    }
    if (init.method !== "PUT") return response({ ...server, publicationEpoch: null, serverTime: iso() });
    const write = JSON.parse(init.body);
    calls.push({ write, signal: init.signal, key: init.headers["Idempotency-Key"] });
    const next = { ...server, mode: write.mode, revision: ++server.revision, precision: write.precision,
      recipientCircleIds: write.mode === "OFF" ? [] : write.recipientCircleIds, frozenCircleIds: write.frozenCircleIds ?? [],
      publicationEpoch: write.mode === "SHARING" ? epoch : null, serverTime: iso() };
    if (write.mode === "SHARING" && deferEnable) return new Promise(resolve => pendingEnables.push(() => resolve(response(next))));
    server = next;
    return response(next);
  };
  for (const [name, value] of Object.entries({ window, document, fetch, BroadcastChannel: undefined })) Object.defineProperty(globalThis, name, { value, configurable: true });
  const state = hooks.create(), props = { ownerPublicId: owner, visible: true, isOnline: true };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  function render() {
    let result, passes = 0;
    do { hooks.begin(state); result = renderSharingHook(props); hooks.flush(state); assert.ok(++passes < 10, "sharing settles"); } while (state.dirty);
    return result;
  }
  try {
    let sharing = render(); await flush(); sharing = render();
    const choices = { recipientCircleIds: [circle], precision: "PRECISE", durationMinutes: null };
    assert.equal(await sharing.share(choices), true);
    sharing = render();
    assert.equal(sharing.publishing, true);
    sharing.setPosition({ latitude: 55, longitude: 37, accuracy: 20, timestamp: Date.now() });
    assert.equal(positionCalls.length, 1);
    const preference = getEarthLocationPreferenceStore(owner);
    preference.setEnabled(false);
    assert.equal(positionCalls[0].signal.aborted, true, "OFF aborts the current upload before rerender");
    assert.equal(calls.filter(call => call.write.mode === "OFF").length, 1);
    assert.equal(await sharing.share(choices), false, "a stale share callback cannot re-enable server access");
    assert.equal(await sharing.setFrozen(circle, false), false);
    sharing.ghost();
    sharing.setPosition({ latitude: 10, longitude: 20, accuracy: 1, timestamp: Date.now() + 1 });
    assert.equal(positionCalls.length, 1);
    preference.setEnabled(false); render(); await flush(); sharing = render();
    assert.equal(calls.filter(call => call.write.mode === "OFF").length, 1, "rerenders and duplicate OFF clicks do not replace the durable intent");
    assert.equal(sharing.settings.mode, "OFF");
    preference.setEnabled(true); sharing = render(); await flush();
    assert.equal(sharing.publishing, false, "re-enabling the device never resumes sharing");
    deferEnable = true;
    const pending = sharing.share(choices);
    assert.equal(pendingEnables.length, 1);
    preference.setEnabled(false);
    assert.equal(calls.filter(call => call.write.mode === "SHARING").at(-1).signal.aborted, true);
    pendingEnables[0]();
    assert.equal(await pending, false, "late accepted enable response is retired after master OFF");
    await flush(); sharing = render();
    assert.equal(sharing.publishing, false);
    assert.equal(sharing.settings.mode, "OFF");
  } finally {
    hooks.destroy(state);
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
