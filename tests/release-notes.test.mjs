import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { BUNDLED_RELEASE_NOTES, parseReleaseFeed, parseReadReleaseIds, releaseReadStorageKey, unreadReleaseIds } = await vite.ssrLoadModule("/features/updates/release-notes.ts");
const { createReleaseNotesStore, RELEASE_REFRESH_INTERVAL, RELEASE_REQUEST_TIMEOUT } = await vite.ssrLoadModule("/features/updates/release-notes-store.ts");

const original = { id: "test-release", version: "1.0.0", date: "2026-09-23", title: "Тестовая запись", changes: ["Описание изменения."] };
const later = { ...original, id: "next-release", date: "2026-09-24", title: "Следующая запись" };
const feed = (...releases) => ({ schemaVersion: 1, releases });
const response = payload => ({ ok: true, headers: new Headers({ "Content-Type": "application/json; charset=utf-8" }), json: async () => payload });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

// Isolate browser globals from Vite/Node while executing the actual production adapter.
const storeSource = await readFile(new URL("../features/updates/release-notes-store.ts", import.meta.url), "utf8");
const storeTree = ts.createSourceFile("release-notes-store.ts", storeSource, ts.ScriptTarget.Latest, true);
const environmentFactory = storeTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "browserReleaseNotesEnvironment");
assert.ok(environmentFactory);
const environmentCode = ts.transpileModule(environmentFactory.getText(storeTree), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function browserAdapterFixture({ server = false } = {}) {
  const timers = new Map();
  const events = new Map();
  const requests = [];
  const calls = [];
  let nextTimer = 0;
  let browserGlobal;
  const hostTimers = {};
  for (const name of ["setInterval", "clearInterval", "setTimeout", "clearTimeout"]) {
    hostTimers[name] = function (...args) {
      if (this !== browserGlobal) throw new TypeError(`Illegal invocation: ${name}`);
      calls.push(name);
      if (name.startsWith("clear")) { timers.delete(args[0]); return; }
      const id = ++nextTimer;
      timers.set(id, { name, callback: args[0], delay: args[1] });
      return id;
    };
  }
  const context = vm.createContext({ exports: {}, ...hostTimers });
  browserGlobal = vm.runInContext("globalThis", context);
  if (!server) {
    const target = prefix => ({
      addEventListener: (name, listener) => events.set(`${prefix}:${name}`, listener),
      removeEventListener: name => events.delete(`${prefix}:${name}`),
    });
    Object.assign(context, {
      ...target("window"),
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { visibilityState: "visible", ...target("document") },
      fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
    });
    vm.runInContext("globalThis.window = globalThis", context);
  }
  vm.runInContext(environmentCode, context);
  return { environment: context.exports.browserReleaseNotesEnvironment(), timers, events, requests, calls, hostTimers };
}

test("production browser adapter preserves timer receivers through scheduling and cleanup", async () => {
  const h = browserAdapterFixture();
  // Control: the former copied-native implementation must fail in this browser model.
  const detached = { ...h.environment, ...h.hostTimers };
  assert.throws(() => detached.setInterval(() => {}, 1), /Illegal invocation/);
  const store = createReleaseNotesStore("browser-adapter", h.environment, new Map());
  const stop = store.subscribe(() => {});
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [RELEASE_REFRESH_INTERVAL, RELEASE_REQUEST_TIMEOUT]);
  assert.equal(h.events.size, 4);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(response(feed(original)));
  await flush();
  assert.equal(store.getSnapshot().checking, false);
  assert.equal(h.timers.size, 1, "successful refresh clears its timeout through the host receiver");
  store.refresh();
  assert.equal(h.timers.size, 2);
  stop();
  assert.equal(h.requests[1].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.size, 0);
  assert.ok(["setInterval", "clearInterval", "setTimeout", "clearTimeout"].every(name => h.calls.includes(name)));
});

test("production browser adapter can be created for SSR without window or document", () => {
  const h = browserAdapterFixture({ server: true });
  const store = createReleaseNotesStore("server-adapter", h.environment, new Map());
  assert.equal(store.getServerSnapshot().unreadCount, BUNDLED_RELEASE_NOTES.length);
  assert.deepEqual(h.calls, [], "constructing the adapter must not start browser work");
});

function harness({ owner = "player-a", memory = new Map(), saved = new Map(), brokenStorage = false } = {}) {
  let clock = 0;
  let visible = true;
  let nextTimer = 0;
  let listener;
  const requests = [];
  const timers = new Map();
  const env = {
    now: () => clock,
    visible: () => visible,
    storage: () => {
      if (brokenStorage) throw new Error("Storage is blocked");
      return { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
    },
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
    listen: next => { listener = next; return () => { listener = undefined; }; },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: false }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
  };
  const store = createReleaseNotesStore(owner, env, memory);
  return { store, requests, saved, memory, timers,
    setTime: value => { clock = value; },
    setVisible: value => { visible = value; },
    event: event => listener?.(event),
    get listening() { return !!listener; },
    fireTimer(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue;
        if (!timer.interval) timers.delete(id);
        timer.callback();
      }
    },
  };
}

test("published feed remains valid as entries grow; fixtures sort by publication date with stable same-day order", async () => {
  const published = JSON.parse(await readFile(new URL("../public/updates.json", import.meta.url), "utf8"));
  const parsed = parseReleaseFeed(published);
  assert.ok(parsed, "published updates must pass the same validation as fetched updates");
  assert.deepEqual(BUNDLED_RELEASE_NOTES, parsed);
  assert.deepEqual(parseReleaseFeed(feed(original, later)).map(item => item.id), [later.id, original.id]);
  const sameDay = { ...later, id: "same-day" };
  assert.deepEqual(parseReleaseFeed(feed(sameDay, later)).map(item => item.id), [sameDay.id, later.id]);
});

test("malformed, duplicate, unsupported and HTML release feeds cannot replace current data", () => {
  for (const invalid of [null, "<html>error</html>", [], { schemaVersion: 2, releases: [original] }, feed(), feed(original, original),
    feed({ ...original, date: "2026-02-30" }), feed({ ...original, changes: ["<script>bad</script>"] }),
    feed({ ...original, id: "../../path" }), feed({ ...original, title: " " }), feed({ ...original, changes: [] })]) {
    assert.equal(parseReleaseFeed(invalid), null);
  }
});

test("read state accepts only stable ids and counts each unseen release, including multiple entries with the same version", () => {
  assert.deepEqual([...parseReadReleaseIds("garbage")], []);
  assert.deepEqual([...parseReadReleaseIds(JSON.stringify({ schemaVersion: 1, ids: [original.id, original.id, 42, "../../bad"] }))], [original.id]);
  assert.deepEqual(unreadReleaseIds([later, original], new Set([original.id])), [later.id]);
  assert.notEqual(releaseReadStorageKey("player-a"), releaseReadStorageKey("player-b"));
});

test("server hydration snapshot is stable; account read state loads only on subscription", () => {
  const saved = new Map([[releaseReadStorageKey("player-a"), JSON.stringify({ schemaVersion: 1, ids: BUNDLED_RELEASE_NOTES.map(release => release.id) })]]);
  const h = harness({ saved });
  const initial = h.store.getServerSnapshot();
  assert.equal(initial.unreadCount, BUNDLED_RELEASE_NOTES.length);
  assert.equal(h.requests.length, 0);
  const stop = h.store.subscribe(() => {});
  assert.equal(h.store.getSnapshot().unreadCount, 0);
  assert.strictEqual(h.store.getServerSnapshot(), initial);
  assert.equal(h.requests.length, 1);
  stop();
});

test("new deployed notes arrive without reloading and only individually opened entries become read", async () => {
  const h = harness();
  const stop = h.store.subscribe(() => {});
  assert.equal(h.requests[0].url, "/updates.json");
  assert.equal(h.requests[0].init.cache, "no-store");
  assert.equal(h.requests[0].init.credentials, "omit");
  h.requests[0].resolve(response(feed(original)));
  await flush();
  h.store.markRead(original.id);
  h.store.markRead("unknown-entry");
  h.setTime(RELEASE_REFRESH_INTERVAL);
  h.fireTimer(RELEASE_REFRESH_INTERVAL);
  h.requests[1].resolve(response(feed(later, original)));
  await flush();
  assert.deepEqual(h.store.getSnapshot().unreadIds, [later.id]);
  assert.equal(h.store.getSnapshot().checking, false);
  h.store.markRead(later.id);
  assert.equal(h.store.getSnapshot().unreadCount, 0);
  assert.deepEqual([...parseReadReleaseIds(h.saved.get(releaseReadStorageKey("player-a")))].sort(), [later.id, original.id].sort());
  stop();
});

test("storage failures preserve acknowledgement across remounts without leaking between accounts", async () => {
  const memory = new Map();
  const first = harness({ brokenStorage: true, memory });
  const stopFirst = first.store.subscribe(() => {});
  first.requests[0].resolve(response(feed(original)));
  await flush();
  first.store.markRead(original.id);
  assert.equal(first.store.getSnapshot().unreadCount, 0);
  stopFirst();
  const remount = harness({ brokenStorage: true, memory });
  const stopRemount = remount.store.subscribe(() => {});
  remount.requests[0].resolve(response(feed(original)));
  await flush();
  assert.equal(remount.store.getSnapshot().unreadCount, 0);
  const another = harness({ brokenStorage: true, owner: "player-b", memory });
  const stopAnother = another.store.subscribe(() => {});
  another.requests[0].resolve(response(feed(original)));
  await flush();
  assert.equal(another.store.getSnapshot().unreadCount, 1);
  stopRemount(); stopAnother();
});

test("concurrent tab acknowledgements merge monotonically and repair a stale storage overwrite", async () => {
  const h = harness();
  const stop = h.store.subscribe(() => {});
  h.requests[0].resolve(response(feed(later, original)));
  await flush();
  h.store.markRead(original.id);
  const key = releaseReadStorageKey("player-a");
  const remote = JSON.stringify({ schemaVersion: 1, ids: [later.id] });
  h.saved.set(key, remote);
  h.event({ type: "storage", key, newValue: remote });
  assert.equal(h.store.getSnapshot().unreadCount, 0);
  assert.equal(parseReadReleaseIds(h.saved.get(key)).size, 2);
  h.event({ type: "storage", key: releaseReadStorageKey("player-b"), newValue: null });
  assert.equal(h.store.getSnapshot().unreadCount, 0);
  // A queued earlier write must not regress the union or create a storage echo loop.
  const merged = h.saved.get(key);
  h.event({ type: "storage", key, newValue: JSON.stringify({ schemaVersion: 1, ids: [original.id] }) });
  assert.equal(h.saved.get(key), merged);
  const remount = harness({ saved: h.saved, memory: new Map() });
  const stopRemount = remount.store.subscribe(() => {});
  remount.requests[0].resolve(response(feed(later, original)));
  await flush();
  assert.equal(remount.store.getSnapshot().unreadCount, 0, "union survives closing every tab and losing its memory");
  stopRemount();
  stop();
});

test("offline, invalid JSON and HTML responses retain the newest valid feed and its read state", async () => {
  const h = harness();
  const stop = h.store.subscribe(() => {});
  h.requests[0].resolve(response(feed(later, original)));
  await flush();
  h.store.markRead(later.id);
  for (const invalid of ["network", { ...response(feed(original)), headers: new Headers({ "Content-Type": "text/html" }) }, response({}),
    { ...response(null), json: async () => { throw new Error("Invalid JSON"); } }]) {
    h.store.refresh();
    const request = h.requests.at(-1);
    if (invalid === "network") request.reject(new Error("Offline"));
    else request.resolve(invalid);
    await flush();
    assert.deepEqual(h.store.getSnapshot().releases.map(item => item.id), [later.id, original.id]);
    assert.deepEqual(h.store.getSnapshot().unreadIds, [original.id]);
    assert.equal(h.store.getSnapshot().refreshError, true);
    assert.equal(h.store.getSnapshot().checking, false);
  }
  stop();
});

test("foreground events are throttled, hidden polling pauses, and a manual refresh bypasses the throttle", async () => {
  const h = harness();
  const stop = h.store.subscribe(() => {});
  h.requests[0].resolve(response(feed(original)));
  await flush();
  h.event({ type: "refresh" }); h.event({ type: "refresh" });
  assert.equal(h.requests.length, 1);
  h.setTime(RELEASE_REFRESH_INTERVAL);
  h.setVisible(false);
  h.fireTimer(RELEASE_REFRESH_INTERVAL);
  h.event({ type: "refresh" });
  assert.equal(h.requests.length, 1);
  h.setVisible(true);
  h.event({ type: "refresh" }); h.event({ type: "refresh" });
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(response(feed(original)));
  await flush();
  h.store.refresh();
  assert.equal(h.requests.length, 3);
  stop();
});

test("timeout, forced replacement and disposal abort requests and ignore late responses", async () => {
  const h = harness();
  const stop = h.store.subscribe(() => {});
  h.fireTimer(RELEASE_REQUEST_TIMEOUT);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.store.getSnapshot().checking, false);
  assert.equal(h.store.getSnapshot().refreshError, true);
  h.store.refresh();
  h.store.refresh();
  assert.equal(h.requests[1].init.signal.aborted, true);
  h.requests[2].resolve(response(feed(later, original)));
  await flush();
  h.requests[0].resolve(response(feed(original)));
  h.requests[1].resolve(response(feed(original)));
  await flush();
  assert.equal(h.store.getSnapshot().releases[0].id, later.id);
  h.store.refresh();
  stop();
  assert.equal(h.requests[3].init.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listening, false);
  h.requests[3].resolve(response(feed(original)));
  await flush();
  assert.equal(h.store.getSnapshot().releases[0].id, later.id);
  h.store.refresh();
  assert.equal(h.requests.length, 4);
});
