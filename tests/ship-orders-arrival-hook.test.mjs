import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), virtual = "virtual:ship-arrival-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "ship-arrival-hook-lifecycle", enforce: "pre",
    resolveId(id) { if (id === virtual) return `\0${id}`; },
    load(id) { if (id === `\0${virtual}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; }
      export function useRef(initial) { return slots[cursor++] ??= { current: initial }; }
      export function useEffect(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
          slots[index] = dependencies; effects.push(callback);
        }
      }
      export function flushEffects() { const pending = effects; effects = []; pending.forEach(callback => callback()); }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/sync/use-ship-orders-arrival.ts"))
      return source.replace('from "react";', `from "${virtual}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(virtual);
const { useShipOrdersArrival } = await vite.ssrLoadModule("/features/economy/sync/use-ship-orders-arrival.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.parse("2026-11-01T14:00:00Z"), sixHours = 21600000;
const voyageId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => hooks.reset());

function fixture() {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  Object.assign(state.buildings, { lighthouse: 1, bridge: 1, kiln: 3, woodlot: 3, quarry: 3, dryer: 1 });
  const calls = [], controller = { snapshot: { ...structuredClone(state), ownerPublicId: owner, revision: 1 },
    snapshotConfirmed: true, busy: false, uncertain: false, directActionsAvailable: true, now,
    act(action, targetId) {
      const command = { action, targetId, requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: controller.snapshot.revision,
        quantity: 1, totalPrice: 0 };
      // Exercise the real command contract as well as the React side effect.
      applyEconomyCommand(state, command, controller.now, () => voyageId);
      calls.push(command); return true;
    } };
  const snapshot = revision => ({ ...structuredClone(state), ownerPublicId: owner, revision });
  const useArrivalRender = (overrides = {}, enabled = true, targetOwner = owner) => {
    Object.assign(controller, overrides); hooks.render(); useShipOrdersArrival(controller, targetOwner, enabled); hooks.flushEffects();
  };
  return { state, calls, controller, snapshot, render: useArrivalRender };
}

test("a confirmed lighthouse prepares its real manifest automatically before any ship-window interaction", () => {
  const { render, state, calls } = fixture(); render();
  assert.equal(calls.length, 1); assert.equal(calls[0].action, "open_ship_voyage");
  assert.equal(state.ship.voyage.orders.length, 3); assert.equal(state.ship.nextAvailableAt, null);
  assert.deepEqual(state.ship.voyage.orders.map(order => order.difficulty), ["easy", "medium", "hard"]);
});

test("guests, stale snapshots, locked lighthouses and unavailable commands cannot prepare a manifest", () => {
  for (const kind of ["foreign", "unconfirmed", "missing", "locked", "busy", "uncertain", "unavailable", "disabled"]) {
    hooks.reset(); const { render, calls, controller } = fixture(), valid = controller.snapshot;
    const patch = kind === "foreign" ? { snapshot: { ...valid, ownerPublicId: other } }
      : kind === "unconfirmed" ? { snapshotConfirmed: false }
      : kind === "missing" ? { snapshot: null }
      : kind === "locked" ? { snapshot: { ...valid, buildings: { ...valid.buildings, lighthouse: 0 } } }
      : kind === "busy" ? { busy: true }
      : kind === "uncertain" ? { uncertain: true }
      : kind === "unavailable" ? { directActionsAvailable: false } : {};
    render(patch, kind !== "disabled"); assert.equal(calls.length, 0, kind);
    render({ snapshot: valid, snapshotConfirmed: true, busy: false, uncertain: false, directActionsAvailable: true });
    assert.equal(calls.length, 1, `${kind}: recovering the gate prepares the manifest`);
  }
});

test("busy transitions, clock ticks and reopening the map cannot resend an accepted preparation against stale revision", () => {
  const { render, controller, calls } = fixture(); render();
  render({ busy: true }); render({ busy: false, now: now + 1000 }); render({}, false); render({}, true);
  render({ snapshot: structuredClone(controller.snapshot), now: now + 2000 });
  assert.equal(calls.length, 1);
});

test("the next ship waits for the full cooldown, including at one millisecond before its deadline", () => {
  const { render, controller, calls, state, snapshot } = fixture();
  state.ship = { voyage: null, completedVoyages: 1, nextAvailableAt: new Date(now + sixHours).toISOString() };
  controller.snapshot = snapshot(7);
  render({ now }); render({ now: now + sixHours - 1 }); assert.equal(calls.length, 0);
  render({ now: now + sixHours }); assert.equal(calls.length, 1);
  assert.equal(state.ship.voyage.number, 2);
  render({ now: now + sixHours + 1000 }); assert.equal(calls.length, 1);
});

test("an existing partly loaded or partly delivered voyage stays aboard even when an old opening timer expired", () => {
  const { render, controller, calls, state, snapshot } = fixture(); render();
  const first = state.ship.voyage.orders[0]; first.deliveredAt = new Date(now - 1000).toISOString();
  state.ship.nextAvailableAt = new Date(now - sixHours).toISOString(); controller.snapshot = snapshot(2);
  render(); render({ now: now + sixHours }); assert.equal(calls.length, 1);
  assert.equal(state.ship.voyage.id, voyageId);
});

test("a fully delivered old save automatically receives its final bonus and starts cooldown from this completion", () => {
  const { render, controller, calls, state, snapshot } = fixture(); render();
  const before = state.wallet.pearls;
  for (const order of state.ship.voyage.orders) order.deliveredAt = new Date(now - 1000).toISOString();
  state.ship.voyage.rewardPearls = 4;
  state.ship.nextAvailableAt = new Date(now - sixHours).toISOString(); controller.snapshot = snapshot(2);
  render({ now: now + 1000 });
  assert.equal(calls.length, 2); assert.equal(calls[1].action, "claim_ship_voyage"); assert.equal(calls[1].targetId, voyageId);
  assert.equal(formatPearls(state.wallet.pearls - before), "10");
  assert.equal(state.ship.voyage, null); assert.equal(state.ship.nextAvailableAt, new Date(now + 1000 + sixHours).toISOString());
  render({ busy: true }); render({ busy: false, now: now + 2000 }); assert.equal(calls.length, 2, "stale completed snapshot cannot claim twice");
  render({ snapshot: snapshot(3) }); assert.equal(calls.length, 2, "new cleared snapshot still waits for the cooldown");
});

test("a command rejected locally before dispatch can be retried after the write gate clears", () => {
  const { render, controller, calls } = fixture(), send = controller.act;
  controller.act = () => false; render(); assert.equal(calls.length, 0);
  render({ act: send, now: now + 1000 }); assert.equal(calls.length, 1);
});


test("a live voyage expires once at 24 hours and the next manifest waits until 30 hours", () => {
  const { render, calls, state, snapshot } = fixture(); render(); render({ snapshot: snapshot(2), now: now + 86400000 - 1 });
  assert.equal(calls.length, 1);
  render({ now: now + 86400000 }); assert.equal(calls.length, 2); assert.equal(calls[1].action, "expire_ship_voyage");
  assert.equal(state.ship.voyage, null); assert.equal(state.ship.nextAvailableAt, new Date(now + 108000000).toISOString());
  render({ now: now + 86401000 }); assert.equal(calls.length, 2, "the unacknowledged expired revision cannot send twice");
  render({ snapshot: snapshot(3), now: now + 108000000 - 1 }); assert.equal(calls.length, 2);
  render({ now: now + 108000000 }); assert.equal(calls.length, 3); assert.equal(calls[2].action, "open_ship_voyage");
  assert.equal(state.ship.voyage.number, 1, "expiry does not count as completion");
});
