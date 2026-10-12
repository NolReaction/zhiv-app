import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { worldCoachLayout } = await vite.ssrLoadModule("/features/onboarding/guide-coach-layout.ts");
const bounds = (left, top, width, height) => ({ left, top, width, height });

test("map lessons are centered with equal margins on narrow and wider phones", () => {
  for (const width of [320, 393, 440]) {
    const viewport = bounds(0, 0, width, 852), hud = bounds(0, 754, width, 98);
    const coach = worldCoachLayout(viewport, 118, { bottomHud: hud });
    assert.equal(coach.left, (width - coach.width) / 2);
    assert.ok(coach.left >= 12);
    assert.equal(coach.top + 118, hud.top - 20, "the safe-area-aware HUD retains a visible gap above it");
    assert.ok(coach.top + 118 < hud.top);
  }
});

test("landscape notch insets and the top HUD constrain an expanded map lesson", () => {
  const viewport = bounds(0, 0, 700, 320);
  const topHud = bounds(0, 0, 700, 65), bottomHud = bounds(0, 247, 700, 73);
  const coach = worldCoachLayout(viewport, 260, { topHud, bottomHud, sideInset: 44 });
  assert.ok(coach.left >= 44);
  assert.equal(coach.left, (700 - coach.width) / 2);
  assert.ok(coach.top >= topHud.top + topHud.height + 12);
  assert.ok(coach.top + coach.maxHeight <= bottomHud.top - 20);
  assert.ok(coach.maxHeight > 96, "details can scroll while the action row stays usable");
});

test("a centered lesson moves above an overlapping target without shifting sideways", () => {
  const viewport = bounds(0, 0, 393, 852), highlight = bounds(140, 610, 90, 80);
  const coach = worldCoachLayout(viewport, 118, { bottomHud: bounds(0, 754, 393, 98), highlight });
  assert.equal(coach.left, 12);
  assert.ok(coach.top + 118 <= highlight.top - 14);
});

test("visual viewport offsets are preserved when the keyboard or browser changes the usable viewport", () => {
  const viewport = bounds(15, 20, 320, 568);
  const coach = worldCoachLayout(viewport, 118, { topHud: bounds(15, 20, 320, 78), bottomHud: bounds(15, 490, 320, 98) });
  assert.equal(coach.left, 27);
  assert.ok(coach.top >= 110);
  assert.ok(coach.top + 118 <= 470);
});
