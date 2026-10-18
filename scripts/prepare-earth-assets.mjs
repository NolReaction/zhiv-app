import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const EARTH_RUNTIME_ASSET_VERSION = "6.15.0";
export const EARTH_RUNTIME_ASSET_FILES = ["maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs", "LICENSE.txt"];

/** Cached Blob modules cannot resolve relative static dependencies. Review upgrades explicitly. */
export function assertStandaloneEarthModule(name, source) {
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length || sourceFile.statements.some(statement =>
    ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) && statement.moduleSpecifier)) {
    throw new Error(`MapLibre ${name} must be a standalone production module without static imports`);
  }
}

/** Prepare the exact same production runtime for both Next and Vite, without CDN execution. */
export async function prepareEarthAssets(projectRoot = process.cwd()) {
  const require = createRequire(resolve(projectRoot, "package.json"));
  const packagePath = require.resolve("maplibre-gl/package.json");
  const { version } = JSON.parse(await readFile(packagePath, "utf8"));
  if (version !== EARTH_RUNTIME_ASSET_VERSION) throw new Error("Unsupported MapLibre asset version: review the Earth runtime installer before upgrading");
  const files = await Promise.all(EARTH_RUNTIME_ASSET_FILES.map(async name => {
    const source = resolve(dirname(packagePath), name === "LICENSE.txt" ? name : `dist/${name}`);
    const bytes = await readFile(source);
    if (name.endsWith(".mjs")) assertStandaloneEarthModule(name, bytes.toString("utf8"));
    return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const directory = resolve(projectRoot, "public/vendor", `maplibre-gl-${version}`);
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    await writeFile(resolve(directory, file.name), file.bytes);
  }
  const manifest = { schemaVersion: 1, version, files: files.map(file => ({ name: file.name, bytes: file.bytes.byteLength, sha256: file.sha256 })) };
  await writeFile(resolve(directory, "manifest.json.tmp"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(resolve(directory, "manifest.json.tmp"), resolve(directory, "manifest.json"));
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareEarthAssets().then(directory => console.log(`Earth map runtime prepared: ${directory}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
