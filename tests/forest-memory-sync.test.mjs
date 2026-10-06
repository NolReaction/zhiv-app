import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createForestMemorySync } = await vite.ssrLoadModule("/features/world/forest-memory-sync.ts");
const { forestMemoryPayloadSchema } = await vite.ssrLoadModule("/features/world/forest-memory-model.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { captureForestMemory, forestMemoryKey } = await vite.ssrLoadModule("/features/world/forest-memory.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const OWNER = "1234-ABCD-EFGH";
let serial = 0;
const uuid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, "0")}`;
const clone = value => structuredClone(value);
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function clock() {
  let now = 1000, serial = 0;
  const timers = new Map();
  return { now: () => now, randomUUID: uuid,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    async advance(ms = 0) {
      const end = now + ms;
      for (let loops = 0; ; loops++) {
        if (loops > 1000) throw Error("timer spin");
        await settle();
        const next = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = end; await settle();
    },
  };
}
function payload(energy = .7, map = TILED_WORLD) {
  const session = connectForestSession(undefined, map, "circle", 0, 0, () => {}, { persistence: false });
  session.state.clearing.behavior.mind.needs.energy = energy;
  const value = captureForestMemory(session.state, map); session.release(); return value;
}
function server(env, initial = null) {
  const receipts = new Map(), calls = [], reads = [];
  let revision = 0, snapshot = clone(initial), holder = null, token = null, expires = 0, updatedAt = null;
  const error = code => new ApiError(code, 409, { code, message: code });
  const view = clientId => ({ ownerPublicId: OWNER, revision, snapshot: clone(snapshot), serverTime: new Date(env.now()).toISOString(), updatedAt,
    lease: { owned: holder === clientId && expires > env.now(), expiresAt: expires > env.now() ? new Date(expires).toISOString() : null,
      token: holder === clientId && expires > env.now() ? token : null } });
  const transport = {
    async read(owner, clientId) { reads.push({ owner, clientId }); if (owner !== OWNER) throw error("FOREST_MEMORY_ACCOUNT_CHANGED"); return view(clientId); },
    async command(command) {
      calls.push(clone(command));
      const replay = receipts.get(command.requestId);
      if (replay) { assert.deepEqual(command, replay.command); return { state: view(command.clientId), acceptedRevision: replay.revision, replayed: true }; }
      if (command.ownerPublicId !== OWNER) throw error("FOREST_MEMORY_ACCOUNT_CHANGED");
      if (command.expectedRevision !== revision) throw error("FOREST_MEMORY_REVISION_CONFLICT");
      if (command.action === "acquire") {
        if (holder !== command.clientId && expires > env.now() && !command.takeover) throw error("FOREST_MEMORY_ACTIVE_ELSEWHERE");
        holder = command.clientId; token = uuid(); expires = env.now() + 90_000;
      } else {
        if (holder !== command.clientId || expires <= env.now() || token !== command.leaseToken) throw error("FOREST_MEMORY_LEASE_LOST");
        if (command.action === "save") { snapshot = clone(forestMemoryPayloadSchema.parse(command.snapshot)); updatedAt = new Date(env.now()).toISOString(); expires = env.now() + 90_000; }
        else { holder = null; token = null; expires = 0; }
      }
      revision++;
      receipts.set(command.requestId, { command: clone(command), revision });
      return { state: view(command.clientId), acceptedRevision: revision, replayed: false };
    },
  };
  return { transport, calls, reads, get snapshot() { return snapshot; }, get holder() { return holder; }, get revision() { return revision; } };
}
function client(env, remote, energy = .3, overrides = {}) {
  let value = payload(energy), captures = 0;
  const applied = [];
  const sync = createForestMemorySync({ ownerPublicId: OWNER, environment: env, transport: remote.transport,
    capture: () => { captures++; return clone(value); }, apply: snapshot => { value = clone(snapshot); applied.push(clone(snapshot)); }, ...overrides });
  return { sync, applied, get captures() { return captures; }, get value() { return value; } };
}

test("server memory wins over local cache; second device stays passive until explicit takeover", async () => {
  const env = clock(), remote = server(env, payload(.8)), a = client(env, remote, .1), b = client(env, remote, .2);
  a.sync.setActive(true); assert.equal(a.sync.isSimulationAllowed(), false); await env.advance();
  assert.equal(a.value.mind.needs.energy, .8); assert.equal(a.sync.isSimulationAllowed(), true);
  b.sync.setActive(true); await env.advance();
  assert.equal(b.sync.getStatus().mode, "other-device"); assert.equal(b.captures, 0); assert.equal(b.sync.isSimulationAllowed(), false);
  b.sync.takeOver(); await env.advance();
  assert.equal(b.sync.isSimulationAllowed(), true); b.value.mind.needs.energy = .6;
  b.sync.flush(); await env.advance();
  a.value.mind.needs.energy = .01; a.sync.flush(); await env.advance(250);
  assert.equal(remote.snapshot.mind.needs.energy, .6); assert.equal(a.value.mind.needs.energy, .6);
  assert.equal(a.sync.getStatus().mode, "other-device");
  a.sync.release(); b.sync.release(); await settle();
});

test("a lost acknowledgement retries the identical command and discards offline divergence", async () => {
  const env = clock(), remote = server(env), original = remote.transport.command;
  let drop = true;
  remote.transport.command = async command => {
    const result = await original(command);
    if (command.action === "save" && drop) { drop = false; throw Error("response lost"); }
    return result;
  };
  const a = client(env, remote, .71); a.sync.setActive(true); await env.advance();
  a.sync.flush(); await env.advance();
  assert.equal(a.sync.getStatus().mode, "offline"); assert.equal(a.sync.isSimulationAllowed(), false);
  a.value.mind.needs.energy = .02; await env.advance(1000);
  const saves = remote.calls.filter(command => command.action === "save");
  assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]);
  assert.equal(remote.snapshot.mind.needs.energy, .71); assert.equal(a.value.mind.needs.energy, .71);
  assert.equal(a.sync.getStatus().mode, "synced"); a.sync.release(); await settle();
});

test("retrying an old successful receipt cannot regain ownership after takeover", async () => {
  const env = clock(), remote = server(env), original = remote.transport.command;
  let lostId;
  remote.transport.command = async command => {
    const result = await original(command);
    if (command.action === "save" && !lostId) { lostId = command.clientId; throw Error("lost"); }
    return result;
  };
  const a = client(env, remote, .71), b = client(env, remote, .2);
  a.sync.setActive(true); await env.advance(); a.sync.flush(); await env.advance();
  b.sync.setActive(true); await env.advance(); b.sync.takeOver(); await env.advance();
  b.value.mind.needs.energy = .43; b.sync.flush(); await env.advance(); await env.advance(1000);
  assert.equal(a.value.mind.needs.energy, .43); assert.equal(a.sync.getStatus().mode, "other-device");
  assert.equal(a.sync.isSimulationAllowed(), false); assert.equal(remote.snapshot.mind.needs.energy, .43);
  a.sync.release(); b.sync.release(); await settle();
});

test("account mismatch and late response after disposal cannot mutate the next account", async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .3, { transport: {
    ...remote.transport, read: async () => ({ ownerPublicId: "9999-ABCD-EFGH", revision: 5, snapshot: payload(.9),
      serverTime: new Date(env.now()).toISOString(), updatedAt: null, lease: { owned: false, expiresAt: null, token: null } }),
  } });
  a.sync.setActive(true); await env.advance(); assert.equal(a.sync.getStatus().mode, "error");
  assert.equal(a.applied.length, 0); assert.equal(remote.calls.length, 0); a.sync.release();
  let resolve;
  const b = client(env, remote, .4, { transport: { ...remote.transport, read: () => new Promise(done => { resolve = done; }) } });
  b.sync.setActive(true); await env.advance(); b.sync.release();
  resolve({ ownerPublicId: OWNER, revision: 7, snapshot: payload(.8), serverTime: new Date(env.now()).toISOString(),
    updatedAt: null, lease: { owned: false, expiresAt: null, token: null } });
  await settle(); assert.equal(b.applied.length, 0); assert.equal(remote.calls.length, 0);
});

test("background saves and releases; resume reloads server state before simulation", async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .45), b = client(env, remote, .2);
  a.sync.setActive(true); await env.advance(); a.value.mind.needs.energy = .5;
  a.sync.setActive(false); await env.advance();
  assert.equal(remote.snapshot.mind.needs.energy, .5); assert.equal(remote.holder, null);
  b.sync.setActive(true); await env.advance(); b.value.mind.needs.energy = .9; b.sync.flush(); await env.advance();
  a.value.mind.needs.energy = .01; a.sync.setActive(true); assert.equal(a.sync.isSimulationAllowed(), false); await env.advance();
  assert.equal(a.value.mind.needs.energy, .9); assert.equal(a.sync.getStatus().mode, "other-device");
  a.sync.release(); b.sync.release(); await settle();
});

test("pause during initial read never acquires an invisible writer", async () => {
  const env = clock(), remote = server(env); let resolve;
  const a = client(env, remote, .3, { transport: { ...remote.transport, read: async (...args) => {
    const result = await remote.transport.read(...args); await new Promise(done => { resolve = done; }); return result;
  } } });
  a.sync.setActive(true); await env.advance(); a.sync.setActive(false); resolve(); await settle(); await env.advance();
  assert.equal(remote.calls.length, 0); a.sync.release(); await settle();
});

test("DEV suspension snapshots synchronously and never writes later forced state", async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .57);
  a.sync.setActive(true); await env.advance(); a.sync.suspend(); a.value.mind.needs.energy = 0;
  await settle(); await env.advance(120_000); a.sync.flush(); a.sync.setActive(true);
  assert.equal(remote.snapshot.mind.needs.energy, .57); assert.equal(remote.holder, null);
  assert.equal(a.sync.getStatus().mode, "disabled"); assert.equal(a.sync.isSimulationAllowed(), true);
  a.sync.release(); await settle();
});

test("server hydration resets a live route and reconciles changed geometry while sharing one circle/world writer", async () => {
  const env = clock(), original = structuredClone(TILED_WORLD), remembered = payload(.39, original);
  remembered.hero.position = { x: 665, y: 701 }; remembered.mushrooms[0].growth = .1;
  remembered.garden.bushes[0].growth = .58; remembered.garden.bushes[0].moisture = .76;
  remembered.garden.basketBerries = 6;
  remembered.mind.recent = [{ key: "old-place", action: "look", at: 0, duration: 1, outcome: "completed" }];
  const map = structuredClone(original); map.actor.spawn.x += 2; map.mushrooms[0].position.x += 5;
  const records = new Map(), storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
  const local = { storage, now: env.now }, remote = server(env, remembered), key = `zhiv:mochlik:presence:${OWNER}`;
  const options = { environment: local, sync: { environment: env, transport: remote.transport } };
  const a = connectForestSession(key, map, "circle", 10, 0, () => {}, options);
  const b = connectForestSession(key, map, "world", 10, 0, () => {}, options);
  assert.equal(a.state, b.state);
  a.state.pendingLife = "mushroom"; a.state.reaction = 2; a.state.animation = { pose: "wave", elapsed: 1 };
  a.state.life.garden.basket.berries = 12;
  a.state.life.garden.routine = { kind: "harvest-berries", bushId: map.bushes[0].id, phase: "return-basket",
    elapsed: 1, totalElapsed: 8, carryingBasket: true };
  a.configure("circle", true); b.configure("world", true); assert.equal(b.isOwner(), false); await env.advance();
  assert.equal(b.isOwner(), true); assert.equal(a.isOwner(), false);
  assert.equal(remote.calls.filter(command => command.action === "acquire").length, 1);
  assert.equal(a.state.memory.reconciled, true); assert.equal(a.state.clearing.behavior.mind.needs.energy, .39);
  assert.deepEqual(a.state.clearing.position, map.actor.spawn); assert.deepEqual(a.state.clearing.behavior.mind.recent, []);
  assert.equal(a.state.life.mushrooms[0].growth, 1); assert.equal(a.state.pendingLife, null); assert.equal(a.state.animation, null);
  assert.equal(a.state.life.garden.basket.berries, 6); assert.equal(a.state.life.garden.routine, null);
  assert.equal(a.state.life.garden.bushes[0].growth, .58); assert.equal(a.state.life.garden.bushes[0].moisture, .76);
  assert.deepEqual(a.state.life.garden.basket.position, a.state.life.garden.basket.homePosition);
  assert.ok(records.has(forestMemoryKey(key)));
  a.release(); b.release(); await settle();
});

for (const authority of ["same", "changed-token", "expired", "foreign", "conflict", "read-error"]) {
  test(`visible camera handoff retains live delivery only with the same active lease: ${authority}`, async () => {
    const env = clock(), remote = server(env, payload(.61));
    const read = remote.transport.read, command = remote.transport.command;
    let handingOff = false, failed = false;
    remote.transport.read = async (...args) => {
      const result = await read(...args);
      if (!handingOff) return result;
      if (authority === "read-error" && !failed) { failed = true; throw Error("connection interrupted"); }
      if (authority === "changed-token") result.lease.token = uuid();
      if (authority === "expired") result.lease.expiresAt = new Date(env.now() - 1).toISOString();
      if (authority === "foreign") result.lease = { owned: false, token: null, expiresAt: new Date(env.now() + 90_000).toISOString() };
      return result;
    };
    remote.transport.command = async value => {
      if (handingOff && authority === "conflict" && value.action === "save" && !failed) {
        failed = true;
        throw new ApiError("changed", 409, { code: "FOREST_MEMORY_REVISION_CONFLICT", message: "changed" });
      }
      return command(value);
    };
    const key = `zhiv:mochlik:presence:${OWNER}`;
    const session = connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, { environment: null,
      sync: { environment: env, transport: remote.transport } });
    try {
      session.configure("circle", true); await env.advance();
      const garden = session.state.life.garden, clearing = session.state.clearing;
      assert.ok(garden.basket);
      garden.routine = { kind: "harvest-berries", bushId: TILED_WORLD.bushes[0].id, phase: "return-basket",
        elapsed: 1, totalElapsed: 8, carryingBasket: true };
      garden.basket.position = { x: garden.basket.homePosition.x + 10, y: garden.basket.homePosition.y + 10 };
      clearing.position = { x: TILED_WORLD.actor.spawn.x + 1, y: TILED_WORLD.actor.spawn.y };
      const feet = { ...clearing.position }, carriedBasket = { ...garden.basket.position };
      handingOff = true;
      session.configure("circle", false); session.configure("world", true);
      assert.equal(session.isOwner(), false, "lease loading pauses the scene");
      await env.advance(1000);
      if (authority === "same") {
        assert.equal(session.state.life.garden, garden);
        assert.equal(session.state.clearing, clearing);
        assert.equal(garden.routine.phase, "return-basket");
        assert.deepEqual(clearing.position, feet);
        assert.deepEqual(garden.basket.position, carriedBasket);
      } else {
        assert.notEqual(session.state.life.garden, garden, "untrusted continuity must hydrate instead of retaining the trip");
        assert.notEqual(session.state.clearing, clearing);
        assert.equal(session.state.life.garden.routine, null);
        assert.deepEqual(session.state.life.garden.basket.position, session.state.life.garden.basket.homePosition);
      }
      assert.equal(session.isOwner(), authority !== "foreign");
      assert.equal(session.state.memory.sync.mode, authority === "foreign" ? "other-device" : "synced");
    } finally { session.release(); await settle(); }
  });
}

test("hidden resume and a new session never replay an unfinished basket delivery", async () => {
  const env = clock(), remote = server(env, payload(.52)), key = `zhiv:mochlik:presence:${OWNER}`;
  const options = { environment: null, sync: { environment: env, transport: remote.transport } };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = { hidden: false };
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  let session = connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, options);
  try {
    session.configure("circle", true); await env.advance();
    for (const resume of ["hidden", "reload"]) {
      const garden = session.state.life.garden;
      garden.routine = { kind: "harvest-berries", bushId: TILED_WORLD.bushes[0].id, phase: "return-basket",
        elapsed: 1, totalElapsed: 8, carryingBasket: true };
      garden.basket.position = { x: garden.basket.homePosition.x + 10, y: garden.basket.homePosition.y + 10 };
      if (resume === "reload") {
        session.release(); await settle();
        session = connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, options);
      } else {
        document.hidden = true;
        session.configure("circle", false);
        // Visibility can return before the retirement save is acknowledged.
        // The same lease does not make a hidden page a live camera handoff.
        document.hidden = false;
      }
      session.configure("circle", true); await env.advance();
      assert.equal(session.isOwner(), true);
      assert.notEqual(session.state.life.garden, garden);
      assert.equal(session.state.life.garden.routine, null);
      assert.deepEqual(session.state.life.garden.basket.position, session.state.life.garden.basket.homePosition);
    }
  } finally {
    session.release(); await settle();
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
  }
});

test("capture expires old activity records even when a long action has not yet ended", () => {
  const session = connectForestSession(undefined, TILED_WORLD, "circle", 0, 0, () => {}, { persistence: false });
  session.state.clearing.behavior.mind.elapsed = 400;
  session.state.clearing.behavior.mind.recent = [{ key: "old", action: "rest", at: 0, duration: 1, outcome: "completed" }];
  const snapshot = captureForestMemory(session.state, TILED_WORLD);
  assert.equal(snapshot.mind.recent.length, 0); assert.equal(forestMemoryPayloadSchema.safeParse(snapshot).success, true); session.release();
});

function deferCommand(remote, action) {
  const original = remote.transport.command;
  let resolve, used = false;
  remote.transport.command = async (...args) => {
    const result = await original(...args);
    if (!used && args[0].action === action) { used = true; await new Promise(done => { resolve = done; }); }
    return result;
  };
  return () => { assert.ok(resolve, `expected delayed ${action}`); resolve(); };
}

for (const action of ["acquire", "save"]) test(`hide while ${action} is in flight releases the writer without a hidden acquisition loop`, async () => {
  const env = clock(), remote = server(env), resolve = deferCommand(remote, action), a = client(env, remote, .62);
  a.sync.setActive(true); await env.advance();
  if (action === "save") { a.sync.flush(); await env.advance(); }
  a.sync.setActive(false); resolve(); await settle(); await env.advance();
  assert.equal(remote.holder, null); assert.equal(a.sync.isSimulationAllowed(), false);
  if (action === "save") assert.equal(remote.snapshot.mind.needs.energy, .62);
  assert.equal(remote.calls.filter(command => command.action === "acquire").length, 1);
  a.sync.release(); await settle();
});

for (const action of ["save", "release"]) test(`resume during retiring ${action} reads fresh authority and resumes without freezing`, async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .52);
  a.sync.setActive(true); await env.advance();
  const resolve = deferCommand(remote, action);
  a.sync.setActive(false); await env.advance();
  a.sync.setActive(true); await env.advance(); resolve(); await settle(); await env.advance();
  assert.equal(a.sync.getStatus().mode, "synced"); assert.equal(a.sync.isSimulationAllowed(), true);
  assert.equal(a.value.mind.needs.energy, .52); assert.ok(remote.reads.length >= 2);
  a.sync.release(); await settle();
});

test("DEV suspension during an uncertain save only retries the clean body, never a mutated live reference", async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .44);
  a.sync.setActive(true); await env.advance();
  const resolve = deferCommand(remote, "save"); a.sync.flush(); await env.advance();
  a.sync.suspend(); a.value.mind.needs.energy = 0; resolve(); await settle(); await env.advance();
  assert.equal(remote.snapshot.mind.needs.energy, .44); assert.equal(remote.holder, null);
  assert.ok(remote.calls.filter(command => command.action === "save").every(command => command.snapshot.mind.needs.energy === .44));
  a.sync.release(); await settle();
});

test("rate-limit retry honors Retry-After and retains the pending command identity", async () => {
  const env = clock(), remote = server(env), original = remote.transport.command; let limited = true;
  const attempted = [];
  remote.transport.command = async command => {
    attempted.push(clone(command));
    if (limited && command.action === "save") { limited = false; throw new ApiError("slow down", 429, undefined, undefined, 20_000); }
    return original(command);
  };
  const a = client(env, remote, .81); a.sync.setActive(true); await env.advance(); a.sync.flush(); await env.advance();
  await env.advance(19_999); assert.equal(attempted.filter(command => command.action === "save").length, 1);
  await env.advance(1); const saves = attempted.filter(command => command.action === "save");
  assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]); assert.equal(remote.snapshot.mind.needs.energy, .81);
  a.sync.release(); await settle();
});

test("a valid near-limit server snapshot hydrates even with local cache metadata attached", async () => {
  const env = clock(), remembered = payload(.28);
  remembered.mushrooms = Array.from({ length: 128 }, (_, index) => ({ id: `m${index}`, position: { x: 1, y: 1 }, growth: .5, regrowIn: 0 }));
  remembered.hero.recent = Array.from({ length: 8 }, (_, index) => ({ id: `r${index}${"x".repeat(150)}`, activity: "look", age: 0 }));
  remembered.mind.recent = Array.from({ length: 16 }, (_, index) => ({ key: `r${index}${"x".repeat(150)}`, action: "look", outcome: "completed", at: 0, duration: 1 }));
  let size = JSON.stringify(remembered).length;
  for (const mushroom of remembered.mushrooms) {
    const extra = Math.min(160 - mushroom.id.length, 32_760 - size);
    if (extra <= 0) break;
    mushroom.id += "x".repeat(extra); size += extra;
  }
  assert.equal(size, 32_760); assert.equal(forestMemoryPayloadSchema.safeParse(remembered).success, true);
  const remote = server(env, remembered), key = `zhiv:mochlik:presence:${OWNER}`;
  const a = connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, { environment: null,
    sync: { environment: env, transport: remote.transport } });
  a.configure("circle", true); await env.advance();
  assert.equal(a.state.clearing.behavior.mind.needs.energy, .28); assert.equal(a.state.memory.restored, true);
  a.release(); await settle();
});

test("visible handoff preserves only an unchanged live lease; foreign, replaced or expired authority hydrates", async () => {
  for (const mode of ["same", "foreign", "replaced", "expired"]) {
    const env = clock(), remote = server(env, payload(.8)), local = client(env, remote);
    local.sync.setActive(true); await env.advance();
    local.value.mind.needs.energy = .42;
    const originalRead = remote.transport.read;
    remote.transport.read = async (...args) => {
      const value = await originalRead(...args);
      if (mode === "foreign") value.lease = { owned: false, token: null, expiresAt: new Date(env.now() + 90_000).toISOString() };
      if (mode === "replaced") value.lease = { ...value.lease, token: uuid() };
      if (mode === "expired") value.lease = { ...value.lease, owned: true, expiresAt: new Date(env.now() - 1).toISOString() };
      return value;
    };
    // Resume while the previous owner's save receipt is still in flight.
    local.sync.setActive(false);
    local.value.mind.needs.energy = .71;
    local.sync.setActive(true, true);
    const before = local.applied.length;
    await env.advance();
    if (mode === "same") {
      assert.equal(local.applied.length, before, "our own save acknowledgement cannot discard the handoff flag before the read");
      assert.equal(local.value.mind.needs.energy, .71);
    } else {
      assert.ok(local.applied.length > before, `${mode} authority must apply its snapshot`);
      assert.equal(local.value.mind.needs.energy, .42);
    }
    local.sync.release(); await settle();
  }
});

for (const interruption of ["ui-tab", "browser-tab"]) test(`parked ${interruption} preserves all three residents only after its unchanged release is reacquired`, async () => {
  const env = clock(), remote = server(env, payload(.52)), key = `zhiv:mochlik:presence:${OWNER}`;
  const options = { environment: null, sync: { environment: env, transport: remote.transport } };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = { hidden: false };
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  let session = connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, options);
  try {
    session.configure("circle", true, true); await env.advance();
    const state = session.state, clearing = state.clearing, plesk = state.pleskMind, builder = state.builderMind;
    clearing.position = { x: TILED_WORLD.actor.spawn.x + 2, y: TILED_WORLD.actor.spawn.y };
    plesk.position = { x: plesk.position.x + 3, y: plesk.position.y };
    builder.position = { x: builder.position.x + 4, y: builder.position.y };
    state.elapsed = 25; plesk.elapsed = 25; builder.elapsed = 25;
    const before = { hero: { ...clearing.position }, plesk: { ...plesk.position }, builder: { ...builder.position } };
    if (interruption === "ui-tab") session.release({ retain: true });
    else { document.hidden = true; session.configure("circle", false, true); }
    await env.advance();
    assert.equal(remote.holder, null, "an invisible forest does not hold the writer lease");
    const writes = remote.calls.length;
    await env.advance(600_000);
    assert.equal(remote.calls.length, writes, "no idle save/poll/renewal loop");
    assert.equal(state.elapsed, 25, "the full scene is paused, never advanced offline");
    if (interruption === "ui-tab") session = connectForestSession(key, TILED_WORLD, "world", 0, 0, () => {}, options);
    else document.hidden = false;
    assert.strictEqual(session.state, state);
    session.configure("world", true, true);
    assert.equal(session.isOwner(), false, "the cached runtime cannot tick before a fresh server read and acquire");
    await env.advance();
    assert.equal(session.isOwner(), true);
    assert.strictEqual(state.clearing, clearing); assert.strictEqual(state.pleskMind, plesk); assert.strictEqual(state.builderMind, builder);
    assert.deepEqual({ hero: clearing.position, plesk: plesk.position, builder: builder.position }, before);
    assert.equal(state.elapsed, 25); assert.equal(plesk.elapsed, 25); assert.equal(builder.elapsed, 25);
    assert.equal(remote.calls.filter(command => command.action === "acquire").length, 2);
  } finally {
    session.release(); await settle();
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else delete globalThis.document;
  }
});

for (const authority of ["foreign", "foreign-finished", "conflict", "read-error", "replayed-acquire", "replayed-release"]) {
  test(`parked runtime hydrates when release/acquire continuity is not proven: ${authority}`, async () => {
    const env = clock(), remote = server(env, payload(.61)), key = `zhiv:mochlik:presence:${OWNER}`;
    const options = { environment: null, sync: { environment: env, transport: remote.transport } };
    let session = connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, options), other;
    try {
      session.configure("circle", true, true); await env.advance();
      const clearing = session.state.clearing, plesk = session.state.pleskMind, builder = session.state.builderMind;
      session.state.elapsed = 40;
      if (authority === "replayed-release") {
        const command = remote.transport.command;
        remote.transport.command = async value => { const result = await command(value); return value.action === "release" ? { ...result, replayed: true } : result; };
      }
      session.release({ retain: true }); await env.advance();
      if (["foreign", "foreign-finished"].includes(authority)) {
        other = client(env, remote, .24); other.sync.setActive(true); await env.advance();
        other.value.mind.needs.energy = .24; other.sync.flush(); await env.advance();
        if (authority === "foreign-finished") { other.sync.setActive(false); await env.advance(); }
      }
      if (authority === "read-error") {
        const read = remote.transport.read; let fail = true;
        remote.transport.read = async (...args) => { if (fail) { fail = false; throw Error("offline"); } return read(...args); };
      }
      if (["conflict", "replayed-acquire"].includes(authority)) {
        const command = remote.transport.command; let fail = true;
        remote.transport.command = async value => {
          if (value.action === "acquire" && fail) {
            fail = false;
            if (authority === "conflict") throw new ApiError("changed", 409, { code: "FOREST_MEMORY_REVISION_CONFLICT", message: "changed" });
            return { ...await command(value), replayed: true };
          }
          return command(value);
        };
      }
      session = connectForestSession(key, TILED_WORLD, "world", 0, 0, () => {}, options);
      session.configure("world", true, true); await env.advance(1500);
      assert.notStrictEqual(session.state.clearing, clearing);
      assert.notStrictEqual(session.state.pleskMind, plesk); assert.notStrictEqual(session.state.builderMind, builder);
      assert.equal(session.state.elapsed, 0, "unsafe transient paths and clocks are not restored");
      assert.equal(session.isOwner(), authority !== "foreign");
    } finally { session.release(); other?.sync.release(); await settle(); }
  });
}

for (const action of ["save", "release"]) test(`visible park resume during its own ${action} acknowledgement preserves the live scene`, async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .52);
  try {
    a.sync.setActive(true); await env.advance();
    const applied = a.applied.length, resolve = deferCommand(remote, action);
    a.sync.setActive(false, true); await env.advance();
    a.sync.setActive(true, true); await env.advance();
    assert.equal(a.sync.isSimulationAllowed(), false, "unacknowledged authority cannot animate");
    resolve(); await settle(); await env.advance();
    assert.equal(a.sync.getStatus().mode, "synced"); assert.equal(a.sync.isSimulationAllowed(), true);
    assert.equal(a.applied.length, applied, "our read/ack/acquire sequence never hydrates the paused runtime");
    assert.ok(remote.reads.length >= 2);
    assert.equal(remote.snapshot.mind.needs.energy, .52);
  } finally { a.sync.release(); await settle(); }
});

test("a foreign writer winning between parked read and acquire prevents stale runtime continuity", async () => {
  const env = clock(), remote = server(env), a = client(env, remote, .52);
  try {
    a.sync.setActive(true); await env.advance();
    const applied = a.applied.length;
    a.sync.setActive(false, true); await env.advance();
    const command = remote.transport.command; let intercepted = false;
    remote.transport.command = async value => {
      if (value.action === "acquire" && !intercepted) {
        intercepted = true;
        await command({ ...value, clientId: uuid(), requestId: uuid(), takeover: false });
      }
      return command(value);
    };
    a.sync.setActive(true, true); await env.advance(250);
    assert.equal(intercepted, true); assert.equal(a.sync.isSimulationAllowed(), false);
    assert.equal(a.sync.getStatus().mode, "other-device");
    assert.ok(a.applied.length > applied, "CAS loss forces authoritative hydration before any later simulation");
  } finally { a.sync.release(); await settle(); }
});
