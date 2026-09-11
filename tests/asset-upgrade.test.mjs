import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('detail upgrades recover automatically, stop retrying in the background and release timers on disposal', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const vite = await createServer({ appType: 'custom', configFile: false, root, server: { middlewareMode: true, hmr: false } });
  const { createAssetUpgrade } = await vite.ssrLoadModule('/features/mochlik/assets.ts');
  await vite.close();
  const originals = new Map(), timers = new Map(), listeners = new Map();
  let timerId = 0, calls = 0, fail = true, active = true;
  const install = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  const events = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  install('window', events); install('document', { ...events, hidden: false });
  install('setTimeout', (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; });
  install('clearTimeout', id => timers.delete(id));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fireTimer = () => { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); };
  let upgrade;
  try {
    upgrade = createAssetUpgrade(async () => { calls++; if (fail) throw new Error('interrupted'); }, () => active && !document.hidden);
    upgrade.retry(); upgrade.retry(); await flush();
    assert.equal(calls, 1, 'overlapping triggers share a single running attempt');
    for (const delay of [2000, 8000, 30000]) {
      upgrade.retry(); await flush();
      assert.equal([...timers.values()][0].ms, delay);
      fireTimer(); await flush();
    }
    assert.equal(calls, 4); assert.equal(timers.size, 0, 'automatic retries are bounded');
    upgrade.retry(); await flush(); assert.equal(calls, 4, 'ordinary scene updates do not renew an exhausted retry budget');
    listeners.get('online')(); await flush(); assert.equal(timers.size, 1);
    document.hidden = true; listeners.get('visibilitychange')(); assert.equal(timers.size, 0);
    listeners.get('focus')(); await flush(); assert.equal(calls, 5, 'hidden page never begins a download');
    document.hidden = false; fail = false;
    listeners.get('visibilitychange')(); await flush(); assert.equal(calls, 6); assert.equal(timers.size, 0);
    fail = true; upgrade.retry(); await flush(); assert.equal(timers.size, 1);
    active = false; fireTimer(); await flush(); assert.equal(calls, 7);
    active = true; upgrade.retry(); await flush();
    upgrade.dispose(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
    upgrade.retry(); await flush(); assert.equal(calls, 8);
  } finally {
    upgrade?.dispose();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
