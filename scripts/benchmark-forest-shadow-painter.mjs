// Native Chromium Canvas2D lighting microbenchmark, not whole-game/device FPS.
// node scripts/benchmark-forest-shadow-painter.mjs [baseline-ref] [frames] [low|high] [--operations]
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const baselineRef = process.argv[2] ?? "f46a2ca120ed690caacd1a76473f85539a5850a1";
const frames = Number(process.argv[3] ?? 180), quality = process.argv[4] ?? "low";
if (!Number.isInteger(frames) || frames < 30 || frames > 10000 || !["low", "high"].includes(quality)) throw new Error("Expected frames=30..10000 and quality=low|high");
const runtimeRequire = createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ?? root + "/node_modules"}/package.json`);
const fallbackExecutables = ["/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell",
  "/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome"];
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath) for (const candidate of fallbackExecutables) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* try the next installed browser */ }
}
const geometryPath = "features/world/environment/lighting/forest-shadow-geometry.ts";
const painterPath = "features/world/environment/lighting/forest-shadow-painter.ts";
const viewportPath = "features/world/scene/canvas-viewport.ts";
const compile = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString("base64")}`;
const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const fromGit = path => execFileSync("git", ["show", `${baselineRef}:${path}`], { cwd: root, encoding: "utf8" });
const viewport = compile(await read(viewportPath));
const receiverGeometry = compile(await read("features/world/environment/lighting/forest-receiver-geometry.mjs"));
async function renderer(before) {
  const geometry = compile((before ? fromGit(geometryPath) : await read(geometryPath))
    .replace("  if (!Number.isFinite(receiverHeight)", "  globalThis.__shadowBenchmark.projections++;\n  if (!Number.isFinite(receiverHeight)"));
  const source = (before ? fromGit(painterPath) : await read(painterPath))
    .replace('"./forest-shadow-geometry"', JSON.stringify(geometry))
    .replace('"./forest-receiver-geometry"', JSON.stringify(receiverGeometry))
    .replace('"@/features/world/scene/canvas-viewport"', JSON.stringify(viewport));
  return { painter: compile(source), geometry };
}
const versions = { baseline: await renderer(true), current: await renderer(false) };
const operationsOnly = process.argv.includes("--operations");
const runBenchmark = async ({ versions, frames, quality, operationsOnly }) => {
    const modules = {};
    for (const [name, urls] of Object.entries(versions)) modules[name] = { painter: await import(urls.painter), geometry: await import(urls.geometry) };
    const originalCreate = document.createElement.bind(document), instrumented = new WeakSet();
    const freshStats = () => ({ projections: 0, clearCalls: 0, clearedPixels: 0, drawImages: 0, fills: 0, canvases: 0, enabled: false });
    globalThis.__shadowBenchmark = freshStats();
    function instrument(ctx) {
      if (!ctx || instrumented.has(ctx)) return ctx;
      instrumented.add(ctx);
      for (const method of ["clearRect", "drawImage", "fill"]) {
        const native = ctx[method];
        ctx[method] = function (...args) {
          const stats = globalThis.__shadowBenchmark;
          if (stats.enabled) {
            if (method === "clearRect") { stats.clearCalls++; stats.clearedPixels += args[2] * args[3]; }
            else if (method === "drawImage") stats.drawImages++;
            else stats.fills++;
          }
          return native.apply(this, args);
        };
      }
      return ctx;
    }
    document.createElement = (...args) => {
      const element = originalCreate(...args);
      if (args[0] === "canvas") {
        if (globalThis.__shadowBenchmark.enabled) globalThis.__shadowBenchmark.canvases++;
        const native = element.getContext;
        element.getContext = function (...contextArgs) { return instrument(native.apply(this, contextArgs)); };
      }
      return element;
    };
    const square = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
    function fixture() {
      const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 320;
      const ctx = canvas.getContext("2d");
      return { canvas, ctx, scene: { schemaVersion: 1, id: "lighting-benchmark", width: 1254, height: 1254,
        terrain: [], sites: [], paths: [], focus: { x: 0, y: 0, width: 1254, height: 1254 },
        shadowCasters: [{ id: "tree", points: square(175, 165, 24), height: 75, baseHeight: 0, opacity: .6, softness: 3 }],
        shadowReceivers: [{ id: "ground", points: square(0, 0, 1254), height: 0 },
          { id: "raised", points: square(200, 190, 80), height: 22 }] } };
    }
    function render(version, target, mode, index) {
      const { painter, geometry } = modules[version], stats = globalThis.__shadowBenchmark;
      stats.enabled = false;
      const { ctx, scene } = target;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#e5ecd9"; ctx.fillRect(0, 0, 480, 320);
      ctx.setTransform(2, 0, 0, 2, -160 - (mode === "camera" ? Math.sin(index * .035) * 1400 : 0), -160);
      const actors = Array.from({ length: 6 }, (_, at) => {
        const moving = mode === "moving" ? Math.sin(index * .05 + at) * 12 : 0;
        const body = geometry.createForestActorShadow({ x: 130 + at * 18 + moving, y: 145 + at * 8 }, 6, `actor-${at}`);
        body.height = 24; body.baseHeight = mode === "moving" && at === 0 ? Math.max(0, Math.sin(index * .04)) * 7 : 0;
        return body;
      });
      const frame = { night: .9, azimuth: 225, elevation: 40, quality, geometryRevision: 0, actors,
        sources: [{ id: "near-left", position: { x: 160, y: 170 }, height: 24, radius: 140, color: "#ffd28a",
          intensity: .88 + (mode === "flicker" ? Math.sin(index * .027) * .023 : 0) },
        { id: "near-right", position: { x: 240, y: 200 }, height: 65, radius: 135, color: "#ffa449", intensity: 1.12 },
        { id: "offscreen", position: { x: 1000, y: 900 }, height: 38, radius: 150, color: "#ffe5a6", intensity: 1.3 }] };
      stats.enabled = true;
      painter.drawForestDirectionalShadows(ctx, scene, frame); painter.drawForestOccludedLighting(ctx, scene, frame);
      stats.enabled = false;
    }
    const modes = ["stationary", "flicker", "moving", "camera"], comparisons = [];
    for (const mode of operationsOnly ? [] : modes) {
      const before = fixture(), after = fixture();
      let maxDelta = 0, changedChannels = 0;
      for (const index of [0, 7, 31, 73]) {
        render("baseline", before, mode, index); render("current", after, mode, index);
        const a = before.ctx.getImageData(0, 0, 480, 320).data, b = after.ctx.getImageData(0, 0, 480, 320).data;
        for (let at = 0; at < a.length; at++) { const delta = Math.abs(a[at] - b[at]); maxDelta = Math.max(maxDelta, delta); if (delta) changedChannels++; }
      }
      comparisons.push({ mode, maxChannelDelta: maxDelta, changedChannels });
    }
    const measurements = [];
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    function sample(version, mode) {
      const target = fixture();
      for (let index = 0; index < 30; index++) render(version, target, mode, index);
      globalThis.__shadowBenchmark = freshStats();
      const start = performance.now();
      for (let index = 30; index < frames + 30; index++) render(version, target, mode, index);
      if (!operationsOnly) target.ctx.getImageData(0, 0, 1, 1); // Flush pending native rendering once per sample.
      const elapsed = performance.now() - start;
      const stats = { ...globalThis.__shadowBenchmark }; delete stats.enabled;
      return { elapsed, stats };
    }
    for (const mode of modes) {
      const before = [], after = [];
      for (let index = 0; index < 5; index++) {
        if (index % 2) { after.push(sample("current", mode)); before.push(sample("baseline", mode)); }
        else { before.push(sample("baseline", mode)); after.push(sample("current", mode)); }
      }
      const summarize = values => ({ medianMsPerFrame: Number((median(values.map(value => value.elapsed)) / frames).toFixed(4)), operations: values[0].stats });
      measurements.push({ mode, baseline: summarize(before), current: summarize(after) });
    }
    document.createElement = originalCreate;
    return { scope: operationsOnly ? "Canvas command simulation; no pixel, GPU or device FPS measurement"
      : "Native Chromium Canvas2D lighting fixture; excludes whole-game/device FPS", quality, framesPerSample: frames,
      samples: 5, actors: 6, lights: 3, canvas: "480x320", comparisons, measurements };
};
let browser;
try {
  if (operationsOnly) {
    globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
    globalThis.document = { createElement(tag) {
      if (tag !== "canvas") throw new Error("Expected canvas");
      const canvas = { width: 0, height: 0 }, stack = [];
      const ctx = { canvas, globalAlpha: 1, globalCompositeOperation: "source-over", filter: "none", imageSmoothingEnabled: true,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
      ctx.save = () => stack.push({ globalAlpha: ctx.globalAlpha, globalCompositeOperation: ctx.globalCompositeOperation,
        filter: ctx.filter, transform: { ...ctx.transform } });
      ctx.restore = () => Object.assign(ctx, stack.pop());
      ctx.setTransform = (a, b, c, d, e, f) => { ctx.transform = { a, b, c, d, e, f }; };
      ctx.getTransform = () => ctx.transform;
      ctx.createRadialGradient = () => ({ addColorStop() {} });
      for (const method of ["clearRect", "drawImage", "fill", "fillRect", "clip", "beginPath", "moveTo", "lineTo", "closePath"]) ctx[method] = () => {};
      canvas.getContext = () => ctx;
      return canvas;
    } };
  } else {
    const { chromium } = runtimeRequire("playwright");
    browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  }
  const args = { versions, frames, quality, operationsOnly };
  const result = operationsOnly ? await runBenchmark(args) : await (await browser.newPage()).evaluate(runBenchmark, args);
  console.log(JSON.stringify({ baselineRef, browser: browser ? await browser.version() : null, ...result }, null, 2));
  if (result.comparisons.some(value => value.maxChannelDelta > 1)) process.exitCode = 1;
} finally { if (browser) await browser.close(); }
