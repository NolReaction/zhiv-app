import path from "node:path";
import { randomUUID } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileTiledWorld, prepareTiledWorldExport, readTiledWorld, serializeTiledWorld } from "./lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = path.join(root, "public");
const applicationOutput = path.join(root, "features/world/tiled/forest.generated.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const watch = args.includes("--watch");
const paths = args.filter(arg => arg !== "--check" && arg !== "--watch");

class SourceChangedError extends Error {
  constructor() {
    super("Tiled map changed during export. Save the map and run npm run world:export again.");
  }
}

async function assertSourceCurrent(input, source) {
  if (await readFile(input, "utf8") !== source) throw new SourceChangedError();
}

function validateOutput(world, output) {
  if (output === applicationOutput && !world.actor) {
    throw new Error("Application world requires a point with role=spawn and size (float). Add it in Tiled before exporting features/world/tiled/forest.generated.json.");
  }
}

// Rename within the same directory so HMR only ever reads a complete JSON file.
async function writeIfChanged(file, contents, beforeCommit) {
  try {
    if (await readFile(file, "utf8") === contents) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await beforeCommit();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

async function exportWorld(input, output, { watching = false } = {}) {
  let source = await readFile(input, "utf8");
  let world;
  let refreshed;
  if (watching) {
    // Watching never writes authoring data held open in Tiled. Image metadata
    // refreshes remain an explicit world:export step after editing an asset.
    let map;
    try { map = JSON.parse(source); }
    catch (error) { throw new Error(`Cannot read Tiled map: ${error.message}`); }
    world = await compileTiledWorld(map, { mapPath: input, publicDir });
  } else {
    const prepared = await prepareTiledWorldExport(input, publicDir);
    world = prepared.world;
    if (prepared.changed) refreshed = `${JSON.stringify(prepared.map, null, 2)}\n`;
  }
  validateOutput(world, output);
  await assertSourceCurrent(input, source);
  if (refreshed !== undefined) {
    await writeIfChanged(input, refreshed, () => assertSourceCurrent(input, source));
    source = refreshed;
  }
  await assertSourceCurrent(input, source);
  return writeIfChanged(output, serializeTiledWorld(world), () => assertSourceCurrent(input, source));
}

function watchWorld(input, output) {
  let timer;
  let running = false;
  let pending = false;
  let stopped = false;
  let failed = false;
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = true;
      void drain();
    }, 150);
  };
  // Watch the directory rather than the inode: Tiled can save via a replacement
  // file followed by rename. Ignore generated output and temporary/session files.
  const watcher = watchDirectory(path.dirname(input), (_event, filename) => {
    if (filename === null || filename.toString() === path.basename(input)) schedule();
  });
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
  watcher.on("error", error => {
    console.error(`Cannot watch Tiled map: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try {
          const changed = await exportWorld(input, output, { watching: true });
          console.log(`${failed ? "Tiled map recovered. " : ""}${changed ? `Exported ${path.relative(root, output)}.` : "Tiled world is current; output unchanged."}`);
          failed = false;
        } catch (error) {
          if (error instanceof SourceChangedError) schedule();
          else {
            failed = true;
            console.error(`Tiled export failed: ${error.message}\nGenerated output left unchanged. Fix the map and save again; still watching.`);
          }
        }
      }
    } finally {
      running = false;
    }
  }

  console.log(`Watching ${path.relative(root, input)}. Save in Tiled to update the app; Ctrl+C to stop.`);
  pending = true;
  void drain();
}

if (paths.some(arg => arg.startsWith("-")) || paths.length > 2 || (watch && check)) {
  console.error("Usage: node scripts/tiled-world.mjs [--check | --watch] [world/tiled/forest.tmj] [features/world/tiled/forest.generated.json]");
  process.exitCode = 1;
} else {
  const input = path.resolve(root, paths[0] ?? "world/tiled/forest.tmj");
  const output = path.resolve(root, paths[1] ?? "features/world/tiled/forest.generated.json");
  try {
    if (input === output) throw new Error("Tiled input and generated output must be different files.");
    if (check) {
      const world = await readTiledWorld(input, publicDir);
      validateOutput(world, output);
      const contents = serializeTiledWorld(world);
      let current;
      try { current = await readFile(output, "utf8"); }
      catch { throw new Error("Generated world is missing. Run npm run world:export."); }
      if (current !== contents) throw new Error("Generated world is stale. Run npm run world:export and commit the map and generated output together.");
      console.log("Tiled world is valid and generated output is current.");
    } else if (watch) {
      watchWorld(input, output);
    } else {
      const changed = await exportWorld(input, output);
      console.log(changed ? `Exported ${path.relative(root, output)} from ${path.relative(root, input)}.` : "Tiled world is current; output unchanged.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
