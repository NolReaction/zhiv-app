import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// An empty-water patch of the existing 2560×2560 map artwork. No new painted master.
const source = fileURLToPath(new URL("../public/world/prototype/forest-ground.webp", import.meta.url));
const destination = fileURLToPath(new URL("../public/world/boat/river-water.webp", import.meta.url));
const bytes = await sharp(source).extract({ left: 2260, top: 1750, width: 256, height: 192 }).webp({ lossless: true }).toBuffer();
if (process.argv.includes("--check")) {
  if (!bytes.equals(await readFile(destination))) throw new Error("Fishing water is stale. Run node scripts/prepare-fishing-water.mjs");
} else await writeFile(destination, bytes);
console.log(`Fishing water: original map patch, ${bytes.length} bytes`);
