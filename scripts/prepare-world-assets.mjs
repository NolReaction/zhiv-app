import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeTerrainMaster, findTerrainMaster } from "./lib/world-assets.mjs";

// One full-resolution export serves both the map and its circular focus view.
// The unique PNG/JPEG remains the editable master; no crops or previews exist.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "public/world/prototype");
const sourcePath = await findTerrainMaster(path.join(root, "art/world/prototype"));
const bytes = await encodeTerrainMaster(await readFile(sourcePath));
const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const terrain = `/world/prototype/forest-ground.webp?v=${hash}`;
const boatPath = "/world/runtime/boat-wreck-lowquality.webp";
const boatBytes = await readFile(path.join(root, "public", boatPath));
const boatHash = createHash("sha256").update(boatBytes).digest("hex").slice(0, 12);
const assets = {
  map: terrain,
  mapPreview: terrain,
  homePreview: terrain,
  homeDetail: terrain,
  // Retained artwork; the clean terrain scene does not render the boat.
  boatWreck: `${boatPath}?v=${boatHash}`,
};
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "forest-ground.webp"), bytes);
await writeFile(path.join(root, "features/world/runtime-art.json"), JSON.stringify(assets, null, 2) + "\n");
console.log(`${path.basename(sourcePath)} → forest-ground.webp: ${(bytes.length / 1024).toFixed(1)} KiB, lossless decoded pixels, version ${hash}`);
console.log("Run npm run world:export to refresh Tiled image metadata and scene URLs.");
