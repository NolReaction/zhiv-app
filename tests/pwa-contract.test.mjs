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

test("keeps the iPhone glass navigation compact and hides mobile scrollbar chrome", async () => {
  const [app, appStyles, peopleStyles, profileStyles] = await Promise.all([
    readFile(new URL("../components/check-in-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/check-in-app.module.css", import.meta.url), "utf8"),
    readFile(new URL("../components/people-view.module.css", import.meta.url), "utf8"),
    readFile(new URL("../components/profile-view.module.css", import.meta.url), "utf8"),
  ]);

  const mobileQuery = "@media (max-width: 700px), (hover: none) and (pointer: coarse)";
  const appMobileStart = appStyles.indexOf(mobileQuery);
  const appMobileEnd = appStyles.indexOf("@supports not", appMobileStart);
  const peopleMobileStart = peopleStyles.indexOf(mobileQuery);
  const profileMobileStart = profileStyles.indexOf(mobileQuery);

  assert.notEqual(appMobileStart, -1);
  assert.notEqual(appMobileEnd, -1);
  assert.notEqual(peopleMobileStart, -1);
  assert.notEqual(profileMobileStart, -1);

  const mobileAppStyles = appStyles.slice(appMobileStart, appMobileEnd);
  const mobilePeopleStyles = peopleStyles.slice(peopleMobileStart);
  const mobileProfileStyles = profileStyles.slice(profileMobileStart);
  const mobileShell = mobileAppStyles.match(/\.shell\s*\{[^}]*\}/s)?.[0] ?? "";
  const mobileFooter = mobileAppStyles.match(/\.footer\s*\{[^}]*\}/s)?.[0] ?? "";
  const mobileBottomNav = mobileAppStyles.match(/\.bottomNav\s*\{[^}]*\}/s)?.[0] ?? "";

  assert.match(app, /data-active-view=\{activeView\}/);
  assert.match(app, /className=\{styles\.navLens\}/);
  assert.equal(
    (app.match(/aria-current=\{activeView === "[^"]+" \? "page" : undefined\}/g) ?? []).length,
    3,
  );

  assert.match(appStyles, /\.shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(appStyles, /\.action\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(peopleStyles, /^\.view\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*thin;/s);
  assert.match(profileStyles, /^\.view\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*thin;/s);

  assert.match(mobileShell, /position:\s*relative;/);
  assert.match(mobileShell, /grid-template-rows:\s*auto minmax\(0, 1fr\);/);

  assert.match(mobileFooter, /position:\s*absolute;/);
  assert.match(mobileFooter, /right:\s*0;/);
  assert.match(mobileFooter, /left:\s*0;/);
  assert.match(mobileFooter, /width:\s*min\(/);
  assert.match(mobileFooter, /safe-area-inset-left/);
  assert.match(mobileFooter, /safe-area-inset-right/);
  assert.match(mobileFooter, /316px/);
  assert.match(mobileFooter, /margin-inline:\s*auto;/);
  assert.match(mobileFooter, /bottom:[^;]*safe-area-inset-bottom[^;]*;/);
  assert.match(mobileFooter, /background:\s*transparent;/);
  assert.match(mobileFooter, /pointer-events:\s*none;/);
  assert.doesNotMatch(mobileFooter, /transform\s*:/);

  assert.match(mobileBottomNav, /width:\s*100%;/);
  assert.match(mobileBottomNav, /overflow:\s*hidden;/);
  const mobileNavShadow = mobileBottomNav.match(/box-shadow:\s*([^;]+);/s)?.[1] ?? "";
  const mobileShadowLayers = mobileNavShadow
    .replace(/rgba?\([^)]*\)/g, "")
    .split(",")
    .map((shadow) => shadow.trim())
    .filter(Boolean);
  assert.ok(mobileShadowLayers.length > 0);
  assert.ok(mobileShadowLayers.every((shadow) => shadow.startsWith("inset ")));
  assert.match(
    mobileBottomNav,
    /-webkit-backdrop-filter:\s*blur\(26px\) saturate\(180%\);/,
  );
  assert.match(mobileBottomNav, /pointer-events:\s*auto;/);
  assert.match(mobileAppStyles, /\.bottomNav\[data-active-view="people"\] \.navLens/);
  assert.match(mobileAppStyles, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(mobileAppStyles, /width:\s*calc\(\(100% - 10px\) \/ 3\);/);
  assert.match(
    mobileAppStyles,
    /\.bottomNav\[data-active-view="profile"\] \.navLens\s*\{[^}]*translate3d\(200%, 0, 0\)/s,
  );
  assert.match(appStyles, /@supports not \(\(-webkit-backdrop-filter:/);

  assert.match(
    mobileAppStyles,
    /\.action\s*\{(?=[^}]*padding-bottom:\s*var\(--floating-nav-clearance\);)(?=[^}]*scroll-padding-bottom:\s*var\(--floating-nav-clearance\);)(?=[^}]*scrollbar-width:\s*none;)[^}]*\}/s,
  );
  assert.match(
    mobileAppStyles,
    /\.action::-webkit-scrollbar\s*\{(?=[^}]*display:\s*none;)(?=[^}]*width:\s*0;)(?=[^}]*height:\s*0;)[^}]*\}/s,
  );
  assert.match(
    mobilePeopleStyles,
    /\.view\s*\{(?=[^}]*padding-bottom:\s*var\(--floating-nav-clearance,\s*110px\);)(?=[^}]*scroll-padding-bottom:\s*var\(--floating-nav-clearance,\s*110px\);)(?=[^}]*scrollbar-width:\s*none;)[^}]*\}/s,
  );
  assert.match(
    mobilePeopleStyles,
    /\.view::-webkit-scrollbar\s*\{(?=[^}]*display:\s*none;)(?=[^}]*width:\s*0;)(?=[^}]*height:\s*0;)[^}]*\}/s,
  );
  assert.match(
    mobileProfileStyles,
    /\.view\s*\{(?=[^}]*padding-bottom:\s*var\(--floating-nav-clearance,\s*110px\);)(?=[^}]*scroll-padding-bottom:\s*var\(--floating-nav-clearance,\s*110px\);)(?=[^}]*scrollbar-width:\s*none;)[^}]*\}/s,
  );
  assert.match(
    mobileProfileStyles,
    /\.view::-webkit-scrollbar\s*\{(?=[^}]*display:\s*none;)(?=[^}]*width:\s*0;)(?=[^}]*height:\s*0;)[^}]*\}/s,
  );
});

test("keeps the thirty-second clicker lightweight and motion-safe", async () => {
  const [app, appStyles, clicker] = await Promise.all([
    readFile(new URL("../components/check-in-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/check-in-app.module.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/clicker-story.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(clicker, /CLICKER_FINAL_TAP|rotateClickerStory/);
  assert.match(clicker, /CLICKER_MAX_TAP_COUNT\s*=\s*100_000/);
  assert.match(clicker, /version:\s*3/);
  assert.match(clicker, /lifetimeTaps/);
  assert.match(clicker, /bestSeries/);
  assert.match(clicker, /activeSeries/);
  assert.doesNotMatch(app, /navigator\.vibrate|AudioContext|new Audio/);
  assert.match(app, /zhiv\.clicker-progress\.v3/);
  assert.match(app, /zhiv\.clicker-progress\.v2/);
  assert.match(app, /zhiv\.clicker-progress\.v1/);
  assert.match(app, /combineLegacyClickerProgress\(legacyV2, legacyV1, storySeed\)/);
  assert.match(app, /localStorage\.setItem\([^,]+,\s*serializeClickerProgress\(/);

  const counterRule = appStyles.match(/\.tapCounter\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(counterRule, /font-variant-numeric:\s*tabular-nums;/);
  assert.match(counterRule, /white-space:\s*nowrap;/);
  assert.match(counterRule, /max-width:/);
  assert.match(counterRule, /pointer-events:\s*none;/);
  assert.match(app, /function TapCounter/);
  assert.match(app, /getClickerSeriesTimer\(progress, nowMs\)/);
  assert.match(app, /className=\{styles\.tapCounterProgress\}/);
  assert.doesNotMatch(app, /Проверяем сервер · тапы уже считаются/);
  assert.ok((app.match(/triggerSeriesBreakEffect\(\);/g) ?? []).length >= 3);

  const timerFill = appStyles.match(/\.tapCounterProgress::after\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(timerFill, /linear-gradient/);
  assert.match(timerFill, /transform:\s*scaleX\(var\(--series-remaining\)\);/);
  assert.match(timerFill, /transform-origin:\s*left center;/);
  assert.doesNotMatch(timerFill, /width:/);
  assert.match(appStyles, /\.tapWave\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(appStyles, /\.seriesBreakBurst\s*\{[^}]*pointer-events:\s*none;/s);

  const reducedMotion = appStyles.slice(
    appStyles.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(reducedMotion, /\.championBurst/);
  assert.match(reducedMotion, /\.tapWave/);
  assert.match(reducedMotion, /\.seriesBreakBurst/);
  assert.match(reducedMotion, /\.tapCounterProgress::after/);
  assert.match(reducedMotion, /display:\s*none;/);
});

test("locks the iPhone app surface while preserving vertical touch scrolling", async () => {
  const [
    layout,
    globals,
    config,
    app,
    appStyles,
    people,
    peopleStyles,
    groups,
    groupStyles,
    profile,
  ] =
    await Promise.all([
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../components/check-in-app.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/check-in-app.module.css", import.meta.url), "utf8"),
      readFile(new URL("../components/people-view.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/people-view.module.css", import.meta.url), "utf8"),
      readFile(new URL("../components/groups-section.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/groups-section.module.css", import.meta.url), "utf8"),
      readFile(new URL("../components/profile-view.tsx", import.meta.url), "utf8"),
    ]);

  assert.match(layout, /minimumScale:\s*1/);
  assert.match(layout, /maximumScale:\s*1/);
  assert.match(layout, /userScalable:\s*false/);
  assert.match(layout, /viewportFit:\s*["']cover["']/);
  assert.match(config, /devIndicators:\s*false/);

  assert.match(globals, /html\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(globals, /body\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(globals, /button\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(appStyles, /\.shell\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(appStyles, /\.action\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(
    appStyles,
    /\.shell\[data-active-view="check-in"\]\s*\{(?=[^}]*position:\s*fixed;)(?=[^}]*height:\s*100svh;)(?=[^}]*overflow:\s*hidden;)(?=[^}]*overscroll-behavior:\s*none;)(?=[^}]*touch-action:\s*none;)[^}]*\}/s,
  );
  assert.match(
    appStyles,
    /\.shell\[data-active-view="check-in"\] \.action\s*\{(?=[^}]*overflow:\s*hidden;)(?=[^}]*touch-action:\s*none;)[^}]*\}/s,
  );
  assert.match(peopleStyles, /\.view\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(groupStyles, /\.dialog\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(groupStyles, /\.peoplePicker\s*\{[^}]*touch-action:\s*pan-y;/s);

  const checkInButton = appStyles.match(/\.checkInButton\s*\{[^}]*\}/s)?.[0] ?? "";
  const checkInLabel = appStyles.match(/\.checkInButton span\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(checkInButton, /-webkit-touch-callout:\s*none;/);
  assert.match(checkInButton, /-webkit-user-select:\s*none;/);
  assert.match(checkInButton, /(?<!-webkit-)user-select:\s*none;/);
  assert.match(checkInLabel, /pointer-events:\s*none;/);
  assert.match(checkInLabel, /-webkit-touch-callout:\s*none;/);
  assert.match(checkInLabel, /-webkit-user-select:\s*none;/);
  assert.match(checkInLabel, /(?<!-webkit-)user-select:\s*none;/);
  assert.match(app, /onPointerDown=\{handleGameAreaPointerDown\}/);
  assert.match(app, /onPointerDown=\{handlePrimaryPointerDown\}/);
  assert.match(app, /if \(!shouldCountGamePointer\(event\.pointerType\)\) return;/);
  assert.match(app, /if \(mainButton\.current\?\.contains\(event\.target as Node\)\) return;/);
  assert.match(
    app,
    /if \(!active \|\| tappedAtMs < active\.lastTapAtMs\s*\|\| tappedAtMs - active\.lastTapAtMs >= CLICKER_IDLE_RESET_MS\) return;/,
  );
  assert.match(app, /lastGameTouchAt\.current = performance\.now\(\);/);
  assert.match(app, /onClick=\{handleGameClick\}/);
  assert.match(app, /shouldCountGameClick\(event\.detail, nowMs, lastGameTouchAt\.current\)/);
  assert.match(
    appStyles,
    /\.shell\[data-active-view="check-in"\] \.streakPill\s*\{[^}]*translateY\(-6px\)/s,
  );

  const checkInFlow = app.slice(
    app.indexOf("async function handleCheckIn"),
    app.indexOf("function handleGameAreaPointerDown"),
  );
  assert.ok(checkInFlow.indexOf("registerTap(1, tappedAtMs)") < checkInFlow.indexOf("await createCheckIn"));

  assert.doesNotMatch(app, /Следующая сцена|Большой рубеж|Сервер ·|Всего отметок/);
  assert.doesNotMatch(app, /Цвет меняется от зелёного к красному/);
  assert.doesNotMatch(app, />\s*подряд\s*</);
  assert.match(app, /formatDayCount\(streak\.currentDays\)/);

  assert.match(app, /<span>Люди<\/span>/);
  assert.doesNotMatch(app, /<span>Свои<\/span>/);
  assert.match(people, /<h1 id="people-title">Личные связи<\/h1>/);
  assert.match(people, /aria-labelledby="people-title"/);
  assert.match(people, /className=\{styles\.sharingSwitch\}/);
  assert.match(people, /Включено · новые отметки доступны/);
  assert.match(people, /Выключено · новые отметки скрыты/);
  assert.match(people, /aria-describedby=\{sharingHintId\}/);
  assert.match(people, /useReducer\(\s*inviteDialogReducer,\s*initialInviteDialogState/);
  assert.match(people, /<Dialog open=\{inviteDialog\.open\}/);
  assert.match(people, /dispatchInviteDialog\(\{ type: "close" \}\)/);
  assert.doesNotMatch(people, /setInviteMode\(null\)/);
  assert.match(people, /inviteShare\.url \? "Скопировать" : "Копировать код"/);
  assert.match(people, /> Поделиться\s*<\/button>/);
  assert.match(people, /const copied = await copyText\(value\);/);
  assert.doesNotMatch(people, /copyTextFromVisibleField/);
  assert.match(people, /aria-label="Принять приглашение по ссылке или коду"/);
  assert.match(people, /parseInviteToken\(inviteImportValue\)/);
  assert.match(people, /window\.setTimeout\(\(\) => \{[\s\S]*window\.dispatchEvent\(new Event\(INVITE_IMPORT_EVENT\)\);[\s\S]*\}, DIALOG_EXIT_MS\);/);
  assert.match(people, /inviteDialog\.mode === "qr" && inviteShare\.url/);
  assert.match(people, /Ссылка и QR с localhost не откроются на другом устройстве/);
  assert.match(people, /aria-label=\{inviteShare\.url \? "Ссылка приглашения" : "Одноразовый код приглашения"\}/);
  assert.match(people, /aria-describedby=\{inviteImportError[\s\S]*\? "invite-import-hint invite-import-error"[\s\S]*: "invite-import-hint"\}/);
  assert.match(people, /aria-invalid=\{Boolean\(inviteImportError\)\}/);
  assert.match(people, /inviteDialog\.mode === "qr" \? styles\.inviteLinkFieldCompact/);
  assert.match(peopleStyles, /\.inviteLinkField\s*\{[^}]*user-select:\s*text;/s);
  assert.match(peopleStyles, /\.sharingSwitch\s*\{[^}]*width:\s*48px !important;/s);
  assert.match(peopleStyles, /\.sharingSwitch :global\(\[data-slot="switch-thumb"\]\)\s*\{[^}]*background:\s*#f4f7ef !important;/s);
  assert.match(peopleStyles, /\.sharingSwitch\[data-state="checked"\] :global\(\[data-slot="switch-thumb"\]\)\s*\{[^}]*translateX\(20px\)/s);
  assert.doesNotMatch(profile, /лучший стрик/i);
  assert.doesNotMatch(profile, /me\.streak\.longestDays/);
  assert.equal((profile.match(/>\s*лучшая серия\s*</gi) ?? []).length, 1);
  assert.equal((people.match(/<h1\b/g) ?? []).length, 1);
  assert.doesNotMatch(people, /styles\.kicker/);
  assert.doesNotMatch(`${app}\n${people}\n${groups}`, />\s*Свои\s*</);
  assert.doesNotMatch(`${app}\n${people}\n${groups}`, /["'`]Свои(?=["'`\s·])/);
});

test("uses a wide desktop dashboard without changing the mobile navigation contract", async () => {
  const [appStyles, peopleStyles, profileStyles] = await Promise.all([
    readFile(new URL("../components/check-in-app.module.css", import.meta.url), "utf8"),
    readFile(new URL("../components/people-view.module.css", import.meta.url), "utf8"),
    readFile(new URL("../components/profile-view.module.css", import.meta.url), "utf8"),
  ]);

  const desktopQuery = "@media (min-width: 960px) and (hover: hover) and (pointer: fine)";
  const desktopApp = appStyles.slice(appStyles.indexOf(desktopQuery));
  const desktopPeople = peopleStyles.slice(peopleStyles.indexOf(desktopQuery));
  const desktopProfile = profileStyles.slice(profileStyles.indexOf(desktopQuery));

  assert.match(desktopApp, /\.shell\s*\{[^}]*width:\s*min\(100%, 1120px\);/s);
  assert.match(desktopPeople, /grid-template-columns:\s*minmax\(260px, 0\.72fr\) minmax\(420px, 1\.28fr\);/);
  assert.match(desktopPeople, /grid-template-columns:\s*minmax\(240px, 1fr\) repeat\(3, 112px\);/);
  assert.match(desktopPeople, /\.tabPanel:not\(\.sections\) > \.sections\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(desktopProfile, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(desktopProfile, /\.recoveryCard\s*\{[^}]*grid-column:\s*1 \/ -1;/s);

  const narrowQuery = "@media (max-width: 360px)";
  const narrowPeople = peopleStyles.slice(peopleStyles.indexOf(narrowQuery));
  assert.match(narrowPeople, /\.quickActions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(narrowPeople, /\.inviteActions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(peopleStyles, /\.dialog,\s*\.confirmDialog\s*\{(?=[^}]*max-height:\s*calc\(100dvh - 24px\);)(?=[^}]*overflow-y:\s*auto;)[^}]*\}/s);
});

test("keeps local development origins out of production Docker builds", async () => {
  const [dockerIgnore, dockerfile] = await Promise.all([
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
    readFile(new URL("../deploy/web.Dockerfile", import.meta.url), "utf8"),
  ]);

  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.match(dockerIgnore, /^\*\*\/\.env\*$/m);
  assert.match(dockerfile, /COPY \. \.[\s\S]*RUN npm run build:vps/);
});

test("bridges an invite from an external iOS browser into the authenticated PWA", async () => {
  const [landing, landingStyles] = await Promise.all([
    readFile(new URL("../components/capability-landing.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-landing.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(landing, /window\.addEventListener\(INVITE_IMPORT_EVENT,\s*handler\)/);
  assert.match(landing, /На этом адресе и в этом браузере активной сессии нет/);
  assert.match(landing, /Вернитесь туда, где профиль уже открыт — в исходную вкладку или приложение с домашнего экрана/);
  assert.match(landing, /copyText\(inviteCode\(pending\)\)/);
  assert.match(landing, /«Люди» → «Принять»/);
  assert.match(landingStyles, /\.inviteCode\s*\{[^}]*user-select:\s*text;/s);
});
