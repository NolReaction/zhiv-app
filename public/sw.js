const CACHE_PREFIX = "zhiv-shell-";
const META_CACHE_NAME = "zhiv-meta-v1";
const ACTIVE_CACHE_KEY = new URL(
  "/__zhiv_active_shell__",
  self.location.origin,
).href;
const STATIC_SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];
const DOCUMENT_REVISION_HEADERS = [
  "content-type",
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
];

function isVersionedAsset(pathname) {
  return pathname.startsWith("/_next/static/") || pathname.startsWith("/assets/");
}

function extractAssetUrls(html) {
  const urls = [];

  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin && isVersionedAsset(url.pathname)) {
        urls.push(url.href);
      }
    } catch {
      // Ignore malformed, non-app URLs in generated markup.
    }
  }

  return [...new Set(urls)];
}

async function activeCacheName() {
  const metadata = await caches.open(META_CACHE_NAME);
  const response = await metadata.match(ACTIVE_CACHE_KEY);
  if (!response) return null;

  const name = await response.text();
  return name.startsWith(CACHE_PREFIX) ? name : null;
}

async function setActiveCacheName(name) {
  const metadata = await caches.open(META_CACHE_NAME);
  await metadata.put(ACTIVE_CACHE_KEY, new Response(name));
}

async function openActiveCache() {
  const name = await activeCacheName();
  return name ? caches.open(name) : null;
}

async function fetchShellResources(urls) {
  return Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (!response.ok) throw new Error(`Could not precache ${url}`);
      return { url, response };
    }),
  );
}

async function shellRevision(html, documentResponse, staticResources, assetUrls) {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(html)];

  for (const header of DOCUMENT_REVISION_HEADERS) {
    chunks.push(encoder.encode(`\n${header}:${documentResponse.headers.get(header) ?? ""}`));
  }

  for (const { url, response } of staticResources) {
    chunks.push(encoder.encode(`\n${url}\n${response.headers.get("content-type") ?? ""}\n`));
    chunks.push(new Uint8Array(await response.clone().arrayBuffer()));
  }

  for (const url of assetUrls) chunks.push(encoder.encode(`\n${url}`));

  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const input = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function removeInactiveShellCaches(activeName) {
  const keys = await caches.keys();
  await Promise.allSettled(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== activeName)
      .map((key) => caches.delete(key)),
  );
}

async function stageShell(documentResponse, removeOldCaches = false) {
  if (
    !documentResponse.ok ||
    !documentResponse.headers.get("content-type")?.includes("text/html")
  ) {
    throw new Error("Could not cache the app shell");
  }

  const html = await documentResponse.clone().text();
  const staticUrls = STATIC_SHELL.map(
    (path) => new URL(path, self.location.origin).href,
  );
  const assetUrls = extractAssetUrls(html);
  const staticResources = await fetchShellResources(staticUrls);
  const revision = await shellRevision(
    html,
    documentResponse,
    staticResources,
    assetUrls,
  );
  const cacheName = `${CACHE_PREFIX}${revision}`;
  const currentName = await activeCacheName();

  if (cacheName === currentName) return cacheName;

  const assetResources = await fetchShellResources(assetUrls);
  const resources = [...staticResources, ...assetResources];
  const stagingCache = await caches.open(cacheName);
  try {
    await Promise.all(
      resources.map(({ url, response }) => stagingCache.put(url, response)),
    );
    await stagingCache.put("/", documentResponse);
    await setActiveCacheName(cacheName);
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }

  if (removeOldCaches) await removeInactiveShellCaches(cacheName);
  return cacheName;
}

async function precacheShell() {
  const documentResponse = await fetch("/", { cache: "reload" });
  await stageShell(documentResponse);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const currentName = await activeCacheName();
      if (currentName) await removeInactiveShellCaches(currentName);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // A stale check-in is dangerous: identity and API traffic are always network-only.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    const networkResponse = fetch(request);
    if (url.pathname === "/") {
      event.waitUntil(
        networkResponse
          .then((response) =>
            response.ok ? stageShell(response.clone(), true) : undefined,
          )
          .catch(() => undefined),
      );
    }

    event.respondWith(
      networkResponse.catch(async () => {
        const cache = await openActiveCache();
        return (await cache?.match("/")) ?? Response.error();
      }),
    );
    return;
  }

  const cacheableAsset =
    isVersionedAsset(url.pathname) || STATIC_SHELL.includes(url.pathname);
  if (!cacheableAsset) return;

  event.respondWith(
    (async () => {
      const cache = await openActiveCache();
      const cached = await cache?.match(request);
      return cached ?? fetch(request);
    })(),
  );
});
