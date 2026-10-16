import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMapSceneRehearsal } = await vite.ssrLoadModule('/features/world/scene/map-scene-rehearsal.ts');
const request = id => ({ id, scenario: 'walk', actor: 'lopukh' });
function harness() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({}) } });
  const make = () => ({ configurations: [], disposed: 0, configure(value) { this.configurations.push(value); }, dispose() { this.disposed++; } });
  const natural = make(), mounted = [], selected = [], failures = [];
  const controller = createMapSceneRehearsal({ natural, mount(canvas, options, callbacks) {
    const handle = make(); mounted.push({ handle, options, callbacks }); return handle;
  }, select: (handle, request) => selected.push({ handle, request }), rendered() {}, failed: id => failures.push(id) });
  const restore = () => { controller.dispose(); if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; };
  const original = { paused: false, reducedMotion: false, lampOn: false, dusk: false, serverNow: 100000,
    presenceKey: 'zhiv:mochlik:presence:real-owner', economyJourney: { id: 'real-journey' },
    economyProduction: { ownerPublicId: 'real-owner', revision: 7, jobs: [{ id: 'real-job' }] } };
  return { controller, original, natural, mounted, selected, failures, restore };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('a rehearsal parks the account, uses an ephemeral job snapshot and restores the same habitat on stop', async () => {
  const h = harness(), before = structuredClone(h.original);
  try {
    h.controller.configure(h.original, request(1), false);
    assert.equal(h.natural.configurations.at(-1).backgrounded, true);
    const preview = h.mounted[0];
    assert.notEqual(preview.options.presenceKey, h.original.presenceKey);
    assert.equal(preview.options.devRehearsal.id, 1);
    assert.notDeepEqual(preview.options.economyProduction?.jobs, h.original.economyProduction.jobs);
    assert.equal(h.selected.length, 0, 'a loading scene cannot replace the account artwork');
    preview.callbacks.ready(); await flush();
    assert.equal(h.selected.at(-1).handle, preview.handle);
    h.controller.configure({ ...h.original, paused: true }, request(1), true);
    assert.equal(preview.handle.configurations.at(-1).paused, true);
    assert.equal(preview.handle.configurations.at(-1).backgrounded, true);
    h.controller.configure(h.original, null, false);
    assert.equal(preview.handle.disposed, 1);
    assert.equal(h.selected.at(-1).handle, h.natural);
    assert.equal(h.natural.configurations.at(-1).backgrounded, false);
    assert.deepEqual(h.original, before, 'simulation and economics of the real account are never rewritten');
  } finally { h.restore(); }
  assert.equal(h.natural.disposed, 1);
});

test('replacing or disposing a loading rehearsal fences all late ready, failure and rendered callbacks', async () => {
  const h = harness();
  try {
    h.controller.configure(h.original, request(1), false); const first = h.mounted[0];
    h.controller.configure(h.original, request(2), false); const second = h.mounted[1];
    assert.equal(first.handle.disposed, 1);
    first.callbacks.ready(); first.callbacks.failure(); first.callbacks.rendered(); await flush();
    assert.equal(h.selected.length, 0); assert.deepEqual(h.failures, []);
    second.callbacks.ready(); await flush(); assert.equal(h.selected.at(-1).request.id, 2);
    h.controller.dispose();
    second.callbacks.ready(); second.callbacks.failure(); await flush();
    assert.equal(h.selected.length, 1); assert.deepEqual(h.failures, []);
    assert.equal(second.handle.disposed, 1);
  } finally { h.restore(); }
});

test('an artwork failure restores the account and does not restart on visibility updates', async () => {
  const h = harness();
  try {
    h.controller.configure(h.original, request(3), false);
    h.mounted[0].callbacks.failure(); await flush();
    assert.deepEqual(h.failures, [3]); assert.equal(h.natural.configurations.at(-1).backgrounded, false);
    h.controller.configure(h.original, request(3), true);
    h.controller.configure(h.original, request(3), false);
    assert.equal(h.mounted.length, 1, 'retry requires a fresh user request');
    assert.equal(h.natural.configurations.at(-1).backgrounded, false);
    h.controller.configure(h.original, request(4), false);
    assert.equal(h.mounted.length, 2);
  } finally { h.restore(); }
});
