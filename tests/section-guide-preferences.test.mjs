import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { readSectionGuideLauncherPreference: read, saveSectionGuideLauncherPreference: save, sectionGuideLauncherPreferenceKey: key } = await vite.ssrLoadModule("/features/onboarding/section-guide-preferences.ts");
function storage() {
  const values = new Map();
  return { getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) };
}

test("replay buttons are shown by default and a player's choice survives reading settings again", () => {
  const disk = storage();
  assert.equal(read("player-a", disk), true);
  save("player-a", false, disk);
  assert.equal(read("player-a", disk), false);
  assert.equal(read("player-b", disk), true, "another account keeps its own choice");
  save("player-a", true, disk);
  assert.equal(read("player-a", disk), true);
});

test("changing the replay preference preserves existing lesson progress", () => {
  const disk = storage(), progressKey = "zhiv.section-guide.v1:learner:plesk";
  const progress = JSON.stringify({ version: 1, stepId: "bait", status: "paused" });
  disk.setItem(progressKey, progress);
  save("learner", false, disk);
  assert.equal(disk.getItem(progressKey), progress);
  assert.notEqual(key("learner:plesk"), key("learner"));
  disk.setItem(key("invalid-preference"), "malformed");
  assert.equal(read("invalid-preference", disk), true);
});

test("unavailable storage retains the setting in memory without affecting another player", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  save("blocked-player", false, broken);
  assert.equal(read("blocked-player", broken), false);
  assert.equal(read("another-blocked-player", broken), true);
  const restored = storage();
  save("blocked-player", true, restored);
  assert.equal(read("blocked-player", restored), true);
});
