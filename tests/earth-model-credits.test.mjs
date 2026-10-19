import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthModelCredits } = await vite.ssrLoadModule("/features/earth/earth-model-credits.tsx");
const { EARTH_MODEL_CREDITS } = await vite.ssrLoadModule("/features/earth/model-credits.ts");

test("model credit retains the supplied asset's title, author, source and license", async () => {
  const source = await readFile(new URL("../art/earth/models/eiffel-tower/source.glb", import.meta.url));
  assert.equal(source.toString("ascii", 0, 4), "glTF");
  const jsonLength = source.readUInt32LE(12);
  const original = JSON.parse(source.toString("utf8", 20, 20 + jsonLength)).asset.extras;
  const model = EARTH_MODEL_CREDITS[0];
  assert.equal(model.title, original.title);
  assert.equal(model.sourceUrl, original.source);
  assert.ok(original.author.includes(model.author));
  assert.ok(original.author.includes(model.authorUrl));
  assert.match(original.license, /CC-BY-4\.0/);
  const html = renderToStaticMarkup(EarthModelCredits());
  for (const value of [model.title, model.author, model.sourceUrl, model.authorUrl, model.licenseUrl, model.changes]) {
    assert.ok(html.includes(value), value);
  }
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3);
});

test("the visible map-credit link leads to a retained attribution and modification notice", async () => {
  const credits = await readFile(new URL("../public/earth/models/CREDITS.txt", import.meta.url), "utf8");
  const model = EARTH_MODEL_CREDITS[0];
  for (const value of [model.title, model.author, model.sourceUrl, model.authorUrl, model.licenseUrl]) assert.ok(credits.includes(value));
  assert.match(credits, /Changes for this application/);
});
