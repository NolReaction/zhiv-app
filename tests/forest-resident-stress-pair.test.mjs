import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { advanceResidentStress } = await vite.ssrLoadModule("/features/world/dev/forest-resident-stress.ts");
const request = { id: 1, scenario: "work-interruption", actor: "lopukh", target: "kamneshmyg" };
const environment = { occupants: [], now: 100_000, social: { actors: [] } };
function setup() {
  const mind = () => ({ available: true, elapsed: 10, outdoorUntil: 0, route: null, job: false, wait: 0, doorPhase: "outside" });
  const access = { ownerPublicId: "dev-scene-1", revision: 1, production: { jobs: [] } };
  return { elapsed: 10, villagers: { residents: { lopukh: mind(), kamneshmyg: mind() } }, economyResidents: access,
    social: { elapsed: 10, nextEncounterAt: 0, nextPassingAt: 0,
      meeting: { guest: "builder", host: "mochlik", phase: "talk" }, current: { speaker: "builder" } } };
}
const stress = () => ({ phase: "talking", nextAt: 10.8, meetingAttempts: 1, since: 0,
  sawCarry: false, sawBlockedDoor: false, initialCycles: 0, workStarted: false });

test("a lost rehearsal approach never injects work into an unrelated exchange and has a finite retry budget", () => {
  const state = setup(), runtime = stress(), account = structuredClone(state.economyResidents);
  advanceResidentStress(state, {}, request, runtime, environment);
  assert.equal(runtime.workStarted, false); assert.equal(runtime.phase, "prepare");
  assert.deepEqual(state.economyResidents, account);
  assert.ok(state.social.nextEncounterAt > state.social.elapsed + 100);
  // nextAt is deliberately in the future, as the real wrapper sets it before
  // entering the controller. A lost pair must still release the talking phase.
  runtime.meetingAttempts = 3;
  const result = advanceResidentStress(state, {}, request, runtime, environment);
  assert.equal(result.status, "blocked"); assert.match(result.message, /три попытки/);
  assert.deepEqual(state.economyResidents, account);
});

test("even the selected meeting requires a live line from its own participants before issuing work", () => {
  const state = setup(), runtime = stress(), access = state.economyResidents;
  state.social.meeting = { guest: "lopukh", host: "kamneshmyg", phase: "talk" };
  advanceResidentStress(state, {}, request, runtime, environment);
  assert.equal(runtime.workStarted, false); assert.equal(runtime.phase, "talking");
  assert.equal(state.economyResidents, access);
});
