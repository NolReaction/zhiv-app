import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const origin = "https://zhiv.example";
const activeCacheKey = `${origin}/__zhiv_active_shell__`;
const staticShellUrls = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

function absoluteUrl(request) {
  const value = typeof request === "string" ? request : request.url;
  return new URL(value, origin).href;
}

class MemoryCache {
  constructor(storage) {
    this.storage = storage;
    this.entries = new Map();
  }

  async match(request) {
    return this.entries.get(absoluteUrl(request))?.clone();
  }

  async put(request, response) {
    const key = absoluteUrl(request);
    if (this.storage.failPutForUrl === key) throw new Error(`Failed to cache ${key}`);
    this.entries.set(key, response.clone());
  }
}

class MemoryCacheStorage {
  constructor() {
    this.caches = new Map();
    this.failPutForUrl = null;
  }

  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MemoryCache(this));
    return this.caches.get(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async delete(name) {
    return this.caches.delete(name);
  }
}

async function createServiceWorkerHarness() {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map();
  const responses = new Map();
  const caches = new MemoryCacheStorage();
  const self = {
    location: new URL(origin),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {},
    clients: { async claim() {} },
  };

  const fetch = async (request) => {
    const response = responses.get(absoluteUrl(request));
    if (!response) throw new Error(`Unexpected fetch: ${absoluteUrl(request)}`);
    if (response instanceof Error) throw response;
    return response.clone();
  };

  vm.runInNewContext(source, {
    Array,
    Error,
    Promise,
    Response,
    TextEncoder,
    URL,
    Uint8Array,
    caches,
    crypto: globalThis.crypto,
    fetch,
    self,
  });

  async function dispatchExtendable(type) {
    const pending = [];
    listeners.get(type)({ waitUntil: (promise) => pending.push(Promise.resolve(promise)) });
    await Promise.all(pending);
  }

  async function dispatchFetch(pathname) {
    const pending = [];
    let responsePromise;
    listeners.get("fetch")({
      request: {
        method: "GET",
        mode: "navigate",
        url: new URL(pathname, origin).href,
      },
      respondWith(promise) {
        responsePromise = Promise.resolve(promise);
      },
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    });

    const response = responsePromise ? await responsePromise : null;
    await Promise.all(pending);
    return response;
  }

  async function currentCacheName() {
    const metadata = await caches.open("zhiv-meta-v1");
    const response = await metadata.match(activeCacheKey);
    return response ? response.text() : null;
  }

  return {
    caches,
    currentCacheName,
    dispatchExtendable,
    dispatchFetch,
    responses,
  };
}

function setShellResponses(harness, label) {
  const assetPath = `/assets/app-${label}.js`;
  const html = `<html><head><script src="${assetPath}"></script></head></html>`;
  harness.responses.set(
    `${origin}/`,
    new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
    }),
  );
  harness.responses.set(
    `${origin}${assetPath}`,
    new Response(`console.log(${JSON.stringify(label)})`, {
      headers: { "Content-Type": "application/javascript" },
    }),
  );
  harness.responses.set(
    `${origin}/manifest.webmanifest`,
    new Response(`{"name":"${label}"}`, {
      headers: { "Content-Type": "application/manifest+json" },
    }),
  );
  harness.responses.set(
    `${origin}/icon.svg`,
    new Response(`<svg data-build="${label}"></svg>`, {
      headers: { "Content-Type": "image/svg+xml" },
    }),
  );
  for (const size of [192, 512]) {
    harness.responses.set(
      `${origin}/icon-${size}.png`,
      new Response(`png-${size}-${label}`, { headers: { "Content-Type": "image/png" } }),
    );
  }
  return { assetPath, html };
}

test("keeps identity and check-ins out of the offline cache", async () => {
  const serviceWorker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)\) return/);
  assert.match(serviceWorker, /cache\?\.match\(request\)/);
  assert.doesNotMatch(serviceWorker, /caches\.match\(request\)/);
  assert.match(serviceWorker, /key\.startsWith\(CACHE_PREFIX\)/);
});

test("stages a build-specific shell before switching the active cache", async () => {
  const harness = await createServiceWorkerHarness();
  const first = setShellResponses(harness, "a");

  await harness.dispatchExtendable("install");

  const firstCacheName = await harness.currentCacheName();
  assert.match(firstCacheName, /^zhiv-shell-[0-9a-f]{24}$/);
  const firstCache = await harness.caches.open(firstCacheName);
  assert.equal(await (await firstCache.match("/")).text(), first.html);
  assert.ok(await firstCache.match(`${origin}${first.assetPath}`));
  for (const pathname of staticShellUrls) {
    assert.ok(await firstCache.match(`${origin}${pathname}`));
  }

  const second = setShellResponses(harness, "b");
  harness.caches.failPutForUrl = `${origin}${second.assetPath}`;
  await harness.dispatchFetch("/");

  assert.equal(await harness.currentCacheName(), firstCacheName);
  assert.equal(await (await firstCache.match("/")).text(), first.html);
  assert.deepEqual(
    (await harness.caches.keys()).filter((key) => key.startsWith("zhiv-shell-")),
    [firstCacheName],
  );

  harness.caches.failPutForUrl = null;
  await harness.dispatchFetch("/");

  const secondCacheName = await harness.currentCacheName();
  assert.match(secondCacheName, /^zhiv-shell-[0-9a-f]{24}$/);
  assert.notEqual(secondCacheName, firstCacheName);
  const secondCache = await harness.caches.open(secondCacheName);
  assert.equal(await (await secondCache.match("/")).text(), second.html);
  assert.ok(await secondCache.match(`${origin}${second.assetPath}`));
});

test("does not replace the root shell after a non-root navigation", async () => {
  const harness = await createServiceWorkerHarness();
  const shell = setShellResponses(harness, "root");
  await harness.dispatchExtendable("install");
  const cacheName = await harness.currentCacheName();

  const response = await harness.dispatchFetch("/manifest.webmanifest");

  assert.equal(response.headers.get("content-type"), "application/manifest+json");
  assert.equal(await harness.currentCacheName(), cacheName);
  const cache = await harness.caches.open(cacheName);
  assert.equal(await (await cache.match("/")).text(), shell.html);
});

test("ships installable PNG icons for iOS and Android", async () => {
  const manifest = await readFile(new URL("../app/manifest.ts", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(manifest, /icon-192\.png/);
  assert.match(manifest, /icon-512\.png/);
  assert.match(layout, /apple-touch-icon\.png/);
  assert.match(manifest, /name:\s*["']Я живой["']/);
  assert.match(layout, /title:\s*["']Я живой["']/);
});

test("applies clickjacking protection to the root page and nested routes", async () => {
  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");

  assert.match(config, /source:\s*["']\/["']/);
  assert.match(config, /source:\s*["']\/:path\*["']/);
  assert.match(config, /X-Frame-Options["'],\s*value:\s*["']DENY/);
  assert.match(config, /frame-ancestors 'none'/);
});

test("keeps primary navigation visible while long people lists scroll", async () => {
  const appStyles = await readFile(
    new URL("../components/check-in-app.module.css", import.meta.url),
    "utf8",
  );
  const peopleStyles = await readFile(
    new URL("../components/people-view.module.css", import.meta.url),
    "utf8",
  );

  assert.match(appStyles, /\.shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(appStyles, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(peopleStyles, /\.view\s*\{[^}]*overflow-y:\s*auto;/s);
});
