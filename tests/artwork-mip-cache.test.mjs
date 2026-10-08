import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createArtworkMipCache } = await vite.ssrLoadModule("/features/world/scene/artwork-mip-cache.ts");

function fixture(action) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), draws = [];
  globalThis.document = { createElement() {
    const canvas = { width: 0, height: 0 }, ctx = { drawImage(...args) { draws.push({ args, quality: this.imageSmoothingQuality }); } };
    canvas.getContext = () => ctx; return canvas;
  } };
  try { action(draws); }
  finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
}
const geometry = (width, height = width) => ({ bounds: { x: 0, y: 0, width, height } });
const context = (scale = 1, e = 0) => ({ getTransform: () => ({ a: scale, b: 0, c: 0, d: scale, e, f: 0 }) });

test("high-quality thumbnails are shared across pan frames and never undersample either screen dimension", () => fixture(draws => {
  const cache = createArtworkMipCache(), source = { naturalWidth: 1024, naturalHeight: 512 }, bounds = geometry(130, 80);
  const thumbnail = cache.image(context(), bounds, source);
  assert.equal(thumbnail.width, 256); assert.equal(thumbnail.height, 128);
  assert.ok(thumbnail.width >= 130 && thumbnail.height >= 80);
  for (let pan = 0; pan < 100; pan++) assert.equal(cache.image(context(1, pan), bounds, source), thumbnail);
  assert.equal(draws.length, 1); assert.equal(draws[0].quality, "high");
  const zoomed = cache.image(context(2), bounds, source);
  assert.equal(zoomed.width, 512); assert.equal(zoomed.height, 256);
  assert.equal(cache.image(context(4), bounds, source), source, "close zoom returns full-resolution artwork");
}));

test("rotated artwork uses both physical image axes, independently of camera translation", () => fixture(() => {
  const cache = createArtworkMipCache(), source = { width: 1024, height: 512 };
  const site = { bounds: { x: 0, y: 0, width: 50, height: 100 }, imagePlacement: { x: 0, y: 0, width: 100, height: 50, rotation: 90 } };
  const ctx = { getTransform: () => ({ a: 3, b: 0, c: 0, d: 1, e: 40, f: 80 }) };
  const thumbnail = cache.image(ctx, site, source);
  assert.equal(thumbnail.width, 512); assert.equal(thumbnail.height, 256, "50px axis becomes 150 physical pixels after rotation");
}));

test("cache memory is bounded and least recently used images are regenerated without evicting a hot item", () => fixture(draws => {
  const cache = createArtworkMipCache(16 * 1024), bounds = geometry(20);
  const sources = Array.from({ length: 6 }, () => ({ naturalWidth: 512, naturalHeight: 512 }));
  const first = cache.image(context(), bounds, sources[0]);
  for (const source of sources.slice(1, 4)) cache.image(context(), bounds, source);
  assert.equal(cache.retainedBytes, 16 * 1024);
  assert.equal(cache.image(context(), bounds, sources[0]), first);
  cache.image(context(), bounds, sources[4]);
  assert.equal(cache.retainedBytes, 16 * 1024);
  assert.equal(cache.image(context(), bounds, sources[0]), first);
  const before = draws.length;
  cache.image(context(), bounds, sources[1]);
  assert.equal(draws.length, before + 1, "the oldest cold item was evicted");
  assert.equal(cache.image(context(), geometry(80), sources[5]), sources[5], "an oversized entry cannot repeatedly flush small textures");
  cache.clear(); assert.equal(cache.retainedBytes, 0);
}));

test("source dimensions and source identity invalidate cached artwork; unavailable dimensions remain drawable", () => fixture(draws => {
  const cache = createArtworkMipCache(), bounds = geometry(70), source = { width: 512, height: 512 };
  const first = cache.image(context(), bounds, source);
  source.width = 1024; source.height = 512;
  const resized = cache.image(context(), bounds, source);
  assert.notEqual(resized, first); assert.equal(resized.width, 256); assert.equal(resized.height, 128);
  assert.equal(cache.retainedBytes, 256 * 128 * 4, "old dimensions release their retained levels");
  assert.notEqual(cache.image(context(), bounds, { ...source }), resized);
  const empty = { naturalWidth: 0, naturalHeight: 0 };
  assert.equal(cache.image(context(), bounds, empty), empty);
  assert.equal(cache.image({}, bounds, source), source);
  assert.equal(draws.length, 3);
}));
