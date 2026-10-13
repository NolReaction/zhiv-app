import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Children, createElement, isValidElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import ts from "typescript";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const page = await vite.ssrLoadModule("/app/site/page.tsx");
const { PwaInstallProvider } = await vite.ssrLoadModule("/features/pwa/install-provider.tsx");
const installPlatform = await vite.ssrLoadModule("/features/pwa/install-platform.ts");
const { INITIAL_INSTALL_SNAPSHOT } = await vite.ssrLoadModule("/features/pwa/install-controller.ts");
const { default: manifest } = await vite.ssrLoadModule("/app/manifest.ts");
const media = JSON.parse(await readFile(path.join(root, "public/site/media.json"), "utf8"));
const demoSource = await readFile(path.join(root, "features/site/site-demos.tsx"), "utf8");
const demoCode = ts.transpileModule(demoSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const renderPage = () => renderToStaticMarkup(createElement(PwaInstallProvider, null, createElement(page.default)));
const productSource = await readFile(path.join(root, "features/site/product-site.tsx"), "utf8");
const productCode = ts.transpileModule(productSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function elements(tree) {
  const result = [];
  function visit(node) {
    if (!isValidElement(node)) return;
    result.push(node);
    Children.forEach(node.props.children, visit);
  }
  visit(tree);
  return result;
}

// Execute the real components and handlers. Only React's hook scheduling and
// browser scheduling is replaced; no production behavior is copied.
function demoHarness(name, environment = {}) {
  const slots = [], pending = [], cleanups = new Map();
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useEffect(callback, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        slots[index] = dependencies;
        pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, callback()); });
      }
    },
  };
  const context = {
    exports: {}, ...environment,
    fetch() { assert.fail("public demos must never call an API"); },
    require(id) {
      if (id === "react") return hooks;
      if (id === "react/jsx-runtime") return jsxRuntime;
      if (id === "lucide-react") return new Proxy({}, { get: (_, icon) => props => createElement("svg", { ...props, "data-icon": icon }) });
      if (id === "next/link") return { default: ({ prefetch, ...props }) => { assert.equal(prefetch, false); return createElement("a", props); } };
      if (id === "@/public/site/media.json") return { default: media };
      if (id.endsWith(".module.css")) return new Proxy({}, { get: (_, key) => key });
      assert.fail(`Unexpected demo dependency: ${id}`);
    },
  };
  vm.runInNewContext(demoCode, context, { filename: "site-demos.tsx" });
  return {
    render(props = {}) {
      cursor = 0;
      const tree = context.exports[name](props), nodes = elements(tree);
      while (pending.length) pending.shift()();
      return { nodes, html: renderToStaticMarkup(tree) };
    },
    unmount() { for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear(); },
  };
}

function productHarness() {
  const motion = { motionEnabled: true, reducedMotion: false };
  const installation = { ...INITIAL_INSTALL_SNAPSHOT };
  let toggles = 0;
  function WorldDemo() { return null; }
  const context = { exports: {}, require(id) {
    if (id === "react") return { useRef: initial => ({ current: initial }) };
    if (id === "react/jsx-runtime") return jsxRuntime;
    if (id === "lucide-react") return new Proxy({}, { get: (_, icon) => props => createElement("svg", { ...props, "data-icon": icon }) });
    if (id === "next/link") return { default: ({ prefetch, ...props }) => { assert.equal(prefetch, false, "the presentation must not prefetch the game"); return createElement("a", props); } };
    if (id === "@/lib/brand-assets") return { BRAND_LOGO_SRC: "/brand/logo.png" };
    if (id === "@/features/pwa/install-panel") return { InstallPanel: () => null };
    if (id === "@/features/pwa/install-provider") return { usePwaInstall: () => installation };
    if (id === "@/features/pwa/install-platform") return installPlatform;
    if (id === "@/public/site/media.json") return { default: media };
    if (id === "./forest-atmosphere") return { ForestAtmosphere: () => null };
    if (id === "./use-site-motion") return { useSiteMotion: () => ({ ...motion, toggleMotion: () => { toggles++; } }) };
    if (id === "./site-demos") return { SiteCheckInDemo: () => null, SiteWorldDemo: WorldDemo, SiteVideoPlaceholder: () => null };
    if (id.endsWith(".module.css")) return new Proxy({}, { get: (_, key) => key });
    assert.fail(`Unexpected product dependency: ${id}`);
  } };
  vm.runInNewContext(productCode, context, { filename: "product-site.tsx" });
  return { motion, installation, WorldDemo, toggles: () => toggles,
    render() { const tree = context.exports.ProductSite(); return { nodes: elements(tree), html: renderToStaticMarkup(tree) }; },
  };
}

function button(view, text) {
  const result = view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes(text));
  assert.ok(result, `Missing button: ${text}`);
  return result;
}

function localAsset(url) {
  const pathname = new URL(url, "https://im-alive.ru").pathname;
  return path.join(root, "public", pathname);
}

test("public page server-renders its story, demos, installation entry and every navigation target", t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => { requests.push(url); throw new Error("unexpected public-page request"); });
  const html = renderPage();
  assert.match(html, /<h1[^>]*id="site-title"/);
  for (const id of ["about", "world", "install", "questions"]) assert.match(html, new RegExp(`<section[^>]*id="${id}"`));
  for (const content of ["Близкие спокойны", "Попробуй · демонстрация", "Интерактивное знакомство", "Скоро здесь появится видеопрогулка", "Что такое PWA?", "Прогресс привязан к аккаунту"]) {
    assert.ok(html.includes(content), `SSR is missing: ${content}`);
  }
  assert.match(html, /data-install-panel/);
  assert.match(html, /data-install-pending/, "the server does not guess a visitor's browser before capability detection");
  assert.doesNotMatch(html, /data-install-guide/, "device-specific steps are selected after hydration");
  const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /<(?:select|option)\b/, "browser correction is not an upfront catalogue of installation choices");
  assert.match(html, /<details(?=[^>]*data-install-correction)(?![^>]*\bopen(?:=|\s|>))[^>]*>/,
    "manual browser correction remains discoverable inside native closed details");
  assert.match(html, /<a href="\/"[^>]*>Перейти к приложению/);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `Broken in-page link: #${target}`);
  assert.deepEqual(requests, []);
});

test("the public page honestly reserves a future film without mounting or requesting a movie", () => {
  const html = renderPage();
  assert.doesNotMatch(html, /<(?:video|source)\b|\.(?:mp4|webm)\b|\bautoplay\b|\bas="video"/i);
  assert.match(html, /Скоро здесь появится видеопрогулка/);
  assert.doesNotMatch(html, /Смотреть прогулку|Без звука\. Запускается только по нажатию/);
});

test("check-in demonstration can be tried and reset without sending a real check-in", () => {
  const demo = demoHarness("SiteCheckInDemo");
  let view = demo.render();
  assert.match(view.html, /Это пример\. Отметка никому не отправляется/);
  assert.equal(button(view, "Я живой").props["aria-pressed"], false);
  button(view, "Я живой").props.onClick();
  view = demo.render();
  assert.equal(button(view, "Я здесь").props["aria-pressed"], true);
  assert.match(view.html, /Мама видит: всё хорошо/);
  assert.match(view.html, /role="status"/);
  button(view, "Попробовать ещё раз").props.onClick();
  view = demo.render();
  assert.equal(button(view, "Я живой").props["aria-pressed"], false);
  assert.doesNotMatch(view.html, /Мама видит: всё хорошо/);
  demo.unmount();
});

test("world preview switches places and night art through real controls without starting the game", () => {
  const demo = demoHarness("SiteWorldDemo");
  let view = demo.render();
  assert.match(view.html, /Обживай свой дом/);
  assert.doesNotMatch(view.html, /map-night\.webp/);
  for (const [name, text] of [["Мастерская", "Создавай понемногу"], ["Плёска", "Заглядывай к соседям"], ["Дом", "Обживай свой дом"]]) {
    const control = view.nodes.find(node => node.props["aria-label"] === `Узнать: ${name}`);
    assert.ok(control); control.props.onClick(); view = demo.render();
    assert.match(view.html, new RegExp(text));
    assert.equal(view.nodes.find(node => node.props["aria-label"] === `Узнать: ${name}`).props["aria-pressed"], true);
  }
  view.nodes.find(node => node.props["aria-label"] === "Вечерний вид панорамы").props.onClick();
  view = demo.render(); assert.match(view.html, /map-night\.webp/);
  assert.equal(view.nodes.find(node => node.props["aria-label"] === "Вечерний вид панорамы").props["aria-pressed"], true);
  view.nodes.find(node => node.props["aria-label"] === "Вечерний вид панорамы").props.onClick();
  assert.doesNotMatch(demo.render().html, /map-night\.webp/);
  demo.unmount();
});

test("preview markers follow the effective world geometry rather than drifting after an artwork update", async () => {
  const source = JSON.parse(await readFile(path.join(root, "features/world/tiled/forest.generated.json"), "utf8"));
  const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
  const scene = previewWorldScene(source, media.levels);
  const h = demoHarness("SiteWorldDemo"), view = h.render();
  for (const [key, siteId, label] of [["home", "home", "Дом"], ["workshop", "workshop", "Мастерская"], ["neighbors", "plesk-shop", "Плёска"]]) {
    const anchor = scene.sites.find(site => site.id === siteId)?.anchor;
    assert.ok(anchor, `World site is missing: ${siteId}`);
    const pin = view.nodes.find(node => node.props["aria-label"] === `Узнать: ${label}`);
    assert.ok(pin);
    for (const [axis, style, size] of [["x", "left", scene.width], ["y", "top", scene.height]]) {
      const position = media.mapPlaces[key][axis];
      assert.ok(Number.isFinite(position) && position >= 0 && position <= 100);
      assert.ok(Math.abs(position - anchor[axis] / size * 100) < 1e-8, `Regenerate site metadata after moving ${siteId}`);
      assert.equal(pin.props.style[style], `${position}%`, `Rendered marker must use regenerated ${key}.${axis}`);
    }
  }
  h.unmount();
});

test("the video placeholder has no play action, movie element, API call, or playback effect", () => {
  const document = { addEventListener() { assert.fail("a placeholder must not subscribe to playback events"); } };
  const video = { play() { assert.fail("a placeholder must not start playback"); }, pause() { assert.fail("a placeholder must not pause playback"); }, load() { assert.fail("a placeholder must not request a movie"); } };
  const demo = demoHarness("SiteVideoPlaceholder", { document, video });
  const view = demo.render();
  assert.match(view.html, /Скоро здесь появится видеопрогулка/);
  assert.equal(view.nodes.some(node => node.type === "video" || node.type === "source"), false);
  assert.equal(view.nodes.some(node => node.type === "button" || node.type === "a"), false,
    "a promised future film must not look playable or downloadable today");
  assert.doesNotMatch(view.html, /\.(?:mp4|webm)\b|\bautoplay\b|\bas="video"/i);
  demo.unmount();
});

test("the public route's complete import graph excludes game runtimes and authenticated APIs", async () => {
  const visited = new Set();
  async function visit(filename) {
    if (visited.has(filename)) return;
    visited.add(filename);
    const relative = path.relative(root, filename).replaceAll(path.sep, "/");
    assert.doesNotMatch(relative, /^features\/(?:app|game|world|economy|account|people|check-in)\//, `Public page pulled in ${relative}`);
    assert.doesNotMatch(relative, /^(?:app\/api\/|lib\/(?:.*-api\.|api\/|auth-|session))/, `Public page pulled in ${relative}`);
    if (!/\.[cm]?[jt]sx?$/.test(filename)) return;
    const source = ts.createSourceFile(filename, await readFile(filename, "utf8"), ts.ScriptTarget.Latest, true);
    const specifiers = [];
    function scan(node) {
      if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && !node.isTypeOnly) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        assert.ok(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]), `Public import must be statically inspectable: ${relative}`);
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, scan);
    }
    scan(source);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const candidate = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
      let resolved;
      for (const extension of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"]) {
        if (await stat(candidate + extension).then(info => info.isFile(), () => false)) { resolved = candidate + extension; break; }
      }
      assert.ok(resolved, `Unresolved ${specifier} from ${relative}`);
      await visit(resolved);
    }
  }
  await visit(path.join(root, "app/site/page.tsx"));
  assert.ok(visited.has(path.join(root, "features/pwa/install-panel.tsx")), "real installation instructions remain connected to the public route");
});

test("responsive artwork decodes at its advertised dimensions and budgets one selected resource per image", async () => {
  const html = renderPage(), declarations = [], urls = new Set(), fallbackUrls = new Set();
  for (const [, tag] of html.matchAll(/(<img\b[^>]*>)/g)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    declarations.push({ src: attrs.src.replaceAll("&amp;", "&"), width: Number(attrs.width), height: Number(attrs.height) });
    fallbackUrls.add(attrs.src.replaceAll("&amp;", "&"));
    if (attrs.src.startsWith("/site/")) {
      assert.ok(attrs.srcSet && attrs.sizes, "public artwork must give the browser responsive candidates and layout sizes");
      for (const candidate of attrs.srcSet.split(",")) {
        const [src, descriptor] = candidate.trim().split(/\s+/);
        assert.match(descriptor, /^[1-9]\d*w$/, "responsive media uses actual pixel width descriptors");
        urls.add(src.replaceAll("&amp;", "&"));
      }
    }
  }
  declarations.push(media.poster, media.map, media.nightMap);
  for (const group of [media.poster, media.map, media.nightMap]) {
    assert.ok(group.variants.length >= 2, "artwork has a smaller screen option");
    assert.equal(group.srcSet, group.variants.map(image => `${image.src} ${image.width}w`).join(", "));
    assert.ok(group.variants.some(image => image.src === group.src), "the fallback belongs to the responsive family");
    declarations.push(...group.variants);
  }
  for (const group of [media.map, media.nightMap]) {
    assert.ok(group.variants.some(image => image.width <= 800), "small devices need a compact map");
    assert.ok(group.variants.some(image => image.width >= 2560), "high-DPI maps retain the source's native detail");
  }
  for (const image of declarations) urls.add(image.src);
  for (const filename of await readdir(path.join(root, "features/site"))) {
    const content = await readFile(path.join(root, "features/site", filename), "utf8");
    if (filename.endsWith(".css")) {
      for (const [, src] of content.matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)) urls.add(src);
    } else if (/\.tsx?$/.test(filename)) {
      const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
      function collect(node) {
        if (ts.isStringLiteralLike(node) && /^\/.*\.(?:webp|png|jpe?g|svg|mp4|webm)(?:[?#].*)?$/.test(node.text)) urls.add(node.text);
        ts.forEachChild(node, collect);
      }
      collect(source);
    }
  }
  let fallbackImageBytes = 0;
  const resourceBytes = new Map();
  for (const src of urls) {
    assert.ok(src.startsWith("/"), `Media must be self-hosted: ${src}`);
    const bytes = await readFile(localAsset(src));
    resourceBytes.set(src, bytes.length);
    assert.ok(bytes.length > 0, `Empty asset: ${src}`);
    if (/\.(?:mp4|webm)(?:[?#].*)?$/.test(src)) continue;
    const { info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    for (const dimensions of declarations.filter(image => image.src === src)) {
      assert.ok(dimensions.width > 0 && dimensions.height > 0, `Layout dimensions required: ${src}`);
      assert.equal(info.width / info.height, dimensions.width / dimensions.height, `Wrong declared aspect ratio: ${src}`);
      if (src.startsWith("/site/")) {
        assert.equal(info.width, dimensions.width, src); assert.equal(info.height, dimensions.height, src);
        if (dimensions.bytes !== undefined) assert.equal(bytes.length, dimensions.bytes, `Stale metadata byte size: ${src}`);
      }
    }
    if (src.startsWith("/site/")) {
      const budget = info.width > 1600 ? 2_500_000 : 1_000_000;
      assert.ok(bytes.length < budget, `${src} exceeds its ${budget} byte image budget: ${bytes.length}`);
      assert.match(src, /\?v=[a-f\d]{12}$/, "new artwork must invalidate a previously downloaded preview");
      assert.equal(new URL(src, "https://im-alive.ru").searchParams.get("v"), createHash("sha256").update(bytes).digest("hex").slice(0, 12),
        `The asset revision must match its bytes: ${src}`);
    }
    if (fallbackUrls.has(src)) fallbackImageBytes += bytes.length;
  }
  assert.ok(fallbackImageBytes < 2_000_000, `Fallback page images exceed 2 MB: ${fallbackImageBytes}`);
  const compactSceneBytes = [media.poster, media.map].reduce((sum, group) => sum + resourceBytes.get(group.variants[0].src), 0);
  assert.ok(compactSceneBytes < 750_000, `Small-screen scene candidates exceed 750 KB: ${compactSceneBytes}`);
  assert.equal(page.metadata.openGraph.images[0].url, `https://im-alive.ru${media.poster.src}`);
  assert.equal(page.metadata.openGraph.images[0].width, media.poster.width);
  assert.equal(page.metadata.openGraph.images[0].height, media.poster.height);
});

test("the site exposes an honest native pause toggle and respects a system motion preference", () => {
  const h = productHarness();
  let control = button(h.render(), "Спокойный режим");
  assert.equal(control.props.type, "button");
  assert.equal(control.props["aria-pressed"], false);
  control.props.onClick(); assert.equal(h.toggles(), 1, "the user can pause the actual motion hook from a native button");
  h.motion.motionEnabled = false;
  control = button(h.render(), "Спокойный режим");
  assert.equal(control.props["aria-pressed"], true, "the calm state is exposed without changing the button's name");
  h.motion.reducedMotion = true;
  assert.doesNotMatch(h.render().html, /Спокойный режим/, "a reduced-motion visitor is not offered an override to the system preference");
});

test("desktop and installed visitors enter the game from every primary site action while phones retain installation guidance", () => {
  const h = productHarness();
  for (const device of [
    { platform: "windows", browser: "yandex", embedded: false },
    { platform: "mac", browser: "safari", embedded: false },
    { platform: "linux", browser: "firefox", embedded: false },
  ]) {
    Object.assign(h.installation, { ready: true, device });
    const view = h.render();
    const entries = view.nodes.filter(node => node.props.href === "/");
    assert.ok(entries.length >= 4, "header, hero, closing and footer offer a direct game entry");
    assert.ok(entries.some(node => renderToStaticMarkup(node).includes("Играть")));
    for (const entry of entries) assert.equal(entry.props.prefetch, false, "game chunks load only on deliberate entry");
    assert.equal(view.nodes.find(node => node.type === h.WorldDemo).props.entryHref, "/");
    assert.doesNotMatch(view.html, /href="#install"[^>]*>Установить/, "desktop primary actions must not become an install detour");
  }
  Object.assign(h.installation, { ready: true, standalone: false, device: { platform: "ios", browser: "safari", embedded: false } });
  let view = h.render();
  assert.ok(view.nodes.some(node => node.props.href === "#install" && renderToStaticMarkup(node).includes("Установить")));
  assert.equal(view.nodes.find(node => node.type === h.WorldDemo).props.entryHref, "#install");
  h.installation.standalone = true; view = h.render();
  assert.equal(view.nodes.find(node => node.type === h.WorldDemo).props.entryHref, "/", "installed phones do not return to installation guidance");
  h.installation.ready = false; h.installation.standalone = false;
  view = h.render();
  assert.equal(view.nodes.find(node => node.type === h.WorldDemo).props.entryHref, "#install", "server output does not guess a desktop client");
});

test("the world demo follows its entry route without prefetching or mounting the game", () => {
  const h = demoHarness("SiteWorldDemo");
  for (const entryHref of ["/", "#install"]) {
    const view = h.render({ entryHref });
    const entry = view.nodes.find(node => node.props.href === entryHref);
    assert.ok(entry); assert.equal(entry.props.prefetch, false);
    assert.match(view.html, entryHref === "/" ? /Играть на своей полянке/ : /Хочу свою полянку/);
  }
  h.unmount();
});

test("public demo controls remain native keyboard controls and communicate their state", () => {
  const checkIn = demoHarness("SiteCheckInDemo"), world = demoHarness("SiteWorldDemo");
  for (const demo of [checkIn, world]) {
    let view = demo.render();
    const controls = view.nodes.filter(node => node.type === "button");
    assert.ok(controls.length > 0);
    for (const control of controls) {
      assert.equal(control.props.type, "button", "a demo must not accidentally submit a form");
      assert.notEqual(control.props.tabIndex, -1, "native demo buttons remain in the keyboard focus order");
      assert.equal(typeof control.props.onClick, "function");
      assert.ok(control.props["aria-label"] || renderToStaticMarkup(control).replace(/<[^>]*>/g, "").trim(), "every control has an accessible name");
    }
    const initial = controls.find(node => node.props["aria-pressed"] === true) ?? controls.find(node => node.props["aria-pressed"] === false);
    assert.ok(initial, "toggles expose their initial state");
    demo.unmount();
  }
});

test("installing from the presentation preserves the existing root application identity", () => {
  const identity = manifest();
  assert.equal(identity.id, "/"); assert.equal(identity.start_url, "/"); assert.equal(identity.scope, "/");
  assert.equal(identity.display, "standalone"); assert.equal(identity.name, "Я Живой"); assert.equal(identity.short_name, "Я Живой");
  assert.equal(page.metadata.alternates.canonical, "https://im-alive.ru/site");
  assert.equal(page.viewport.userScalable, true); assert.ok(page.viewport.maximumScale >= 5);
});
