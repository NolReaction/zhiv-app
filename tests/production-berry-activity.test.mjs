import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ProductionActivity } = await vite.ssrLoadModule("/features/economy/ui/production/production-activity.tsx");
const start = Date.parse("2026-10-14T20:00:00Z");
function crop(itemId, seconds = 60, extra = {}) {
  return { id: "crop", kind: "production", targetId: "garden", recipeId: "grow_berries",
    startedAt: new Date(start).toISOString(), finishesAt: new Date(start + seconds * 1000).toISOString(),
    rewards: { [itemId]: 1 }, ...extra };
}
function render(job, now = start + 30_000) {
  return renderToStaticMarkup(createElement(ProductionActivity, { job, now }));
}

test("every berry slot follows its saved reward with a recognisable fruit silhouette", () => {
  const silhouettes = { berries: "raspberry", strawberries: "strawberry", blueberries: "blueberry",
    currants: "currant", blackberries: "blackberry", cranberries: "cranberry" };
  const pictures = [];
  for (const [itemId, shape] of Object.entries(silhouettes)) {
    // Recipe metadata can differ in a historical receipt: the promised item is authoritative.
    const job = Object.freeze(crop(itemId, 60, { recipeId: "grow_strawberries", rewards: Object.freeze({ [itemId]: 1 }) }));
    const html = render(job, start + 59_000);
    assert.match(html, new RegExp(`data-garden-item="${itemId}"`));
    assert.equal((html.match(new RegExp(`data-fruit-shape="${shape}"`, "g")) ?? []).length, 2);
    assert.match(html, /aria-hidden="true" focusable="false"/);
    pictures.push(html.replace(/data-garden-item="[^"]+"|data-fruit-shape="[^"]+"/g, ""));
    assert.deepEqual(job.rewards, { [itemId]: 1 });
  }
  assert.equal(new Set(pictures).size, 6, "species must differ in actual drawing, not just metadata");
});

test("berry size and colour follow elapsed crop dates and survive reopening without an accelerated loop", () => {
  const job = crop("berries", 3600), before = structuredClone(job);
  const early = render(job, start + 360_000), middle = render(job, start + 1800_000), late = render(job, start + 3564_000);
  assert.match(early, /data-crop-growth="0\.098"/);
  assert.match(early, /fill="rgb\(127,154,73\)"/);
  assert.match(middle, /data-crop-growth="0\.49"/);
  assert.match(late, /data-crop-growth="0\.9702"/);
  assert.notEqual(early, middle); assert.notEqual(middle, late);
  assert.equal(render(job, start + 1800_000), middle, "remounting at the same wall time must keep the same growth");
  assert.equal(render(crop("berries", 60), start + 30_000), middle, "species growth uses the saved duration proportion");
  assert.deepEqual(job, before, "artwork cannot advance or alter the job");
});

test("active garden art stops exactly at the server deadline and never starts for invalid or future work", () => {
  const job = crop("strawberries", 300);
  assert.notEqual(render(job, start + 299_999), "");
  for (const now of [start - 1, start + 300_000, start + 900_000, NaN]) assert.equal(render(job, now), "");
  for (const change of [{ startedAt: "invalid" }, { finishesAt: "invalid" }, { finishesAt: job.startedAt }, { kind: "construction" }])
    assert.equal(render({ ...job, ...change }), "");
});

test("an unknown historical crop stays generic instead of borrowing a newly unlocked berry", () => {
  const html = render(crop("unknown_legacy_crop", 60, { recipeId: "grow_cranberries" }));
  assert.match(html, /data-garden-item="woodlandBerry"/);
  assert.match(html, /data-fruit-shape="woodland"/);
  assert.doesNotMatch(html, /data-garden-item="cranberries"/);
});
