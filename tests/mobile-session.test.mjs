import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createMobileSession } = await vite.ssrLoadModule("/apps/mobile/src/mobile-session.ts");
after(() => vite.close());
const guest = { authenticated: false, configured: true };
const member = id => ({ authenticated: true, configured: true, userId: id });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
  const reads = [], transitions = [];
  let event = () => {};
  const port = { getState: async () => guest, login: async () => member("A"), cancelLogin: async () => {},
    subscribe: async listener => { event = listener; return () => { event = () => {}; }; },
    hydrate: async owner => { reads.push(owner); }, ...overrides };
  const session = createMobileSession(port);
  session.subscribe(() => transitions.push(session.getSnapshot()));
  return { session, reads, transitions, event: state => event(state) };
}

test("game cannot mount until the signed-in owner's durable state is hydrated", async () => {
  let finish;
  const s = setup({ getState: async () => member("A"), hydrate: () => new Promise(resolve => { finish = resolve; }) });
  const starting = s.session.initialize(); await tick();
  assert.equal(s.session.getSnapshot().phase, "loading");
  finish(); await starting;
  assert.equal(s.session.getSnapshot().phase, "authenticated");
  assert.equal(s.session.getSnapshot().userId, "A");
  s.session.dispose();
});

test("account change during hydration never paints the retired account", async () => {
  let release;
  const reads = [];
  const s = setup({ hydrate: async owner => { reads.push(owner); if (owner === "A") await new Promise(resolve => { release = resolve; }); } });
  await s.session.initialize();
  s.event(member("A")); await tick();
  s.event(member("B"));
  assert.equal(s.session.getSnapshot().phase, "loading");
  assert.equal(s.session.getSnapshot().userId, null);
  release(); await tick(); await tick();
  assert.deepEqual(reads, [undefined, "A", "B"]);
  assert.equal(s.transitions.some(state => state.phase === "authenticated" && state.userId === "A"), false);
  assert.equal(s.session.getSnapshot().userId, "B");
  s.session.dispose();
});

test("new session event wins against a late launch-state response", async () => {
  let reply;
  const s = setup({ getState: () => new Promise(resolve => { reply = resolve; }) });
  const starting = s.session.initialize(); await tick();
  s.event(member("B")); await tick();
  reply(member("A")); await starting;
  assert.deepEqual(s.reads, ["B"]);
  assert.equal(s.session.getSnapshot().userId, "B");
  s.session.dispose();
});

test("storage failure blocks game and can recover without replacing credentials", async () => {
  let fail = true;
  const s = setup({ getState: async () => member("A"), hydrate: async () => { if (fail) throw new Error("Disk unavailable"); } });
  await s.session.initialize();
  assert.equal(s.session.getSnapshot().phase, "error");
  fail = false; await s.session.refresh();
  assert.equal(s.session.getSnapshot().phase, "authenticated");
  s.session.dispose();
});

test("logout unmounts the game before clearing account persistence", async () => {
  const s = setup({ getState: async () => member("A") });
  await s.session.initialize();
  s.event(guest);
  assert.equal(s.session.getSnapshot().phase, "loading");
  assert.equal(s.session.getSnapshot().userId, null);
  await tick();
  assert.deepEqual(s.reads, ["A", undefined]);
  assert.equal(s.session.getSnapshot().phase, "signed-out");
  s.session.dispose();
});
