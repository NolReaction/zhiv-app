import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestMemoryCommandSchema, FOREST_MEMORY_BODY_BYTES, FOREST_MEMORY_SNAPSHOT_BYTES } =
  await vite.ssrLoadModule("/features/world/forest-memory-model.ts");
const caddy = await readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
const forestRoute = await readFile(new URL("../apps/api/src/main/kotlin/ru/zhiv/forest/ForestMemoryRoutes.kt", import.meta.url), "utf8");

test("a supported forest snapshot can exceed the ordinary edge limit while staying inside both API caps", () => {
  const snapshot = {
    version: 2, sceneId: "forest", fingerprint: "geometry-v2",
    mind: { elapsed: 100, needs: { energy: .5, curiosity: .5, comfort: .5, attention: .5 }, attentionUntil: 100, recent: [] },
    hero: { position: { x: 100, y: 200 }, sleepingHome: false, awakeFor: 0, restFor: 0, recent: [] },
    mushrooms: Array.from({ length: 128 }, (_, index) => ({ id: `mushroom:${index}`,
      position: { x: 100.1234567890123 + index, y: 200.1234567890123 + index },
      growth: .123456789012345, regrowIn: 12.12345678901234 })),
    garden: { bushes: [], basketBerries: 0 },
  };
  const command = { ownerPublicId: "7K3P-2Q9M-W8ZR", clientId: "f1279baf-bd73-4e17-972e-25b69a1b5dab",
    requestId: "f1279baf-bd73-4e17-972e-25b69a1b5daa", expectedRevision: 1, action: "save", takeover: false,
    leaseToken: "f1279baf-bd73-4e17-972e-25b69a1b5dac", snapshot };
  assert.equal(forestMemoryCommandSchema.safeParse(command).success, true);
  const bytes = Buffer.byteLength(JSON.stringify(command));
  assert.ok(bytes > 16_384, "real supported data must reproduce the former edge rejection");
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= FOREST_MEMORY_SNAPSHOT_BYTES);
  const edgeCap = Number(caddy.match(/request_body @forestMemoryWrite\s*\{\s*max_size (\d+)\s*\}/)?.[1]);
  const apiCap = Number(forestRoute.match(/bodyLimit\s*\{\s*([\d_]+)\s*\}/)?.[1].replaceAll("_", ""));
  assert.equal(edgeCap, FOREST_MEMORY_BODY_BYTES);
  assert.equal(apiCap, FOREST_MEMORY_BODY_BYTES);
  assert.ok(bytes <= edgeCap);
});

test("only the exact forest POST receives the larger cap and every other request retains the smaller budget", () => {
  // These are configuration-contract assertions. Production Compose smoke also
  // sends a large valid save through the actual Caddy adapter and request handler.
  const allowed = caddy.match(/@forestMemoryWrite\s*\{([^{}]+)\}/)?.[1].trim().replace(/\s+/g, " ");
  const complement = caddy.match(/@standardBody\s*\{\s*not\s*\{([^{}]+)\}\s*\}/)?.[1].trim().replace(/\s+/g, " ");
  assert.equal(allowed, "method POST path /api/v1/world/forest-memory/commands");
  assert.equal(complement, allowed, "negate the complete method/path pair, not just one field");
  assert.match(caddy, /request_body @standardBody\s*\{\s*max_size 16KB\s*\}/);
  assert.equal([...caddy.matchAll(/\brequest_body\b/g)].length, 2, "a second catch-all cap would still reject valid saves");
});

const widths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
const imageRequest = (source, width = 640) => {
  const url = new URL("https://example.test/_vinext/image");
  url.search = new URLSearchParams({ url: source, w: String(width), q: "75" });
  return new Request(url);
};

test("the deployed Sites image handler rejects external origins and unbounded sizes before any asset access", async () => {
  let assetReads = 0;
  const handlers = { fetchAsset: async () => { assetReads++; throw new Error("Unexpected asset access"); } };
  for (const source of ["https://attacker.invalid/image.png", "//attacker.invalid/a.png", "/\\attacker.invalid/a.png",
    "\\\\attacker.invalid/a.png", "http://127.0.0.1/", "data:image/png;base64,AA==", "javascript:alert(1)"]) {
    assert.equal((await handleImageOptimization(imageRequest(source), handlers, widths)).status, 400, source);
  }
  for (const width of [65_536, -1, 641]) {
    assert.equal((await handleImageOptimization(imageRequest("/world/test.webp", width), handlers, widths)).status, 400);
  }
  assert.equal(assetReads, 0);
});

test("the Sites image handler rejects active documents but serves raster assets with restrictive headers", async () => {
  let transformed = 0;
  for (const type of ["text/html", "image/svg+xml", "application/javascript"]) {
    const response = await handleImageOptimization(imageRequest("/world/test.webp"), {
      fetchAsset: async () => new Response("<svg onload='alert(1)'/>", { headers: { "Content-Type": type } }),
      transformImage: async () => { transformed++; throw new Error("Unexpected image transformation"); },
    }, widths);
    assert.equal(response.status, 400, type);
  }
  assert.equal(transformed, 0);
  const response = await handleImageOptimization(imageRequest("/world/test.webp"), {
    fetchAsset: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp" } }),
  }, widths);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'none'/);
});
