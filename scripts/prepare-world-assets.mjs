import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Full artwork is already lossless and is stored once at its immutable URL.
// Only the temporary first-frame previews are resized and encoded with loss.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "public/world/runtime");
await mkdir(output, { recursive: true });
const sources = JSON.parse(await readFile(path.join(root, "public/world/art-sources.json"), "utf8"));
const assets = {};
const originals = {};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
for (const name of ["map", "homeDetail"]) {
  const source = sources.artworks[name];
  const bytes = await readFile(path.join(root, "public", source.runtimePath));
  const metadata = await sharp(bytes).metadata();
  const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
  if (digest(bytes) !== source.sha256 || digest(pixels) !== source.rgbaSha256 ||
      metadata.width !== source.width || metadata.height !== source.height ||
      source.runtimePath !== `/world/runtime/${name}-${digest(bytes).slice(0, 12)}.webp`) {
    throw new Error(`${name}: canonical artwork no longer matches its source provenance`);
  }
  assets[name] = source.runtimePath;
  originals[name] = bytes;
}
const jobs = {
  mapPreview: sharp(originals.map).resize(384, 384).webp({ quality: 72, effort: 6 }),
  homePreview: sharp(originals.homeDetail).resize(256, 256).webp({ quality: 88, effort: 6 }),
  boatWreck: sharp(path.join(root, "public/world/objects/boat-wreck-v1.png")).resize({ width: 512 }).webp({ quality: 92, effort: 6 }),
};
for (const [name, pipeline] of Object.entries(jobs)) {
  const bytes = await pipeline.toBuffer();
  const hash = digest(bytes).slice(0, 12);
  assets[name] = `/world/runtime/${name}-${hash}.webp`;
  await writeFile(path.join(root, "public", assets[name]), bytes);
  console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
}
await writeFile(path.join(root, "features/world/runtime-art.json"), JSON.stringify(assets, null, 2) + "\n");
