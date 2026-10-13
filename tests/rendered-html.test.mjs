import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renders application metadata and the public site without development tags", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const media = JSON.parse(await readFile(new URL("../public/site/media.json", import.meta.url), "utf8"));

  for (const pathname of ["/", "/site"]) {
    const response = await worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
    const html = await response.text();
    assert.match(html, /<meta(?=[^>]*\bname=["']application-name["'])(?=[^>]*\bcontent=["']Я Живой["'])[^>]*>/i);
    assert.doesNotMatch(html, /name=["']codex-preview["']/i);
    assert.match(html, /rel=["']manifest["']/i);
    assert.doesNotMatch(html, /<link(?=[^>]*rel=["']preload["'])(?=[^>]*href=["'][^"']*forest-ground)/i,
      "installation and presentation must not preload the game's large map");
    if (pathname === "/site") {
      assert.match(html, /Близкие спокойны/);
      assert.match(html, /data-install-panel/);
      assert.ok(html.includes(media.poster.src.replaceAll("&", "&amp;")), "the built page uses the current versioned poster");
      assert.ok(html.includes(media.map.srcSet.replaceAll("&", "&amp;")), "the built page exposes responsive map sources");
      assert.match(html, /<img(?=[^>]*srcset=["'][^"']*2560w)(?=[^>]*sizes=["'][^"']+)[^>]*>/i,
        "high-DPI preview choices survive the production renderer");
      assert.match(html, /Можно просто играть на компьютере/);
      assert.match(html, /Скоро здесь появится видеопрогулка/);
      assert.doesNotMatch(html, /<(?:video|source)\b|\.(?:mp4|webm)\b|as=["']video["']/i,
        "the future film is an inert placeholder, with no hidden movie request");
    } else assert.match(html, /Открываем «Я живой»/);
  }
});
