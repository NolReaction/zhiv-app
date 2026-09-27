import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { requestForestDirective, advanceForestDirector } = await vite.ssrLoadModule("/features/world/forest-director.ts");
const { clearingActivityFrame } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { forestGardenVisualFrame } = await vite.ssrLoadModule("/features/world/forest-garden-painter.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: true };

test("a real harvest preserves basket position through pickup, walking, collecting and parking", () => {
  for (const [level, size] of [[1, 50], [5, 56]]) {
    const scene = structuredClone(previewWorldScene(TILED_WORLD, { home: level }));
    scene.actor.size = size;
    const session = connectForestSession(undefined, scene, "circle", 0, 0, () => {}), state = session.state;
    session.release();
    const garden = state.life.garden;
    garden.bushes.forEach(bush => { bush.growth = 1; });
    requestForestDirective(state, "harvest-berries", calm);
    const phases = new Set();
    let previous = null, delivered = false;
    for (let tick = 0; tick < 3600; tick++) {
      advanceForestDirector(state, .025, calm);
      const motion = clearingActivityFrame(state.clearing);
      const frame = forestGardenVisualFrame(garden, { x: motion.x, y: motion.y, size }, motion);
      const phase = garden.routine?.phase ?? "done";
      // A parked basket stores its coordinates in position; held baskets use x/y.
      const position = frame?.basket ?? garden.basket?.position;
      assert.ok(position, `level ${level} has a basket position`);
      if (previous && previous.phase !== phase) {
        const jump = Math.hypot(position.x - previous.x, position.y - previous.y);
        assert.ok(jump < size * .03,
          `level ${level}: ${previous.phase} -> ${phase} jumps ${jump} world units`);
      }
      previous = { phase, x: position.x, y: position.y };
      phases.add(phase);
      if (phase === "done" && garden.basket.berries === 3) { delivered = true; break; }
    }
    assert.ok(delivered, `level ${level} completes an actual harvest`);
    for (const phase of ["take-basket", "approach-bush", "collect", "return-basket", "deposit", "settle"])
      assert.ok(phases.has(phase), `level ${level} exercises ${phase}`);
  }
});
