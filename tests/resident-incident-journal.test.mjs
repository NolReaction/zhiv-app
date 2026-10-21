import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createResidentIncidentJournal, RESIDENT_JOURNAL_LIMITS } = await vite.ssrLoadModule("/features/world/dev/resident-incident-journal.ts");
const sample = (elapsed = 0, patch = {}, source = "zhiv:mochlik:presence:private-owner") => ({ source, elapsed, actors: [{
  id: "lopukh", available: true, goal: "Прогулка", phase: "walk", target: "clearing-path", reason: "Идёт по тропе",
  position: { x: 100, y: 100 }, remaining: 80, routePoints: 10, blockingNeighbour: null, ...patch,
}] });
const context = { owner: {}, settings: { weather: "clear", autoLife: true }, rehearsal: null };

test("recording is explicit; foot samples do not become events, but blockers and phases form a useful sequence", () => {
  const journal = createResidentIncidentJournal();
  journal.observe(sample(), context, true); assert.equal(journal.getSnapshot().recording, false); assert.equal(journal.getSnapshot().events.length, 0);
  journal.setRecording(true); const initial = journal.getSnapshot(); assert.equal(initial.events.length, 1); assert.equal(initial.events[0].kind, "initial");
  const input = sample(.5, { position: { x: 110, y: 100 }, remaining: 70 }); const before = structuredClone(input);
  journal.observe(input, context, false); assert.deepEqual(input, before); assert.equal(journal.getSnapshot().events.length, 1);
  input.actors[0].position.x = 999; assert.equal(JSON.parse(journal.exportReport().json).residents[0].position.x, 110);
  journal.observe(sample(1, { blockingNeighbour: "builder", position: { x: 110, y: 100 }, remaining: 70 }), context, false);
  journal.observe(sample(1.5, { position: { x: 110, y: 100 }, remaining: 70 }), context, false);
  assert.deepEqual(journal.getSnapshot().events.map(event => event.kind), ["initial", "blocked", "released"]);
  assert.deepEqual(journal.getSnapshot().events[1].changes.map(change => change.field), ["blockingNeighbour"]);
  assert.throws(() => { initial.events[0].changes[0].after = "changed"; }, TypeError);
});

test("interruptions are explicitly inferred while a normal route arrival is not blamed on cancellation", () => {
  const journal = createResidentIncidentJournal(); journal.observe(sample(), context, true); journal.setRecording(true);
  journal.observe(sample(.5, { goal: "Работа", target: "woodlot-tree", position: { x: 101, y: 100 } }), context, false);
  assert.equal(journal.getSnapshot().events.at(-1).kind, "interruption"); assert.equal(journal.getSnapshot().events.at(-1).inferred, true);
  journal.observe(sample(1, { goal: "Работа", target: "woodlot-tree", position: { x: 171, y: 100 }, remaining: 10 }), context, false);
  journal.observe(sample(1.5, { goal: "Работа", target: "woodlot-tree", position: { x: 181, y: 100 }, remaining: 0, routePoints: 0, phase: "inspect" }), context, false);
  assert.equal(journal.getSnapshot().events.at(-1).kind, "change"); assert.equal(journal.getSnapshot().events.at(-1).inferred, false);
  journal.observe(sample(2, { target: "curved-trail-end", position: { x: 180, y: 100 }, remaining: 18 }), context, false);
  journal.observe(sample(2.5, { target: "curved-trail-end", position: { x: 188, y: 100 }, remaining: 0, routePoints: 0, phase: "inspect" }), context, false);
  assert.equal(journal.getSnapshot().events.at(-1).inferred, false, "straight displacement may be shorter than the completed curved route");
});

test("a stopped recording freezes its export; its window and event count are bounded in active scene time", () => {
  const journal = createResidentIncidentJournal(); journal.observe(sample(), context, true); journal.setRecording(true);
  for (let index = 1; index <= 200; index++) journal.observe(sample(index / 2, { phase: index % 2 ? "inspect" : "idle", target: `stop-${index}` }), context, false);
  const view = journal.getSnapshot(); assert.ok(view.events.length <= 120); assert.ok(view.events.every(event => event.at >= 40)); assert.ok(view.dropped > 0);
  journal.setRecording(false); const frozen = journal.exportReport();
  journal.observe(sample(500, { target: "unrecorded-later-place" }), { settings: { weather: "downpour" } }, false);
  assert.deepEqual(journal.exportReport(), frozen); assert.equal(journal.getSnapshot().elapsed, 100);
  journal.setRecording(true); assert.equal(journal.getSnapshot().startedAt, 500); assert.equal(journal.getSnapshot().events.length, 1);
  assert.equal(journal.getSnapshot().events[0].changes.find(change => change.field === "target").after, "unrecorded-later-place");
});

test("export whitelists provenance/settings, removes private source and keeps bytes bounded even for long unicode changes", () => {
  const journal = createResidentIncidentJournal(), owner = { ownerSentinel: "never-export-owner-object" };
  const unsafeContext = { owner, settings: { weather: "rain", autoLife: false, token: "secret-settings", levels: { home: 99 }, ownerPublicId: "private-account" },
    rehearsal: { id: 5, actor: "lopukh", scenario: "walk", seed: 17, balance: 999, ownerPublicId: "private-account" } };
  journal.observe(sample(0, { reason: "owner=hidden-secret alice@example.com https://secret.example/a 01234567-89ab-cdef-0123-456789abcdef" }), unsafeContext, true);
  journal.setRecording(true);
  const first = JSON.parse(journal.exportReport().json);
  assert.deepEqual(first.context.settings, { weather: "rain", autoLife: false });
  assert.deepEqual(first.context.rehearsal, { id: 5, scenario: "walk", actor: "lopukh", seed: 17 });
  assert.equal(first.scene.source, "world"); assert.ok(!journal.exportReport().json.includes("private-owner"));
  for (const privateText of ["never-export-owner-object", "secret-settings", "private-account", "hidden-secret", "alice@example.com", "https://secret.example", "01234567-89ab-cdef"]) assert.ok(!journal.exportReport().json.includes(privateText));
  for (let index = 1; index <= 150; index++) journal.observe(sample(index / 4, { goal: `${index}${"Я".repeat(5000)}`, phase: `${index}${"Ф".repeat(5000)}`,
    target: `${index}${"М".repeat(5000)}`, reason: "Р".repeat(5000), blockingNeighbour: index % 2 ? "builder" : null }), unsafeContext, false);
  const report = journal.exportReport(), parsed = JSON.parse(report.json);
  assert.ok(new TextEncoder().encode(report.json).byteLength <= RESIDENT_JOURNAL_LIMITS.bytes);
  assert.ok(parsed.events.length <= RESIDENT_JOURNAL_LIMITS.events); assert.ok(parsed.window.dropped > 0);
  assert.match(report.filename, /^zhiv-residents-capture-\d+\.json$/);
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "tool", "scene", "recording", "startedAt", "window", "context", "residents", "events"]);
});

test("a new source/owner capture cannot mix old events, and reset removes all exportable data", () => {
  const journal = createResidentIncidentJournal(); journal.observe(sample(10, { target: "old-world-stop" }), context, true); journal.setRecording(true);
  const capture = journal.getSnapshot().capture;
  journal.observe(sample(0, { target: "new-rehearsal-stop" }, "dev:scene:22"), { rehearsal: { id: 22, actor: "lopukh", scenario: "walk", seed: 2 } }, true);
  assert.ok(journal.getSnapshot().capture > capture); assert.equal(journal.getSnapshot().recording, true);
  const data = JSON.parse(journal.exportReport().json); assert.equal(data.scene.source, "rehearsal"); assert.equal(data.events.length, 1);
  assert.ok(!journal.exportReport().json.includes("old-world-stop"));
  journal.reset(false); assert.equal(journal.exportReport(), null); assert.equal(journal.getSnapshot().recording, false);
});
