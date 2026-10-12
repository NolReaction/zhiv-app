import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { loadForestSpeechFont } = await vite.ssrLoadModule("/features/world/characters/social/forest-speech-font.ts");

test("both cameras share one Cyrillic font request and its readiness", async () => {
  let resolve, calls = 0;
  const fonts = { load(font, sample) {
    calls++;
    assert.match(font, /"Zhiv Residents"/);
    assert.match(sample, /Плёска/);
    return new Promise(done => { resolve = done; });
  } };
  const circle = loadForestSpeechFont(fonts), map = loadForestSpeechFont(fonts);
  assert.equal(circle, map);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve([{}]);
  assert.equal(await circle, true);
  assert.equal(await loadForestSpeechFont(fonts), true);
  assert.equal(calls, 1);
});

test("font failures and unavailable APIs leave the scene usable and permit a later retry", async () => {
  assert.equal(await loadForestSpeechFont(undefined), false);
  let calls = 0;
  const fonts = { load() {
    calls++;
    if (calls === 1) throw new Error("offline");
    if (calls === 2) return Promise.resolve([]);
    return Promise.resolve([{}]);
  } };
  assert.equal(await loadForestSpeechFont(fonts), false);
  assert.equal(await loadForestSpeechFont(fonts), false);
  assert.equal(await loadForestSpeechFont(fonts), true);
});

test("the speech face is a bundled WOFF2 with its license and a matching CSS declaration", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const declaration = css.match(/@font-face\s*\{[^}]*font-family:\s*"Zhiv Residents"[^}]*\}/)?.[0];
  assert.ok(declaration);
  const path = declaration.match(/url\("(\/fonts\/[^"?]+\.woff2)"\)/)?.[1];
  assert.ok(path, "font stays on the game origin, without a remote CSS dependency");
  const bytes = readFileSync(`${root}/public${path}`);
  assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
  assert.equal(bytes.readUInt32BE(8), bytes.length);
  assert.ok(bytes.length < 100_000);
  assert.match(declaration, /font-display:\s*swap/);
  const license = readFileSync(new URL("../public/fonts/Pangolin-OFL.txt", import.meta.url), "utf8");
  assert.match(license, /The Pangolin Project Authors/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});
