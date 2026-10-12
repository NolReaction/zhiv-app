import assert from "node:assert/strict";
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
const { default: manifest } = await vite.ssrLoadModule("/app/manifest.ts");
const media = JSON.parse(await readFile(path.join(root, "public/site/media.json"), "utf8"));
const demoSource = await readFile(path.join(root, "features/site/site-demos.tsx"), "utf8");
const demoCode = ts.transpileModule(demoSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const renderPage = () => renderToStaticMarkup(createElement(PwaInstallProvider, null, createElement(page.default)));

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
// native media/document capabilities are replaced; no production behavior is copied.
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
      if (id.endsWith(".module.css")) return new Proxy({}, { get: (_, key) => key });
      assert.fail(`Unexpected demo dependency: ${id}`);
    },
  };
  vm.runInNewContext(demoCode, context, { filename: "site-demos.tsx" });
  return {
    render() {
      cursor = 0;
      const tree = context.exports[name](), nodes = elements(tree);
      for (const node of nodes) if (node.type === "video" && node.props.ref) node.props.ref.current = environment.video;
      while (pending.length) pending.shift()();
      return { nodes, html: renderToStaticMarkup(tree) };
    },
    unmount() { for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear(); },
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

// Read bounded ISO BMFF boxes directly, so the normal test runner needs neither
// ffmpeg nor optional authoring tools to inspect the shipped MP4's real metadata.
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    assert.ok(offset + 8 <= end, "truncated MP4 box header");
    const smallSize = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    const header = smallSize === 1 ? 16 : 8;
    assert.ok(offset + header <= end, `truncated ${type} extended header`);
    const size = smallSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : smallSize || end - offset;
    assert.ok(size >= header && offset + size <= end, `invalid ${type} box size`);
    result.push({ type, offset, start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}
function child(bytes, box, type) {
  const result = boxes(bytes, box.start, box.end).find(item => item.type === type);
  assert.ok(result, `Missing ${type} box`);
  return result;
}

test("public page server-renders its story, demos, installation instructions and every navigation target", t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => { requests.push(url); throw new Error("unexpected public-page request"); });
  const html = renderPage();
  assert.match(html, /<h1[^>]*id="site-title"/);
  for (const id of ["about", "world", "install", "questions"]) assert.match(html, new RegExp(`<section[^>]*id="${id}"`));
  for (const content of ["Близкие спокойны", "Попробуй · демонстрация", "Интерактивное знакомство", "Смотреть прогулку", "Инструкция для вашего устройства", "iPhone / iPad", "Android · Chrome", "Mac · Safari", "Что такое PWA?", "Прогресс привязан к аккаунту"]) {
    assert.ok(html.includes(content), `SSR is missing: ${content}`);
  }
  assert.match(html, /data-install-panel/);
  assert.match(html, /<ol><li>/, "manual installation steps exist before hydration");
  assert.match(html, /<a href="\/"[^>]*>Перейти к приложению/);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `Broken in-page link: #${target}`);
  assert.deepEqual(requests, []);
});

test("initial page exposes no video source or preload and needs no autoplay permission", () => {
  const html = renderPage();
  assert.doesNotMatch(html, /<(?:video|source)\b|\.mp4\b|\bautoplay\b|\bas="video"/i);
  assert.match(html, /<button[^>]*>[\s\S]*Смотреть прогулку/);
  assert.match(html, /Без звука\. Запускается только по нажатию/);
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

test("video is mounted by a click, handles rejected playback and media errors, and pauses while hidden", async () => {
  const document = new EventTarget(); document.hidden = false;
  const calls = { play: 0, pause: 0, load: 0 };
  const video = { play() { calls.play++; return Promise.reject(new Error("browser denied playback")); }, pause() { calls.pause++; }, load() { calls.load++; } };
  const demo = demoHarness("SiteVideo", { document, video });
  let view = demo.render();
  assert.equal(view.nodes.some(node => node.type === "video"), false);
  assert.deepEqual(calls, { play: 0, pause: 0, load: 0 });
  button(view, "Смотреть прогулку").props.onClick(); view = demo.render();
  const player = view.nodes.find(node => node.type === "video");
  assert.ok(player);
  assert.equal(player.props.src, media.video.src);
  assert.equal(player.props.poster, media.poster.src);
  assert.equal(player.props.autoPlay, undefined);
  assert.equal(player.props.controls, true); assert.equal(player.props.muted, true); assert.equal(player.props.playsInline, true);
  assert.equal(calls.play, 1);
  await Promise.resolve();
  document.dispatchEvent(new Event("visibilitychange")); assert.equal(calls.pause, 0);
  document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); assert.equal(calls.pause, 1);
  player.props.onError(); view = demo.render();
  assert.match(view.html, /Не удалось загрузить видео/);
  button(view, "Повторить").props.onClick(); view = demo.render();
  assert.doesNotMatch(view.html, /Не удалось загрузить видео/);
  assert.deepEqual(calls, { play: 2, pause: 1, load: 1 });
  await Promise.resolve(); demo.unmount();
  document.dispatchEvent(new Event("visibilitychange")); assert.equal(calls.pause, 1, "visibility handler was removed on unmount");
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

test("every local media URL exists and images decode at their declared dimensions within a small budget", async () => {
  const html = renderPage(), declarations = [], urls = new Set();
  for (const [, tag] of html.matchAll(/(<img\b[^>]*>)/g)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    declarations.push({ src: attrs.src.replaceAll("&amp;", "&"), width: Number(attrs.width), height: Number(attrs.height) });
  }
  declarations.push(media.poster, media.map, media.nightMap);
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
  let initialImageBytes = 0;
  for (const src of urls) {
    assert.ok(src.startsWith("/"), `Media must be self-hosted: ${src}`);
    const bytes = await readFile(localAsset(src));
    assert.ok(bytes.length > 0, `Empty asset: ${src}`);
    if (/\.(?:mp4|webm)(?:[?#].*)?$/.test(src)) continue;
    const { info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    for (const dimensions of declarations.filter(image => image.src === src)) {
      assert.ok(dimensions.width > 0 && dimensions.height > 0, `Layout dimensions required: ${src}`);
      assert.equal(info.width / info.height, dimensions.width / dimensions.height, `Wrong declared aspect ratio: ${src}`);
      if (src.startsWith("/site/")) {
        assert.equal(info.width, dimensions.width, src); assert.equal(info.height, dimensions.height, src);
      }
    }
    if (src.startsWith("/site/")) assert.ok(bytes.length < 1_000_000, `${src} exceeds the 1 MB image budget: ${bytes.length}`);
    if (html.includes(src.replaceAll("&", "&amp;"))) initialImageBytes += bytes.length;
  }
  assert.ok(initialImageBytes < 2_000_000, `Initial unique images exceed 2 MB: ${initialImageBytes}`);
  assert.equal(page.metadata.openGraph.images[0].url, `https://im-alive.ru${media.poster.src}`);
  assert.equal(page.metadata.openGraph.images[0].width, media.poster.width);
  assert.equal(page.metadata.openGraph.images[0].height, media.poster.height);
});

test("shipped tour is a compact 12-second H.264 video with real dimensions, no audio, and faststart", async () => {
  const bytes = await readFile(localAsset(media.video.src)), top = boxes(bytes);
  assert.ok(bytes.length > 10_000 && bytes.length < 3_000_000, `MP4 size outside the playback budget: ${bytes.length}`);
  assert.equal(top[0].type, "ftyp");
  const moov = top.find(box => box.type === "moov"), mdat = top.find(box => box.type === "mdat");
  assert.ok(moov && mdat); assert.ok(moov.offset < mdat.offset, "faststart avoids downloading the full video before playback");
  const mvhd = child(bytes, moov, "mvhd");
  const timeOffset = bytes[mvhd.start] === 1 ? 20 : 12;
  const timescale = bytes.readUInt32BE(mvhd.start + timeOffset);
  const duration = bytes[mvhd.start] === 1 ? Number(bytes.readBigUInt64BE(mvhd.start + timeOffset + 4)) : bytes.readUInt32BE(mvhd.start + timeOffset + 4);
  assert.equal(duration / timescale, media.video.duration);
  const tracks = boxes(bytes, moov.start, moov.end).filter(box => box.type === "trak");
  assert.equal(tracks.length, 1, "no audio or other hidden tracks"); assert.equal(media.video.audio, false);
  const tkhd = child(bytes, tracks[0], "tkhd"), mdia = child(bytes, tracks[0], "mdia");
  assert.equal(bytes.readUInt32BE(tkhd.end - 8) / 65536, media.video.width);
  assert.equal(bytes.readUInt32BE(tkhd.end - 4) / 65536, media.video.height);
  const hdlr = child(bytes, mdia, "hdlr"); assert.equal(bytes.toString("ascii", hdlr.start + 8, hdlr.start + 12), "vide");
  const stbl = child(bytes, child(bytes, mdia, "minf"), "stbl"), stsd = child(bytes, stbl, "stsd");
  assert.equal(boxes(bytes, stsd.start + 8, stsd.end)[0].type, "avc1");
  const stsz = child(bytes, stbl, "stsz"); assert.equal(bytes.readUInt32BE(stsz.start + 8) / media.video.duration, media.video.fps);
});

test("installing from the presentation preserves the existing root application identity", () => {
  const identity = manifest();
  assert.equal(identity.id, "/"); assert.equal(identity.start_url, "/"); assert.equal(identity.scope, "/");
  assert.equal(identity.display, "standalone"); assert.equal(identity.name, "Я живой");
  assert.equal(page.metadata.alternates.canonical, "https://im-alive.ru/site");
  assert.equal(page.viewport.userScalable, true); assert.ok(page.viewport.maximumScale >= 5);
});
