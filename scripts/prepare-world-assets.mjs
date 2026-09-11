import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// PNGs remain the editable masters. Runtime filenames change with their bytes.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "public/world/runtime");
await mkdir(output, { recursive: true });
const map = path.join(root, "public/world/maps/forest-region-v3.png");
const jobs = {
  map: sharp(map).webp({ quality: 94, effort: 6 }),
  mapPreview: sharp(map).resize(384, 384).webp({ quality: 72, effort: 6 }),
  homePreview: sharp(map).extract({ left: 486, top: 514, width: 256, height: 256 }).webp({ quality: 88, effort: 6 }),
  homeDetail: sharp(path.join(root, "public/world/maps/home-detail-v1.png")).webp({ quality: 94, effort: 6 }),
  boatWreck: sharp(path.join(root, "public/world/objects/boat-wreck-v1.png")).resize({ width: 512 }).webp({ quality: 92, effort: 6 }),
};
const assets = {};
for (const [name, pipeline] of Object.entries(jobs)) {
  const bytes = await pipeline.toBuffer();
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  assets[name] = `/world/runtime/${name}-${hash}.webp`;
  await writeFile(path.join(root, "public", assets[name]), bytes);
  console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
}
await writeFile(path.join(root, "features/world/runtime-art.json"), JSON.stringify(assets, null, 2) + "\n");
