import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({ appType: "custom", configFile: false, root: fileURLToPath(new URL("..", import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { rememberEarthSection, restoreEarthSection } = await vite.ssrLoadModule("/features/app/earth-navigation-state.ts");

test("reload restores only this owner's map section; leaving it clears the preference", () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  assert.equal(restoreEarthSection("first", storage), false);
  rememberEarthSection("first", true, storage);
  assert.equal(restoreEarthSection("first", storage), true);
  assert.equal(restoreEarthSection("second", storage), false);
  assert.deepEqual([...entries.values()], ["first"], "no camera coordinates, zoom or geolocation permission are remembered");
  rememberEarthSection("first", false, storage);
  assert.equal(restoreEarthSection("first", storage), false);
});

test("blocked session storage and SSR do not prevent opening or leaving the map", () => {
  const unavailable = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  assert.equal(restoreEarthSection("first", unavailable), false);
  assert.doesNotThrow(() => rememberEarthSection("first", true, unavailable));
  assert.doesNotThrow(() => rememberEarthSection("first", false, unavailable));
  assert.equal(restoreEarthSection("first"), false);
});
