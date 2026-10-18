import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareEarthModelGeometry, EARTH_MODEL_SIMPLIFIER_VERSION } from "./lib/earth-model-prepare.mjs";

export async function readEarthModelSource(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 28 || stat.size > 32 * 1024 * 1024) throw new Error("Earth model: source exceeds GLB size budget");
    // One spare byte detects growth without an unbounded readFile allocation.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("Earth model: source changed during bounded read");
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

export async function prepareEarthModel(configPath, { check = false } = {}) {
  const simplifierPackage = resolve(dirname(fileURLToPath(import.meta.resolve("meshoptimizer"))), "package.json");
  const version = JSON.parse(await readFile(simplifierPackage, "utf8")).version;
  if (version !== EARTH_MODEL_SIMPLIFIER_VERSION) throw new Error("Review model preparation outputs before upgrading meshoptimizer");
  const path = resolve(configPath), directory = dirname(path), config = JSON.parse(await readFile(path, "utf8"));
  for (const field of ["source", "outputDirectory", "runtimeManifest"])
    if (typeof config[field] !== "string" || !config[field]) throw new Error(`Missing model config field: ${field}`);
  const sourcePath = resolve(directory, config.source), source = await readEarthModelSource(sourcePath);
  const { files, manifest } = await prepareEarthModelGeometry(source, config);
  const outputs = files.map(file => ({ path: resolve(directory, config.outputDirectory, file.name), bytes: file.bytes }));
  outputs.push({ path: resolve(directory, config.runtimeManifest), bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  if (outputs.some(output => output.path === sourcePath || output.path === path)) throw new Error("Model output would overwrite its source/config");
  if (new Set(outputs.map(output => output.path)).size !== outputs.length) throw new Error("Model output paths overlap");
  // All parsing, simplification and validation finish before the first write.
  for (const output of outputs) {
    if (check) {
      let actual;
      try { actual = await readFile(output.path); } catch { throw new Error(`Missing prepared model: ${output.path}`); }
      if (!actual.equals(output.bytes)) throw new Error(`Stale prepared model: ${output.path}`);
    } else {
      await mkdir(dirname(output.path), { recursive: true });
      await writeFile(output.path, output.bytes);
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), check = args.includes("--check"), configIndex = args.indexOf("--config");
  const valid = args.filter((arg, index) => arg !== "--check" && arg !== "--config" && !(configIndex >= 0 && index === configIndex + 1));
  if (valid.length || configIndex >= 0 && (!args[configIndex + 1] || args[configIndex + 1].startsWith("--"))
    || args.filter(arg => arg === "--config").length > 1 || args.filter(arg => arg === "--check").length > 1) {
    console.error("Usage: node scripts/prepare-earth-model.mjs [--config path/to/model.json] [--check]"); process.exitCode = 1;
  } else {
    const config = configIndex >= 0 ? args[configIndex + 1] : "art/earth/models/eiffel-tower/model.json";
    prepareEarthModel(config, { check }).then(manifest => console.log(`Earth model ${check ? "verified" : "prepared"}: ${manifest.id}; `
      + `overview ${manifest.overview.triangles} triangles / ${manifest.overview.bytes} B; detail ${manifest.detail.triangles} triangles / ${manifest.detail.bytes} B`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
