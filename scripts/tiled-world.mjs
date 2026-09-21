import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareTiledWorldExport, readTiledWorld, serializeTiledWorld } from "./lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const paths = args.filter(arg => arg !== "--check");
if (paths.some(arg => arg.startsWith("-")) || paths.length > 2) {
  console.error("Usage: node scripts/tiled-world.mjs [--check] [world/tiled/forest.tmj] [features/world/tiled/forest.generated.json]");
  process.exitCode = 1;
} else {
  const input = path.resolve(root, paths[0] ?? "world/tiled/forest.tmj");
  const output = path.resolve(root, paths[1] ?? "features/world/tiled/forest.generated.json");
  try {
    if (check) {
      const contents = serializeTiledWorld(await readTiledWorld(input, path.join(root, "public")));
      let current;
      try { current = await readFile(output, "utf8"); }
      catch { throw new Error("Generated world is missing. Run npm run world:export."); }
      if (current !== contents) throw new Error("Generated world is stale. Run npm run world:export and commit the map and generated output together.");
      console.log("Tiled world is valid and generated output is current.");
    } else {
      const prepared = await prepareTiledWorldExport(input, path.join(root, "public"));
      const contents = serializeTiledWorld(prepared.world);
      await mkdir(path.dirname(output), { recursive: true });
      if (prepared.changed) await writeFile(input, `${JSON.stringify(prepared.map, null, 2)}\n`);
      await writeFile(output, contents);
      console.log(`Exported ${path.relative(root, output)} from ${path.relative(root, input)}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
