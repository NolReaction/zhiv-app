import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { NEXT_DEV_WARMUP_API_PATHS, NEXT_DEV_WARMUP_PAGES, nextDevReadyListener,
  nextDevWarmupOrigin, warmNextDev } from "../scripts/lib/next-dev-warmup.mjs";

test("startup follows its own child's announced fallback port, not the requested occupied port", () => {
  const ready = [];
  const observe = nextDevReadyListener(["--hostname", "0.0.0.0", "--port", "3000"], origin => ready.push(origin));
  observe("Port 3000 is in use, trying 3001 instead.\n- Local: http://localhost:");
  observe("3001\n- Network: http://0.0.0.0:3001\n");
  assert.deepEqual(ready, [], "never warm an existing process before the spawned child is ready");
  observe("\x1b[32m✓ Ready");
  observe(" in 1000ms\x1b[0m\n");
  observe("✓ Ready in 2000ms\n");
  assert.deepEqual(ready, ["http://127.0.0.1:3001"]);
  assert.equal(nextDevWarmupOrigin("- Local: http://localhost:4000\n", ["--hostname=::"]), "http://[::1]:4000");
  assert.equal(nextDevWarmupOrigin("- Local: http://localhost:4000\n", ["-H", "192.168.1.20"]), "http://192.168.1.20:4000");
  assert.equal(nextDevWarmupOrigin("Ready in 100ms\n"), null);
});

test("warmup never runs account handlers or sends a cookie/body and renders UI after API compilation", async t => {
  const calls = [], messages = [];
  let mutated = 0, active = 0, peak = 0;
  const server = createServer((request, response) => {
    const body = [];
    request.on("data", chunk => body.push(chunk));
    request.on("end", () => {
      calls.push({ path: request.url, method: request.method, cookie: request.headers.cookie, body: Buffer.concat(body).toString() });
      if (request.url.startsWith("/api/") && request.method !== "OPTIONS") mutated++;
      peak = Math.max(peak, ++active);
      setTimeout(() => { active--; response.writeHead(request.method === "OPTIONS" ? 204 : 200); response.end(); }, 5);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await warmNextDev({ origin, log: message => messages.push(message) }), { ready: true, failures: [] });
  assert.equal(mutated, 0);
  assert.equal(peak, 2, "limit concurrent compilation requests");
  assert.ok(calls.every(call => call.cookie === undefined && call.body === ""));
  assert.deepEqual(calls.slice(0, NEXT_DEV_WARMUP_API_PATHS.length).map(call => call.method), NEXT_DEV_WARMUP_API_PATHS.map(() => "OPTIONS"));
  assert.deepEqual(calls.slice(NEXT_DEV_WARMUP_API_PATHS.length).map(call => [call.path, call.method]), NEXT_DEV_WARMUP_PAGES.map(path => [path, "GET"]));
  assert.match(messages.at(-1), /Готово для игры/);
});

test("core routes rely on Next's automatic OPTIONS rather than a custom handler", async () => {
  for (const path of NEXT_DEV_WARMUP_API_PATHS) {
    const source = await readFile(new URL(`../app${path}/route.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /export\s+(?:(?:async\s+)?function\s+OPTIONS|(?:const|let|var)\s+OPTIONS|\{[^}]*\bOPTIONS\b)/,
      `${path}: a custom OPTIONS implementation requires a warmup safety review`);
  }
});

test("an unavailable route or redirect never claims full readiness and does not prevent remaining routes", async () => {
  const messages = [], methods = [];
  const result = await warmNextDev({ origin: "http://localhost:4321", apiPaths: ["/api/failure", "/api/redirect"], pages: ["/"],
    log: message => messages.push(message), fetchRequest: async (_url, options) => {
      methods.push(options.method);
      if (_url.pathname === "/api/failure") throw new Error("Connection closed");
      return new Response(null, { status: _url.pathname === "/api/redirect" ? 307 : 200 });
    } });
  assert.equal(result.ready, false);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(methods, ["OPTIONS", "OPTIONS", "GET"]);
  assert.doesNotMatch(messages.join("\n").split("\n").at(-1), /^\[DEV\] Готово для игры:/);
});

test("stopping Next cancels outstanding warmup and does not print readiness", async () => {
  const controller = new AbortController(), messages = [];
  const task = warmNextDev({ origin: "http://localhost:4321", signal: controller.signal, apiPaths: ["/api/slow"], pages: ["/"],
    log: message => messages.push(message), fetchRequest: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  assert.ok(!messages.some(message => message.startsWith("[DEV] Готово для игры:")));
});
