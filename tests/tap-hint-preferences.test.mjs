import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { readTapHintPreference: read, saveTapHintPreference: save, tapHintPreferenceKey: key } = await vite.ssrLoadModule("/features/world/state/tap-hint-preferences.ts");
function storage() {
  const values = new Map();
  return { getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) };
}

test("tap diamonds start enabled and each player keeps their own saved appearance choice", () => {
  const disk = storage();
  assert.equal(read("player-a", disk), true);
  save("player-a", false, disk);
  assert.equal(read("player-a", disk), false);
  assert.equal(read("player-b", disk), true);
  save("player-a", true, disk);
  assert.equal(read("player-a", disk), true);
  assert.notEqual(key("player:a"), key("player%3Aa"));
});

test("turning off tap diamonds does not change lesson progress or manual help preferences", () => {
  const disk = storage();
  const lessonKey = "zhiv.section-guide.v1:learner:plesk", launcherKey = "zhiv.section-guide.launcher.v1:learner";
  const progress = JSON.stringify({ version: 1, stepId: "bait", status: "paused" });
  disk.setItem(lessonKey, progress); disk.setItem(launcherKey, "true");
  save("learner", false, disk);
  assert.equal(disk.getItem(lessonKey), progress);
  assert.equal(disk.getItem(launcherKey), "true");
  disk.setItem(key("invalid-preference"), "malformed");
  assert.equal(read("invalid-preference", disk), true);
});

test("blocked browser storage keeps the preference for the current page without leaking between accounts", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  save("blocked-player", false, broken);
  assert.equal(read("blocked-player", broken), false);
  assert.equal(read("another-player", broken), true);
  const restored = storage();
  save("blocked-player", true, restored);
  assert.equal(read("blocked-player", restored), true);
});
