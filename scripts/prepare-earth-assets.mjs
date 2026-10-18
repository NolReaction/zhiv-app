import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A same-origin worker works in both Next and Vite, without CDN execution. */
export async function prepareEarthAssets(projectRoot = process.cwd()) {
  const require = createRequire(resolve(projectRoot, "package.json"));
  const packagePath = require.resolve("maplibre-gl/package.json");
  const { version } = JSON.parse(await readFile(packagePath, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unsupported MapLibre asset version");
  const directory = resolve(projectRoot, "public/vendor", `maplibre-gl-${version}`);
  await mkdir(directory, { recursive: true });
  for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
    await copyFile(resolve(dirname(packagePath), "dist", file), resolve(directory, file));
  }
  await copyFile(resolve(dirname(packagePath), "LICENSE.txt"), resolve(directory, "LICENSE.txt"));
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareEarthAssets().then(directory => console.log(`Earth map worker prepared: ${directory}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
