const CACHE_PREFIX = "zhiv-shell-";
// Content-versioned public files survive shell updates, including lazy game chunks.
const ASSET_CACHE_NAME = "zhiv-assets-v1";
const ASSET_CACHE_LIMIT = 96;
const ASSET_REQUEST_TIMEOUT_MS = 60_000;
const assetRequests = new Map();
const META_CACHE_NAME = "zhiv-meta-v1";
const ACTIVE_CACHE_KEY = new URL(
  "/__zhiv_active_shell__",
  self.location.origin,
).href;
const STATIC_SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
];
const DOCUMENT_REVISION_HEADERS = [
  "content-type",
  "content-security-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options",
  "x-frame-options",
];

function isVersionedAsset(url) {
  const { pathname, search } = url;
  return pathname.startsWith("/_next/static/") || pathname.startsWith("/assets/")
    || (/^\/brand\/[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\.webp$/.test(pathname)
      || /^\/(?:icon-(?:32|192|512|maskable-512)\.png|apple-touch-icon\.png|favicon\.ico)$/.test(pathname)) && /^\?v=[a-f0-9]{12}$/.test(search)
    || /^\/world\/runtime\/[a-zA-Z]+(?:-[a-zA-Z]+)*-[a-f0-9]{12}\.webp$/.test(pathname)
    || (/^\/world\/prototype\/[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*\.(?:webp|png)$/.test(pathname)
      || pathname === "/world/runtime/boat-wreck-lowquality.webp") && /^\?v=[a-f0-9]{12}$/.test(search);
}

function canCacheAsset(url, response) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  return response.ok && !/(?:^|,)\s*(?:no-store|private|no-cache|must-revalidate)\b/i.test(cacheControl)
    && !response.headers.get("content-type")?.includes("text/html")
    // Next dev URLs are mutable; their names alone do not identify a build.
    && (!url.pathname.startsWith("/_next/static/") || /(?:^|,)\s*immutable\b/i.test(cacheControl));
}

async function readCachedAsset(cache, request) {
  const cached = await cache?.match(request).catch(() => null);
  if (!cached) return null;
  const url = new URL(typeof request === "string" ? request : request.url, self.location.origin);
  if (canCacheAsset(url, cached)) return cached;
  // Older workers may have saved mutable chunks. Do not replay those entries.
  await cache?.delete(request).catch(() => undefined);
  return null;
}

async function drainAssetBody(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  try { while (!(await reader.read()).done) { /* Discard chunks without buffering the whole asset. */ } }
  finally { reader.releaseLock(); }
}

async function cachedAsset(request, keepAlive) {
  // Storage eviction, private browsing and full disks must not block the network.
  const cache = await caches.open(ASSET_CACHE_NAME).catch(() => null);
  const cached = await readCachedAsset(cache, request);
  if (cached) return cached;
  const key = request.url;
  if (!assetRequests.has(key)) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Asset download timed out"));
      }, ASSET_REQUEST_TIMEOUT_MS);
    });
    const response = Promise.race([fetch(request, { signal: controller.signal }), deadline]);
    const stored = response.then(async response => {
      let saved = false;
      if (cache && canCacheAsset(new URL(request.url), response)) {
        try {
          await cache.put(request, response.clone()); saved = true;
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - ASSET_CACHE_LIMIT)).map(key => cache.delete(key)));
        } catch { /* A successful image/module remains usable without persistent storage. */ }
      }
      // A quota failure must not clear the network deadline while its body is
      // still downloading. Drain one stream branch without accumulating bytes.
      if (!saved) await drainAssetBody(response);
    });
    // Return the network stream immediately. Slow storage/body downloads must
    // not delay its first byte or leave later retries sharing a stuck request.
    const finished = Promise.race([stored, deadline]);
    const operation = { response, finished };
    assetRequests.set(key, operation);
    void finished.finally(() => {
      clearTimeout(timer);
      if (assetRequests.get(key) === operation) assetRequests.delete(key);
    }).catch(() => undefined);
  }
  const operation = assetRequests.get(key);
  keepAlive(operation.finished.catch(() => undefined));
  return (await operation.response).clone();
}

function extractAssetUrls(html) {
  const urls = [];

  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin && isVersionedAsset(url)) {
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
      if (!canCacheAsset(new URL(url), response)) throw new Error(`Could not precache ${url}`);
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

  if (cacheName === currentName) {
    const currentCache = await caches.open(cacheName);
    const currentAssets = await Promise.all(assetUrls.map((url) => readCachedAsset(currentCache, url)));
    if (currentAssets.every(Boolean)) return cacheName;
  }

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
    if (cacheName !== currentName) await caches.delete(cacheName);
    throw error;
  }

  if (removeOldCaches) await removeInactiveShellCaches(cacheName);
  return cacheName;
}

async function precacheShell() {
  const documentResponse = await fetch("/", { cache: "reload" });
  await stageShell(documentResponse);
}

let shellUpdates = Promise.resolve();
function updateShell(operation) {
  // Warmup and navigation must not delete each other's incomplete staging cache.
  const update = shellUpdates.then(operation);
  shellUpdates = update.catch(() => undefined);
  return update;
}

self.addEventListener("install", (event) => {
  // Push needs an active worker even when offline storage or a shell resource
  // is unavailable. Optional precaching must never hold up installation.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

let shellWarmup = null;
self.addEventListener("message", (event) => {
  if (event.data?.type !== "zhiv:cache-shell") return;
  // The page sends this after ready; a slow fetch/quota failure can affect
  // offline availability, but not worker activation or notification setup.
  // Duplicate tabs share this optional warmup instead of staging in parallel.
  if (!shellWarmup) {
    shellWarmup = updateShell(async () => {
      await precacheShell();
      const currentName = await activeCacheName();
      if (currentName) await removeInactiveShellCaches(currentName);
    }).catch(() => undefined).finally(() => { shellWarmup = null; });
  }
  event.waitUntil(shellWarmup);
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // A stale check-in is dangerous: identity and API traffic are always network-only.
  if (url.pathname.startsWith("/api/") || url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname === "/app-status.json") return;

  if (request.mode === "navigate") {
    const networkResponse = fetch(request);
    if (url.pathname === "/") {
      event.waitUntil(
        networkResponse
          .then((response) => {
            if (!response.ok) return;
            // Clone before queueing: the page can consume the response meanwhile.
            const candidate = response.clone();
            return updateShell(() => stageShell(candidate, true));
          })
          .catch(() => undefined),
      );
    }

    event.respondWith(
      networkResponse.catch(async () => {
        // Public product pages must never turn into the game at the wrong URL.
        if (url.pathname !== "/") return Response.error();
        const cache = await openActiveCache();
        return (await cache?.match("/")) ?? Response.error();
      }),
    );
    return;
  }

  const cacheableAsset =
    isVersionedAsset(url) || STATIC_SHELL.includes(url.pathname);
  if (!cacheableAsset) return;

  const pending = [];
  const response = (async () => {
    const cache = await openActiveCache().catch(() => null);
    const cached = await readCachedAsset(cache, request);
    return cached ?? (isVersionedAsset(url) ? cachedAsset(request, promise => pending.push(promise)) : fetch(request));
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => Promise.all(pending)).catch(() => undefined));
});

// Push data never contains executable commands or arbitrary navigation targets.
function notificationUrl(value, expectedOwner) {
  if (typeof value !== "string" || typeof expectedOwner !== "string" || !expectedOwner || expectedOwner.length > 128) return null;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== "/" || url.searchParams.get("owner") !== expectedOwner) return null;
    const notification = url.searchParams.get("notification");
    const section = url.searchParams.get("section");
    if (notification !== "checkin" && !(notification === "world" && ["activities", "production", "construction"].includes(section))) return null;
    const safe = new URL("/", self.location.origin);
    safe.searchParams.set("notification", notification);
    safe.searchParams.set("owner", expectedOwner);
    if (notification === "world") safe.searchParams.set("section", section);
    return safe.href;
  } catch { return null; }
}

self.addEventListener("push", event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload !== "object" || typeof payload.title !== "string" || !payload.title.trim()
    || payload.title.length > 120 || typeof payload.body !== "string" || payload.body.length > 500
    || typeof payload.tag !== "string" || !payload.tag || payload.tag.length > 128) return;
  const url = notificationUrl(payload.url, payload.ownerPublicId);
  if (!url) return;
  // Older API instances can still send a brand-only title during rollout.
  // The platform already identifies the app; keep all event details in the body.
  const title = /^(?:я\s+живой|мохлик)$/i.test(payload.title.trim()) ? "Новости полянки" : payload.title;
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body, tag: payload.tag, icon: "/icon-192.png", badge: "/icon-32.png",
    renotify: false, requireInteraction: false,
    data: { url, ownerPublicId: payload.ownerPublicId },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = notificationUrl(event.notification.data?.url, event.notification.data?.ownerPublicId);
  if (!url) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => {
      try { const candidate = new URL(client.url); return candidate.origin === self.location.origin && candidate.pathname === "/"; }
      catch { return false; }
    });
    if (existing) {
      try {
        await existing.focus();
        existing.postMessage({ type: "zhiv:notification-open", url });
        return;
      } catch { /* A closed client can disappear between matchAll and focus. */ }
    }
    await self.clients.openWindow(url);
  })());
});
