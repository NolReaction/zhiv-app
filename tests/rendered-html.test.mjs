import assert from "node:assert/strict";
import test from "node:test";

test("renders application metadata and the public site without development tags", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

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
    assert.match(html, /<meta(?=[^>]*\bname=["']application-name["'])(?=[^>]*\bcontent=["']Я живой["'])[^>]*>/i);
    assert.doesNotMatch(html, /name=["']codex-preview["']/i);
    assert.match(html, /rel=["']manifest["']/i);
    assert.doesNotMatch(html, /<link(?=[^>]*rel=["']preload["'])(?=[^>]*href=["'][^"']*forest-ground)/i,
      "installation and presentation must not preload the game's large map");
    if (pathname === "/site") {
      assert.match(html, /Близкие спокойны/);
      assert.match(html, /data-install-panel/);
      assert.match(html, /src=["']\/site\/poster.webp["']/);
      assert.doesNotMatch(html, /<video\b/i, "the movie is requested only by a click");
    } else assert.match(html, /Открываем «Я живой»/);
  }
});
