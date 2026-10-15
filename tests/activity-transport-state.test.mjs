import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { setGamePresence, gamePresenceHeaders, subscribeGamePresence } = await vite.ssrLoadModule("/features/activity/transport-state.ts");

test("presence subscribers see replacement and disconnection once and unsubscribe cleanly", () => {
  const seen = [], unsubscribe = subscribeGamePresence(() => seen.push(gamePresenceHeaders()["X-Game-Presence"] ?? null));
  try {
    setGamePresence("first"); setGamePresence("first");
    setGamePresence(null); setGamePresence(null); setGamePresence("replacement");
    assert.deepEqual(seen, ["first", null, "replacement"]);
    unsubscribe(); unsubscribe(); setGamePresence(null);
    assert.deepEqual(seen, ["first", null, "replacement"]);
  } finally { unsubscribe(); setGamePresence(null); }
});
