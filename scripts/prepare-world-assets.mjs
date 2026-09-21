import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// One full-resolution export serves both the map and its circular focus view.
// The PNG remains the authoritative editable master; no crops or previews exist.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "public/world/prototype");
await mkdir(output, { recursive: true });
const source = await readFile(path.join(root, "art/world/prototype/forest-ground.png"));
const bytes = await sharp(source).webp({ lossless: true, effort: 6 }).toBuffer();
const [sourcePixels, exportedPixels] = await Promise.all([
  sharp(source).ensureAlpha().raw().toBuffer(),
  sharp(bytes).ensureAlpha().raw().toBuffer(),
]);
if (!sourcePixels.equals(exportedPixels)) throw new Error("Terrain export must preserve every source pixel.");
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
await writeFile(path.join(output, "forest-ground.webp"), bytes);
await writeFile(path.join(root, "features/world/runtime-art.json"), JSON.stringify(assets, null, 2) + "\n");
console.log(`forest-ground: ${(bytes.length / 1024).toFixed(1)} KiB, lossless, version ${hash}`);
console.log("Run npm run world:export to refresh Tiled image metadata and scene URLs.");
