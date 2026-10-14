import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

test("engine builds outside the repository and its distribution works in plain JS and strict TypeScript hosts", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "zhiv-engine-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  await mkdir(source);
  for (const entry of ["src", "package.json", "tsconfig.json", "tsconfig.build.json"]) {
    await cp(path.join(root, "packages/engine", entry), path.join(source, entry), { recursive: true });
  }
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  await run(process.execPath, [compiler, "-p", path.join(source, "tsconfig.build.json")], { cwd: directory });
  const consumer = path.join(directory, "consumer");
  const installed = path.join(consumer, "node_modules/@zhiv/engine");
  await mkdir(installed, { recursive: true });
  await cp(path.join(source, "dist"), path.join(installed, "dist"), { recursive: true });
  await cp(path.join(source, "package.json"), path.join(installed, "package.json"));
  assert.deepEqual((await readdir(installed)).sort(), ["dist", "package.json"], "consumers receive no source files or editor examples");
  for (const entry of await readdir(path.join(installed, "dist"), { recursive: true })) {
    if (!entry.endsWith(".js")) continue;
    const text = await readFile(path.join(installed, "dist", entry), "utf8");
    assert.doesNotMatch(text, /(?:from\s*|import\s*\()\s*["']\.{1,2}\/[^"']+\.(?:ts|tsx|mts|cts)["']/, `${entry} imports executable JavaScript`);
  }
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(consumer, "consumer.mjs"), `
import assert from 'node:assert/strict';
import { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER } from '@zhiv/engine';
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const preset = {id:'external',catalog:{marker:{bounds:{x:-3,y:-5,width:6,height:5}}},
  terrain:EMPTY_TERRAIN_DEFINITION,terrainPainter:SOLID_TERRAIN_PAINTER,
  initialObjects:()=>[{id:'external:marker',kind:'marker',x:80,y:2100,scale:1,variant:0}]};
const painter = createScenePainter(() => { throw new Error('query must not allocate a canvas'); }, preset);
const options = {seed:1,width:400,height:2300,planted:[],removed:new Set()};
assert.equal(painter.objects(options)[0].kind,'marker');
assert.equal(painter.objects({...options,removed:new Set(['external:marker'])}).length,0);
painter.dispose();
console.log('portable');
`);
  const result = await run(process.execPath, ["consumer.mjs"], { cwd: consumer });
  assert.equal(result.stdout.trim(), "portable");
  await writeFile(path.join(consumer, "consumer.ts"), `
import { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER,
  type EnginePreset, type SceneRenderOptions } from '@zhiv/engine';
const preset: EnginePreset = {id:'external',catalog:{marker:{bounds:{x:-3,y:-5,width:6,height:5}}},
  terrain:EMPTY_TERRAIN_DEFINITION,terrainPainter:SOLID_TERRAIN_PAINTER};
const painter = createScenePainter(() => { throw new Error('no drawing surface'); }, preset);
const options: SceneRenderOptions = {seed:1,width:400,height:2300,planted:[],removed:new Set()};
const objects = painter.objects(options);
const kind: string | undefined = objects[0]?.kind;
painter.dispose();
void kind;
`);
  for (const resolution of ["NodeNext", "Bundler"]) {
    await writeFile(path.join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: resolution === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: resolution,
      strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ["ES2022", "DOM", "DOM.Iterable"],
    }, include: ["consumer.ts"] }));
    await run(process.execPath, [compiler, "-p", "tsconfig.json"], { cwd: consumer });
  }
});
