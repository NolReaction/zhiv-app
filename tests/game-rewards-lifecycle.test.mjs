import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, isValidElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:rewards-lifecycle-hooks", audioId = "virtual:rewards-lifecycle-audio";
// Run the actual hook, session and API; adapt only React scheduling and browser time.
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "rewards-lifecycle-hooks", enforce: "pre",
    resolveId(id) { if ([hooksId, audioId].includes(id)) return `\0${id}`; },
    load(id) {
      if (id === `\0${audioId}`) return "export const events = []; export const getAudioRuntime = () => ({ play(event) { events.push(event); } });";
      if (id === `\0${hooksId}`) return `
        let current, cursor = 0;
        function slot(create) { const index = cursor++; if (!(index in current.slots)) current.slots[index] = create(); return current.slots[index]; }
        export function create() { return { slots: [], effects: new Set(), pending: new Map(), layoutPending: new Map(), dirty: false }; }
        export function begin(root) { current = root; cursor = 0; root.dirty = false; }
        function run(pending) { const work = [...pending]; pending.clear(); for (const [effect, callback] of work) { effect.cleanup?.(); effect.callback = callback; effect.cleanup = callback(); } }
        export function flushLayout(root) { run(root.layoutPending); }
        export function flush(root) { flushLayout(root); run(root.pending); }
        export function replay(root) { for (const effect of root.effects) effect.cleanup?.(); for (const effect of root.effects) effect.cleanup = effect.callback?.(); }
        export function destroy(root) { for (const effect of root.effects) effect.cleanup?.(); root.effects.clear(); }
        export function useRef(value) { return slot(() => ({ current: value })); }
        export function useState(initial) { const root = current, state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value; if (!Object.is(next, state.value)) { state.value = next; root.dirty = true; } }]; }
        export function useMemo(create, dependencies) { const memo = slot(() => ({ dependencies: undefined, value: undefined })); if (!memo.dependencies || dependencies.some((value, index) => !Object.is(value, memo.dependencies[index]))) { memo.dependencies = dependencies; memo.value = create(); } return memo.value; }
        export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }
        export function useEffect(callback, dependencies) { const root = current, effect = slot(() => ({ dependencies: undefined, cleanup: undefined })); root.effects.add(effect); if (!effect.dependencies || dependencies.some((value, index) => !Object.is(value, effect.dependencies[index]))) { effect.dependencies = dependencies; root.pending.set(effect, callback); } }
        export function useLayoutEffect(callback, dependencies) { const root = current, effect = slot(() => ({ dependencies: undefined, cleanup: undefined })); root.effects.add(effect); if (!effect.dependencies || dependencies.some((value, index) => !Object.is(value, effect.dependencies[index]))) { effect.dependencies = dependencies; root.layoutPending.set(effect, callback); } }
        export function useSyncExternalStore(subscribe, getSnapshot) { const root = current; useEffect(() => subscribe(() => { root.dirty = true; }), [subscribe, getSnapshot]); return getSnapshot(); }
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/game/use-game-rewards.ts") || id.endsWith("/features/game/daily-rewards.tsx")) return source.replace('from "react";', `from "${hooksId}";`)
        .replace('from "@/features/audio/runtime/audio-service";', `from "${audioId}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const audio = await vite.ssrLoadModule(audioId);
const { useGameRewards: renderRewardsHook } = await vite.ssrLoadModule("/features/game/use-game-rewards.ts");
const { DailyRewardsDialog, DailyRewardsPanel } = await vite.ssrLoadModule("/features/game/daily-rewards.tsx");
const { createGameRewardsSession } = await vite.ssrLoadModule("/features/game/game-rewards-session.ts");
const { GAME_ACHIEVEMENT_TARGETS } = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const at = "2026-10-05T12:00:00.000Z", reward = { coins: 10, pearls: 0, items: {} };
function view(ownerPublicId, claimable = true) {
  return { ownerPublicId, serverTime: at, catalogVersion: 8,
    daily: { step: 1, completed: false, claimable, nextClaimAt: at, lastClaimAt: null, lastClaimDate: null, reward,
      cycle: Array.from({ length: 7 }, (_, index) => ({ step: index + 1, reward })) },
    achievementRewards: Object.entries(GAME_ACHIEVEMENT_TARGETS).flatMap(([achievementId, targets]) => targets.map((target, index) => ({
      achievementId, level: index + 1, target, pearls: achievementId === "full_collection" ? 0 : index + 1,
      earnedAt: null, claimedAt: null, eligible: false, blockedReason: achievementId === "full_collection" ? "no_reward" : "not_earned" }))) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function receipt(command) {
  return { requestId: command.requestId, rewards: view(command.ownerPublicId, false), acceptedRevision: 1, replayed: false,
    claim: command.kind === "achievement"
      ? { kind: "achievement", achievementId: command.achievementId, level: command.level, reward: { ...reward, pearls: 1 }, claimedAt: at }
      : { kind: "daily", step: 1, reward, claimedAt: at }, message: "Награда получена",
    economy: { ownerPublicId: command.ownerPublicId, revision: 1, serverTime: at, wallet: { coins: 10, pearls: 1 }, inventory: {},
      buildings: { home: 1 }, storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 }, jobs: [],
      migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 } };
}
let nextOwner = 0;
function browser(transport) {
  const names = ["window", "document", "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval"];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const owner = `TEST-${String(++nextOwner).padStart(4, "0")}-AAAA`, roots = new Set(), timers = new Map(), calls = [], writes = [];
  let time = 0, nextTimer = 0;
  class Surface extends EventTarget {
    listeners = new Map();
    addEventListener(type, callback, options) { super.addEventListener(type, callback, options); const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set); }
    removeEventListener(type, callback, options) { super.removeEventListener(type, callback, options); this.listeners.get(type)?.delete(callback); }
    count(type) { return this.listeners.get(type)?.size ?? 0; }
  }
  const window = new Surface(), document = new Surface(); document.hidden = false;
  const data = new Map(); window.sessionStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const schedule = (callback, delay = 0, repeat = 0) => { const id = ++nextTimer; timers.set(id, { callback, due: time + delay, repeat }); return id; };
  const globals = { window, document,
    fetch: async (path, options) => {
      const call = { path, options }; calls.push(call);
      if (options.method !== "GET") writes.push(call);
      return transport ? transport(call, owner) : Response.json(view(owner));
    },
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay), clearInterval: id => timers.delete(id) };
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true });
  function render(app, passive = true) {
    hooks.begin(app.hooks);
    if (app.dialog) {
      const tree = DailyRewardsDialog({ ownerPublicId: app.props.owner, isOnline: app.props.online, onSessionLost: app.props.lost,
        economy: { snapshot: null, refresh() {} }, open: false, onOpenChange: app.props.onOpenChange, onReturnFocus() {} });
      const visit = node => {
        if (!isValidElement(node)) return;
        if (node.type === DailyRewardsPanel) app.controller = node.props.controller;
        Children.forEach(node.props.children, visit);
      };
      visit(tree);
    } else app.controller = renderRewardsHook(app.props.owner, app.props.online, app.props.lost, app.props.confirmed);
    hooks.flushLayout(app.hooks); if (passive) hooks.flush(app.hooks); return app.controller;
  }
  function advance(ms) {
    const until = time + ms;
    for (let count = 0; count < 10_000; count++) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) { time = until; return; }
      const [id, timer] = next; time = timer.due;
      if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
      timer.callback();
    }
    assert.fail("reward browser scheduled an unbounded task loop");
  }
  async function settle() {
    // Response.json() and the request/schema promises need several microtasks.
    for (let round = 0; round < 25; round++) {
      advance(0); await Promise.resolve();
      for (const app of roots) if (app.hooks.dirty) render(app);
    }
    assert.ok([...roots].every(app => !app.hooks.dirty), "reward effects must settle");
  }
  function close(app) { if (roots.delete(app)) hooks.destroy(app.hooks); }
  return { owner, calls, writes, timers, window, document, data, render, advance, settle, close,
    mount(props = {}) { const app = { hooks: hooks.create(), props: { owner, online: true, ...props }, controller: undefined }; roots.add(app); render(app); return app; },
    mountDialog(onOpenChange) { const app = { dialog: true, hooks: hooks.create(), props: { owner, online: true, onOpenChange }, controller: undefined }; roots.add(app); render(app); return app; },
    replay(app) { hooks.replay(app.hooks); },
    restore() { for (const app of [...roots]) close(app); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } },
  };
}

test("snapshot notifications cannot reenter an unreserved reward GET", async () => {
  let reads = 0, notifications = 0;
  const session = createGameRewardsSession("OWNER", { get: async () => { reads++; return view("OWNER"); }, send: async () => { throw Error("no automatic claim"); } });
  const stop = session.activate();
  const unsubscribe = session.subscribe(() => { if (++notifications <= 10) void session.refresh(); });
  try {
    await session.refresh();
    assert.equal(reads, 1, "the in-flight read must be reserved before loading publishes to React");
    assert.ok(notifications < 10, "loading must not feed another GET");
  } finally { unsubscribe(); stop(); }
});

test("two reward controls share one poller; render, callback changes and profile remounts do not fetch", async () => {
  const app = browser();
  try {
    const dialog = app.mount(), profile = app.mount(); await app.settle();
    assert.equal(app.calls.length, 1);
    assert.equal(app.window.count("focus"), 1); assert.equal(app.document.count("visibilitychange"), 1);
    const stable = [dialog.controller.refresh, dialog.controller.claimDaily, dialog.controller.claimAchievement, dialog.controller.retry];
    for (let round = 0; round < 20; round++) {
      dialog.props.confirmed = () => {}; dialog.props.lost = () => {};
      app.render(dialog); app.render(profile);
    }
    await app.settle(); assert.equal(app.calls.length, 1);
    assert.deepEqual([dialog.controller.refresh, dialog.controller.claimDaily, dialog.controller.claimAchievement, dialog.controller.retry], stable);
    app.close(profile); app.mount(); await app.settle();
    assert.equal(app.calls.length, 1, "opening another panel shares the current account read");
    app.advance(45_000); await app.settle(); assert.equal(app.calls.length, 2, "one account has one 45-second poll");
    assert.equal(app.writes.length, 0);
  } finally { app.restore(); }
});

test("Strict Mode cancels the first kickoff and the last consumer removes all browser work", async () => {
  const app = browser();
  try {
    const dialog = app.mount(); app.replay(dialog); await app.settle();
    assert.equal(app.calls.length, 1); assert.equal(app.window.count("focus"), 1);
    app.close(dialog); app.advance(90_000); await app.settle();
    assert.equal(app.calls.length, 1); assert.equal(app.timers.size, 0);
    assert.equal(app.window.count("focus"), 0); assert.equal(app.document.count("visibilitychange"), 0);
    app.mount(); await app.settle(); assert.equal(app.calls.length, 2, "a true world reentry still gets a fresh prompt read");
  } finally { app.restore(); }
});

test("a world reward entry reads once and prompts after freshness while another control keeps the shared session alive", async () => {
  const app = browser(), opened = [];
  try {
    app.mount(); await app.settle(); assert.equal(app.calls.length, 1);
    const dialog = app.mountDialog(open => opened.push(open));
    assert.deepEqual(opened, [], "cached reward availability is not a new entry read");
    await app.settle(); assert.equal(app.calls.length, 2); assert.deepEqual(opened, [true]);
    for (let round = 0; round < 10; round++) app.render(dialog);
    await app.settle(); assert.equal(app.calls.length, 2); assert.deepEqual(opened, [true]);
    app.close(dialog); app.mountDialog(open => opened.push(open)); await app.settle();
    assert.equal(app.calls.length, 3); assert.deepEqual(opened, [true, true]);
    assert.equal(app.window.count("focus"), 1, "intentional world entry does not own a second poller");
  } finally { app.restore(); }
});

test("an immediate world entry response consumes the queued automatic kickoff", async () => {
  const app = browser(), opened = [];
  try {
    app.mountDialog(open => opened.push(open));
    // Resolve the explicit entry GET before the browser's kickoff task runs.
    for (let turn = 0; turn < 25; turn++) await Promise.resolve();
    await app.settle();
    assert.equal(app.calls.length, 1); assert.deepEqual(opened, [true]);
  } finally { app.restore(); }
});

test("focus, online and visibility bursts coalesce; hidden/offline controls do not poll", async () => {
  const app = browser();
  try {
    const dialog = app.mount(); await app.settle();
    app.window.dispatchEvent(new Event("focus")); app.window.dispatchEvent(new Event("online")); app.document.dispatchEvent(new Event("visibilitychange"));
    await app.settle(); assert.equal(app.calls.length, 2);
    app.document.hidden = true; app.advance(90_000); app.window.dispatchEvent(new Event("focus")); await app.settle();
    assert.equal(app.calls.length, 2);
    app.document.hidden = false; app.document.dispatchEvent(new Event("visibilitychange")); await app.settle();
    assert.equal(app.calls.length, 3);
    dialog.props.online = false; app.render(dialog); app.advance(90_000); await app.settle();
    assert.equal(app.calls.length, 3); assert.equal(app.timers.size, 0);
    dialog.props.online = true; app.render(dialog); await app.settle(); assert.equal(app.calls.length, 4);
  } finally { app.restore(); }
});

test("account switches abort stale reads, suppress old callbacks and isolate the new view", async () => {
  const wait = deferred(); let nextOwner, signal, lost = 0;
  const app = browser((call, initialOwner) => {
    if (!signal) { signal = call.options.signal; return wait.promise; }
    return Response.json(view(nextOwner ?? initialOwner));
  });
  try {
    const dialog = app.mount({ lost: () => lost++ }); await app.settle();
    nextOwner = "TEST-9999-BBBB"; dialog.props.owner = nextOwner; app.render(dialog); await app.settle();
    assert.equal(signal.aborted, true); assert.equal(dialog.controller.data.ownerPublicId, nextOwner);
    wait.resolve(Response.json(view(app.owner))); await app.settle();
    assert.equal(dialog.controller.data.ownerPublicId, nextOwner); assert.equal(lost, 0);
    assert.equal(app.calls.length, 2); assert.equal(app.writes.length, 0);
  } finally { app.restore(); }
});

test("confirmed actions use the latest callback and suppress replies to a hook that changed account", async () => {
  for (const kind of ["daily", "achievement"]) for (const switched of [false, true]) {
    audio.events.length = 0;
    const wait = deferred(); let command, currentOwner, previous = 0, latest = 0;
    const app = browser((call, initialOwner) => {
      if (call.options.method === "GET") {
        const data = view(currentOwner ?? initialOwner);
        const row = data.achievementRewards.find(row => row.achievementId === "explorer" && row.level === 1);
        Object.assign(row, { eligible: true, earnedAt: at, blockedReason: null });
        return Response.json(data);
      }
      command = JSON.parse(call.options.body); return wait.promise;
    });
    try {
      const dialog = app.mount({ confirmed: () => previous++ }); await app.settle();
      // Another panel keeps the old session valid, so the hook itself must fence its callback.
      app.mount(); await app.settle();
      const claim = kind === "daily" ? dialog.controller.claimDaily() : dialog.controller.claimAchievement("explorer", 1); await app.settle();
      dialog.props.confirmed = () => latest++;
      if (switched) { currentOwner = `SWAP-${String(++nextOwner).padStart(4, "0")}-AAAA`; dialog.props.owner = currentOwner; }
      // Commit the new owner/callback, but deliberately delay passive effects:
      // a receipt can settle in that browser turn before old hook cleanup.
      app.render(dialog, false);
      wait.resolve(Response.json(receipt(command))); const result = await claim;
      assert.equal(previous, 0); assert.equal(latest, switched ? 0 : 1);
      assert.equal(Boolean(result), !switched);
      assert.equal(audio.events.length, switched ? 0 : 1, `${kind}: an old session retained by another panel cannot sound for a new account`);
      await app.settle();
      assert.equal(dialog.controller.data.ownerPublicId, switched ? currentOwner : app.owner);
    } finally { app.restore(); }
  }
});

for (const kind of ["daily", "achievement"]) test(`keyed ${kind} unmount revokes confirmation before a shared session disconnects`, async () => {
  audio.events.length = 0;
  const wait = deferred(); let command, currentOwner, callbacks = 0;
  const app = browser((call, initialOwner) => {
    if (call.options.method === "GET") {
      const data = view(currentOwner ?? initialOwner);
      Object.assign(data.achievementRewards.find(row => row.achievementId === "explorer" && row.level === 1),
        { eligible: true, earnedAt: at, blockedReason: null });
      return Response.json(data);
    }
    command = JSON.parse(call.options.body); return wait.promise;
  });
  try {
    const keyed = app.mount({ confirmed: () => callbacks++ }), world = app.mount(); await app.settle();
    const claim = kind === "daily" ? keyed.controller.claimDaily() : keyed.controller.claimAchievement("explorer", 1);
    await app.settle();
    assert.equal(app.writes.length, 1);
    // Both profile achievement entries are keyed by owner. The world HUD updates
    // in place, retaining the old session until its passive disconnect runs.
    currentOwner = `SWAP-${String(++nextOwner).padStart(4, "0")}-AAAA`;
    world.props.owner = currentOwner; app.render(world, false);
    app.close(keyed);
    assert.equal(app.writes[0].options.signal.aborted, false, "the shared session must remain active to exercise the retired hook fence");
    wait.resolve(Response.json(receipt(command)));
    assert.equal(await claim, undefined, "a retired control cannot return a confirmation for the new account");
    assert.equal(audio.events.length, 0, "a retired old-owner control cannot sound for the new account");
    assert.equal(callbacks, 0, "a retired control cannot refresh old economy or achievement state");
  } finally { app.restore(); }
});

test("polling and remounting preserve an uncertain receipt without repeating a claim", async () => {
  let attempted = 0;
  const app = browser((call, owner) => {
    if (call.options.method === "GET") return Response.json(view(owner));
    attempted++; throw Error("response lost after commit");
  });
  try {
    let dialog = app.mount(); await app.settle();
    await dialog.controller.claimDaily(); await app.settle();
    const pending = dialog.controller.pending; assert.equal(dialog.controller.uncertain, true); assert.equal(attempted, 1);
    app.advance(90_000); await app.settle(); app.close(dialog);
    dialog = app.mount(); await app.settle();
    assert.deepEqual(dialog.controller.pending, pending); assert.equal(dialog.controller.uncertain, true);
    await dialog.controller.claimDaily(); await app.settle();
    assert.equal(attempted, 1); assert.equal(app.data.size, 1, "only a confirmed matching receipt may clear recovery");
  } finally { app.restore(); }
});

test("onboarding claims require supported server state and share the exact pending-receipt fence", async () => {
  const owner = "TEST-9000-CCCC", commands = [], stored = new Map();
  let claimedAt = null, supported = false;
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const snapshot = () => ({ ...view(owner), ...(supported ? { onboarding: { claimedAt } } : {}) });
  const transport = { get: async () => snapshot(), send: async command => {
    commands.push(structuredClone(command)); claimedAt = at;
    if (commands.length === 1) throw Error("lost after commit");
    return { requestId: command.requestId, rewards: snapshot(), economy: { ownerPublicId: owner },
      claim: { kind: "onboarding", reward, claimedAt }, replayed: true };
  } };
  let session = createGameRewardsSession(owner, transport, storage), stop = session.activate();
  try {
    await session.refresh(); await session.claimOnboarding(); assert.equal(commands.length, 0, "an older server does not advertise this claim");
    supported = true; await session.refresh(); await session.claimOnboarding();
    assert.equal(commands.length, 1); assert.equal(commands[0].kind, "onboarding");
    const pending = session.getSnapshot().pending; assert.equal(session.getSnapshot().uncertain, true);
    await session.refresh(); await session.claimDaily(); await session.claimOnboarding();
    assert.equal(commands.length, 1, "GET and another completion cannot replace the unknown receipt");
    stop(); session = createGameRewardsSession(owner, transport, storage); stop = session.activate(); await session.refresh();
    assert.deepEqual(session.getSnapshot().pending, pending);
    const result = await session.retry(); assert.equal(result.claim.kind, "onboarding");
    assert.deepEqual(commands[0], commands[1]); assert.equal(session.getSnapshot().pending, null); assert.equal(stored.size, 0);
    await session.claimOnboarding(); assert.equal(commands.length, 2, "a confirmed completion is never claimed again");
  } finally { stop(); }
});

test("an onboarding command cannot accept a daily receipt with the same request ID", async () => {
  const owner = "TEST-9001-DDDD", snapshot = { ...view(owner), onboarding: { claimedAt: null } };
  const session = createGameRewardsSession(owner, { get: async () => snapshot, send: async command => ({
    requestId: command.requestId, rewards: snapshot, economy: { ownerPublicId: owner },
    claim: { kind: "daily", reward, claimedAt: at }, replayed: false,
  }) });
  const stop = session.activate();
  try {
    await session.refresh(); assert.equal(await session.claimOnboarding(), undefined);
    assert.equal(session.getSnapshot().uncertain, true); assert.equal(session.getSnapshot().pending.kind, "onboarding");
    assert.equal(session.getSnapshot().result, null);
  } finally { stop(); }
});
