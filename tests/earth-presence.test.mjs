import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:earth-presence-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-presence-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let current, cursor = 0;
      const slot = create => { const i = cursor++; return current.slots[i] ??= create(); };
      export const create = () => ({ slots: [], effects: new Set(), pending: new Map(), dirty: false, hydrating: true });
      export function begin(root) { current = root; cursor = 0; root.dirty = false; }
      export function flush(root) { const work = [...root.pending]; root.pending.clear(); for (const [effect, callback] of work) { effect.cleanup?.(); effect.cleanup = callback(); } if (root.hydrating) { root.hydrating = false; root.dirty = true; } }
      export function destroy(root) { for (const effect of root.effects) effect.cleanup?.(); root.effects.clear(); }
      export function useMemo(create, deps) { const memo = slot(() => ({})); if (!memo.deps || deps.some((value, i) => !Object.is(value, memo.deps[i]))) { memo.deps = deps; memo.value = create(); } return memo.value; }
      export const useCallback = (callback, deps) => useMemo(() => callback, deps);
      export const useRef = initial => useMemo(() => ({ current: initial }), []);
      export function useLayoutEffect(callback, deps) { const root = current, effect = slot(() => ({})); root.effects.add(effect); if (!effect.deps || deps.some((value, i) => !Object.is(value, effect.deps[i]))) { effect.deps = deps; root.pending.set(effect, callback); } }
      export const useEffect = useLayoutEffect;
      export function useSyncExternalStore(subscribe, snapshot, server) { const root = current; useLayoutEffect(() => subscribe(() => { root.dirty = true; }), [subscribe, snapshot]); return root.hydrating ? server() : snapshot(); }
    `; },
    transform(source, id) {
      if (/\/features\/earth\/use-earth-(presence|location|sharing)\.ts$/.test(id)) return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
const hooks = await vite.ssrLoadModule(hooksId);
const { useEarthPresence: renderPresenceHook } = await vite.ssrLoadModule("/features/earth/use-earth-presence.ts");
const { useEarthSharing: renderSharingHook } = await vite.ssrLoadModule("/features/earth/use-earth-sharing.ts");
const { createEarthSharingController } = await vite.ssrLoadModule("/features/earth/sharing.ts");
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const store = await vite.ssrLoadModule("/lib/dev/earth-sharing-store.ts");
const { earthLocationPreferenceKey } = await vite.ssrLoadModule("/features/earth/location-preferences.ts");
beforeEach(() => identity.resetDevStoreForTests());
after(async () => { identity.resetDevStoreForTests(); await vite.close(); });
const unwrap = result => {
  if (result.kind !== "ok") throw Object.assign(new Error(result.code), { status: result.status });
  return result.value;
};
const account = name => identity.createDevIdentity(name, crypto.randomUUID());
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function connect(a, b) {
  const request = unwrap(identity.sendDevDirectRequest(a.token, b.me.user.publicId, crypto.randomUUID()));
  return unwrap(identity.actOnDevDirectRequest(b.token, request.request.requestId, "ACCEPTED")).person.circleId;
}
function grant(a, circle) {
  return unwrap(store.putDevEarthSharing(a.token, { expectedOwnerPublicId: a.me.user.publicId,
    expectedRevision: unwrap(store.getDevEarthSharing(a.token)).revision, mode: "SHARING", precision: "PRECISE",
    recipientCircleIds: [circle], durationMinutes: null }));
}
function device() {
  const descriptors = new Map(["window", "document", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const originalNow = Date.now;
  let wallNow = originalNow();
  Date.now = () => wallNow;
  const values = new Map(), watches = [], cleared = [];
  const window = new EventTarget(), document = new EventTarget();
  window.isSecureContext = true; document.hidden = false; document.visibilityState = "visible";
  window.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const navigator = { geolocation: {
    watchPosition(success, failure, options) { watches.push({ success, failure, options }); return watches.length - 1; },
    clearWatch(id) { cleared.push(id); },
  } };
  for (const [name, value] of Object.entries({ window, document, navigator })) Object.defineProperty(globalThis, name, { value, configurable: true });
  return { values, watches, cleared, document,
    hide(value) { document.hidden = value; document.visibilityState = value ? "hidden" : "visible"; document.dispatchEvent(new Event("visibilitychange")); },
    fix(index, latitude = 55.75, timestamp = wallNow + 1) {
      // A synthetic new measurement advances capture time even when the whole
      // hide/resume scenario executes within one real clock millisecond.
      wallNow = Math.max(wallNow, timestamp);
      watches[index].success({ coords: { latitude, longitude: 37.62, accuracy: 12 }, timestamp });
      return timestamp;
    },
    restore() { Date.now = originalNow; for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } },
  };
}
function sharing(a, device) {
  const calls = { uploads: [], stops: [], resumes: [] }, timers = new Map(); let timer = 0;
  const controller = createEarthSharingController({ ownerPublicId: a.me.user.publicId,
    transport: {
      async getEarthSharing() { return unwrap(store.getDevEarthSharing(a.token)); },
      async getEarthPeople() { return unwrap(store.getDevEarthPeople(a.token)); },
      async updateEarthSharing(write) { return unwrap(store.putDevEarthSharing(a.token, write)); },
      async resumeEarthSharing(write) { calls.resumes.push(write); return unwrap(store.resumeDevEarthSharing(a.token, write)); },
      async publishEarthPosition(write) { calls.uploads.push(write); return unwrap(store.putDevEarthPosition(a.token, write)); },
      async stopEarthPublication(write) { calls.stops.push(write); return unwrap(store.stopDevEarthPosition(a.token, write)); },
    },
    getEnvironment: () => ({ now: Date.now, monotonicNow: () => performance.now(),
      schedule(callback) { const id = ++timer; timers.set(id, callback); return id; }, cancel: id => timers.delete(id),
      visible: () => !device.document.hidden, onVisibilityChange(callback) {
        device.document.addEventListener("visibilitychange", callback); return () => device.document.removeEventListener("visibilitychange", callback);
      }, loadPending: () => null, savePending() {}, clearPending() {}, onPendingChange: () => () => {}, createId: () => crypto.randomUUID() }),
  });
  const deactivate = controller.activate(); controller.setContext({ visible: true, publicationVisible: true, isOnline: true });
  return { controller, calls, stop: deactivate };
}
function mountPresence(a, session, values = {}) {
  const state = hooks.create(), props = { ownerPublicId: a.me.user.publicId, enabled: true, mapVisible: false, ...values };
  const unsubscribe = session.controller.subscribe(() => { state.dirty = true; });
  return { props, destroy() { unsubscribe(); hooks.destroy(state); }, render() {
    let result, passes = 0;
    do {
      hooks.begin(state); result = renderPresenceHook({ ...props, sharing: { ...session.controller, ...session.controller.getSnapshot() } }); hooks.flush(state);
      assert.ok(++passes < 20, "presence settles without repeated stop/start effects");
    } while (state.dirty);
    return result;
  } };
}

test("two consenting accounts exchange real DEV feed points without either opening the map", async () => {
  const d = device(), a = account("А"), b = account("Б"), circle = connect(a, b);
  grant(a, circle); grant(b, circle);
  const sa = sharing(a, d), sb = sharing(b, d), ma = mountPresence(a, sa), mb = mountPresence(b, sb);
  try {
    ma.render(); mb.render(); await tick(); ma.render(); const aWatch = d.watches.length - 1; mb.render(); const bWatch = d.watches.length - 1;
    assert.notEqual(aWatch, bWatch); assert.equal(d.watches[aWatch].options.maximumAge, 0); assert.equal(d.watches[bWatch].options.maximumAge, 0);
    d.fix(aWatch, 55); ma.render(); d.fix(bWatch, 56); mb.render(); await tick();
    sa.controller.refresh(); sb.controller.refresh(); await tick();
    assert.equal(sa.controller.getSnapshot().people[0].latitude, 56);
    assert.equal(sb.controller.getSnapshot().people[0].latitude, 55);
    assert.equal(sa.calls.uploads.length, 1); assert.equal(sb.calls.uploads.length, 1);
    const watches = d.watches.length;
    ma.props.mapVisible = true; ma.render(); ma.props.mapVisible = false; ma.render();
    assert.equal(d.watches.length, watches, "map → game navigation keeps one consenting foreground watch");
    assert.equal(sa.calls.stops.length, 0); assert.equal(sa.calls.resumes.length, 1);
    sa.controller.ghost(); ma.render(); await tick();
    const last = unwrap(store.getDevEarthPeople(b.token)).people[0];
    assert.equal(last.latitude, 55); assert.equal(sa.controller.getSnapshot().publishing, false);
    d.fix(aWatch, 1); ma.render(); await tick();
    assert.equal(sa.calls.uploads.length, 1, "late pre-ghost callbacks cannot publish");
    assert.equal(unwrap(store.getDevEarthPeople(b.token)).people[0].updatedAt, last.updatedAt);
    sa.controller.off(); ma.render(); await tick();
    assert.deepEqual(unwrap(store.getDevEarthPeople(b.token)).people, []);
  } finally { ma.destroy(); mb.destroy(); sa.stop(); sb.stop(); d.restore(); }
});

test("without friend consent GPS stays private and starts only on the visible map", async () => {
  const d = device(), a = account("Частный"), s = sharing(a, d), m = mountPresence(a, s);
  try {
    m.render(); await tick(); m.render(); assert.equal(d.watches.length, 0);
    m.props.mapVisible = true; m.render(); assert.equal(d.watches.length, 1);
    d.fix(0); m.render(); await tick(); assert.equal(s.calls.uploads.length, 0);
    m.props.mapVisible = false; m.render(); assert.ok(d.cleared.includes(0));
    assert.equal(m.render().status, "paused");
    assert.equal(s.calls.resumes.length, 0); assert.equal(s.controller.getSnapshot().settings.mode, "OFF");
    m.props.mapVisible = true; m.render(); assert.equal(d.watches.length, 2);
  } finally { m.destroy(); s.stop(); d.restore(); }
});

test("native GPS failure does not immediately cancel a new explicit resume before its fresh lookup", async () => {
  const d = device(), a = account("Восстановление"), b = account("Друг"), circle = connect(a, b); grant(a, circle);
  const s = sharing(a, d), m = mountPresence(a, s);
  try {
    m.render(); await tick(); m.render();
    d.watches.at(-1).failure({ code: 2 }); m.render(); d.watches.at(-1).failure({ code: 3 }); m.render(); await tick();
    assert.equal(m.render().status, "timeout"); assert.equal(s.controller.getSnapshot().publishing, false);
    const error = s.controller.getSnapshot().publicationError; assert.match(error, /Не удалось дождаться/);
    s.controller.refresh(); await tick(); assert.equal(s.controller.getSnapshot().publicationError, error, "successful metadata polling cannot hide a GPS failure");
    await s.controller.resume(); m.render();
    assert.equal(s.controller.getSnapshot().publishing, true, "old timeout belongs to the retired lookup");
    assert.equal(m.render().status, "requesting");
    d.fix(d.watches.length - 1); m.render(); await tick();
    assert.equal(s.controller.getSnapshot().publicationError, null);
    assert.equal(unwrap(store.getDevEarthPeople(b.token)).people.length, 1);
  } finally { m.destroy(); s.stop(); d.restore(); }
});

test("backgrounding stops publishing and native GPS while return reacquires one fresh lease", async () => {
  const d = device(), a = account("Фон"), b = account("Друг"), circle = connect(a, b); grant(a, circle);
  const s = sharing(a, d), m = mountPresence(a, s);
  try {
    m.render(); await tick(); m.render(); const first = d.watches.length - 1;
    const firstCapture = d.fix(first); m.render(); await tick();
    const published = s.controller.getSnapshot().lastPublishedAt;
    d.hide(true); m.render(); await tick();
    assert.ok(d.cleared.includes(first)); assert.equal(s.controller.getSnapshot().publishing, false);
    assert.equal(s.controller.getSnapshot().lastPublishedAt, published, "pause retains the actual sent time");
    d.fix(first, 1); m.render(); assert.equal(s.calls.uploads.length, 1);
    d.hide(false); m.render(); await tick(); m.render();
    assert.equal(s.calls.resumes.length, 2); assert.equal(d.watches.at(-1).options.maximumAge, 0);
    const resumed = d.watches.length - 1;
    d.fix(resumed, 57, firstCapture); m.render(); await tick();
    assert.equal(s.calls.uploads.length, 1, "the fresh lease cannot republish a duplicate captured timestamp");
    assert.equal(m.render().status, "requesting");
    assert.equal(m.render().position.timestamp, firstCapture, "waiting for a new capture cannot refresh the old point's time");
    d.fix(resumed, 57); m.render(); await tick();
    assert.equal(s.calls.uploads.length, 2);
    assert.equal(unwrap(store.getDevEarthPeople(b.token)).people[0].latitude, 57);
  } finally { m.destroy(); s.stop(); d.restore(); }
});

test("device OFF and an owner change cannot revive a previous account's GPS callback", async () => {
  const d = device(), a = account("Выключено"), s = sharing(a, d), m = mountPresence(a, s, { mapVisible: true });
  d.values.set(earthLocationPreferenceKey(a.me.user.publicId), "off");
  try {
    m.render(); await tick(); m.render(); assert.equal(d.watches.length, 0); assert.equal(m.render().allowed, false);
    m.props.ownerPublicId = null; m.render(); assert.equal(d.watches.length, 0); assert.equal(m.render().position, null);
  } finally { m.destroy(); s.stop(); d.restore(); }
});

test("the real sharing hook persists native denial before a stale automatic lease effect and only explicit resume can recover", async () => {
  const d = device(), a = account("Отказ GPS"), b = account("Друг"), circle = connect(a, b); grant(a, circle);
  const originalFetch = globalThis.fetch;
  const state = hooks.create(); let result;
  globalThis.fetch = async (url, init = {}) => {
    const write = init.body ? JSON.parse(init.body) : null;
    const value = url.endsWith("/people") ? store.getDevEarthPeople(a.token)
      : url.endsWith("/sharing/resume") ? store.resumeDevEarthSharing(a.token, write)
        : url.endsWith("/location") ? init.method === "DELETE" ? store.stopDevEarthPosition(a.token, write) : store.putDevEarthPosition(a.token, write)
          : init.method === "PUT" ? store.putDevEarthSharing(a.token, write) : store.getDevEarthSharing(a.token);
    return new Response(JSON.stringify(value.kind === "ok" ? value.value : { code: value.code, message: value.code }),
      { status: value.kind === "ok" ? 200 : value.status, headers: { "content-type": "application/json" } });
  };
  function render() {
    let passes = 0;
    do {
      hooks.begin(state);
      const sharing = renderSharingHook({ ownerPublicId: a.me.user.publicId, visible: true, publicationVisible: true, isOnline: true });
      const location = renderPresenceHook({ ownerPublicId: a.me.user.publicId, enabled: true, mapVisible: false, sharing });
      result = { sharing, location }; hooks.flush(state);
      assert.ok(++passes < 30, "combined hooks settle");
    } while (state.dirty);
    return result;
  }
  try {
    render(); await tick(); render(); await tick(); render();
    assert.equal(result.sharing.publishing, true); assert.ok(d.watches.length > 0);
    const staleAutomaticLookup = result.location.locateForPublication, count = d.watches.length;
    d.watches.at(-1).failure({ code: 1 });
    assert.equal(d.values.get(earthLocationPreferenceKey(a.me.user.publicId)), "ready");
    staleAutomaticLookup();
    assert.equal(d.watches.length, count, "an effect queued before denial cannot grant READY again");
    render(); await tick(); render();
    assert.equal(result.sharing.publishing, false); assert.equal(result.location.status, "denied");
    result.sharing.refresh(); await tick(); render();
    assert.equal(d.watches.length, count, "metadata refresh does not reprompt");
    await result.sharing.resume(); render(); await tick(); render();
    assert.equal(result.sharing.publishing, true);
    assert.equal(d.watches.length, count + 1, "deliberate resume asks native GPS exactly once");
    d.fix(count); render(); await tick(); render();
    assert.equal(unwrap(store.getDevEarthPeople(b.token)).people.length, 1);
  } finally { hooks.destroy(state); await tick(); globalThis.fetch = originalFetch; d.restore(); }
});
