import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeGroundArtwork } from "./lib/world-assets.mjs";

// Tiled displays the exported WebP; these original PNGs remain editable masters.
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(root, "public/world/prototype");
const names = ["house-ground-1", "house-ground-2"];
const exports = [];
for (const name of names) {
  const source = await readFile(path.join(directory, `${name}.png`));
  const bytes = await encodeGroundArtwork(source);
  if (bytes.length >= source.length) throw new Error(`${name}: the lossless export must be smaller than its PNG master`);
  exports.push({ name, source, bytes });
}
for (const { name, source, bytes } of exports) {
  await writeFile(path.join(directory, `${name}.webp`), bytes);
  console.log(`${name}.png → ${name}.webp: ${source.length} → ${bytes.length} bytes, identical decoded pixels`);
}
console.log("Run npm run world:export to refresh the content-versioned Tiled scene URLs.");
