import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const helperSource = await readFile(new URL("../features/world/scene/lighting-refresh.ts", import.meta.url), "utf8");
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const fixtureSource = await readFile(new URL("../features/world/environment/lighting/forest-torch-fixture.ts", import.meta.url), "utf8");
const fixtureUrl = `data:text/javascript;base64,${Buffer.from(transpile(fixtureSource)).toString("base64")}`;
const fixtureImport = "@/features/world/environment/lighting/forest-torch-fixture";
const { applyWorldLightingRefresh } = await import(`data:text/javascript;base64,${Buffer.from(transpile(helperSource).replace(fixtureImport, fixtureUrl)).toString("base64")}`);
const scene = () => ({ schemaVersion: 1, id: "test-forest", width: 100, height: 100, sites: [], terrain: [], paths: [],
  focus: { x: 0, y: 0, width: 100, height: 100 }, actor: { spawn: { x: 50, y: 50 }, size: 10 },
  lights: [{ id: "glow", kind: "glow", position: { x: 20, y: 30 }, radius: 50, intensity: .6, color: "#8adbd0", flicker: 0 }],
  shadowCasters: [], shadowReceivers: [] });

test("authored lighting refresh keeps the shared scene and unrelated world geometry", () => {
  const current = scene(), before = current.actor, next = structuredClone(current);
  next.lights[0].position.x = 40;
  next.shadowCasters.push({ id: "tree", points: [], height: 20 });
  assert.equal(applyWorldLightingRefresh(current, next), true);
  assert.equal(current.actor, before);
  assert.equal(current.lights[0].position.x, 40);
  assert.equal(current.shadowCasters[0].id, "tree");
  const deleted = structuredClone(current); delete deleted.lights;
  assert.equal(applyWorldLightingRefresh(current, deleted), true);
  assert.equal(current.lights, undefined);
});

test("a non-lighting Tiled edit follows the normal refresh without partially applying its lighting", () => {
  const current = scene(), before = structuredClone(current), next = structuredClone(current);
  next.actor.spawn.x = 70; next.lights = [];
  assert.equal(applyWorldLightingRefresh(current, next), false);
  assert.deepEqual(current, before);
});

test("physical torch edits require a navigation refresh; flame-only edits keep the live owner", () => {
  const source = scene();
  source.lights[0].kind = "torch";
  for (const edit of [value => value.lights[0].position.x++, value => value.lights[0].position.y++,
    value => { value.lights[0].manualPosition = true; },
    value => { value.lights[0].enabled = false; }, value => { value.lights[0].kind = "lantern"; },
    value => { value.lights = []; }, value => value.lights.push({ ...value.lights[0], id: "second", position: { x: 70, y: 70 } })]) {
    const current = structuredClone(source), next = structuredClone(source);
    edit(next);
    assert.equal(applyWorldLightingRefresh(current, next), false);
    assert.deepEqual(current, source, "no partial in-place mutation before rebuilding geometry");
  }
  const next = structuredClone(source);
  Object.assign(next.lights[0], { color: "#ffffff", radius: 100, intensity: 0, height: 90, flicker: .5 });
  const current = structuredClone(source);
  assert.equal(applyWorldLightingRefresh(current, next), true);
  assert.deepEqual(current.lights, next.lights);
});

test("webpack accepts repeated glow edit/delete/Undo without replacing the live game importer", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "zhiv-lighting-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const presentation = await readFile(new URL("../features/world/scene/presentation.ts", import.meta.url), "utf8");
  await writeFile(path.join(root, "presentation.js"), transpile(presentation).replaceAll("@/features/world/tiled/forest.generated.json", "./forest.generated.json").replace('"./lighting-refresh"', '"./lighting-refresh.js"'));
  await writeFile(path.join(root, "lighting-refresh.js"), transpile(helperSource).replace(fixtureImport, "./forest-torch-fixture.js"));
  await writeFile(path.join(root, "forest-torch-fixture.js"), transpile(fixtureSource));
  const current = scene(), file = path.join(root, "forest.generated.json");
  await writeFile(file, JSON.stringify(current));
  await writeFile(path.join(root, "entry.js"), `import { TILED_WORLD } from "./presentation.js";
    import { subscribeWorldLightingRefresh } from "./lighting-refresh.js";
    export const owner = { scene: TILED_WORLD, editor: { undo: ["first edit"] }, presence: "same-session", refreshes: 0 };
    subscribeWorldLightingRefresh(() => owner.refreshes++);
    export const scene = () => TILED_WORLD;
    export const update = () => module.hot.check(true);
  `);
  const compiler = webpack({ mode: "development", context: root, target: "node", entry: "./entry.js", devtool: false,
    output: { path: path.join(root, "dist"), filename: "entry.cjs", library: { type: "commonjs2" } },
    plugins: [new webpack.HotModuleReplacementPlugin()] });
  let nextBuild;
  const build = () => new Promise((resolve, reject) => { nextBuild = { resolve, reject }; });
  const firstBuild = build();
  const watcher = compiler.watch({ aggregateTimeout: 20 }, (error, stats) => {
    const pending = nextBuild; nextBuild = null;
    if (!pending) return;
    if (error || stats.hasErrors()) pending.reject(error ?? new Error(stats.toString({ all: false, errors: true })));
    else pending.resolve(stats);
  });
  t.after(() => new Promise(resolve => watcher.close(() => compiler.close(resolve))));
  await firstBuild;
  const live = require(path.join(root, "dist/entry.cjs")), owner = live.owner;
  for (const change of [value => { value.lights[0].position.x = 55; }, value => { value.lights = []; }, value => { value.lights = scene().lights; }]) {
    change(current);
    const rebuilt = build();
    await writeFile(file, JSON.stringify(current));
    await rebuilt;
    const applied = await live.update();
    assert.ok(applied.length > 0);
    assert.equal(live.owner, owner);
    assert.equal(live.scene(), owner.scene);
    assert.deepEqual(live.scene().lights, current.lights);
    assert.deepEqual(owner.editor.undo, ["first edit"]);
    assert.equal(owner.presence, "same-session");
  }
  assert.equal(owner.refreshes, 3);
  // A changed spawn is not silently kept by the narrow Studio boundary.
  current.actor.spawn.x = 75;
  const rebuilt = build(); await writeFile(file, JSON.stringify(current)); await rebuilt;
  await assert.rejects(live.update(), /not accepted|Aborted/);
});
