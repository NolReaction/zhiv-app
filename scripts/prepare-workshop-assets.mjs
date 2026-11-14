import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const check = process.argv.includes("--check");
for (let level = 1; level <= 5; level++) {
  const source = fileURLToPath(new URL(`../art/world/workshop-vector/workshop-${level}.svg`, import.meta.url));
  const target = fileURLToPath(new URL(`../public/world/prototype/forest-workshop-vector-${level}.webp`, import.meta.url));
  // Supersample thin ropes and shingles, keeping the same transparent frame for every upgrade.
  const bytes = await sharp(source, { density: 288 })
    .resize({ width: 960 })
    .webp({ quality: 90, alphaQuality: 100, smartSubsample: true, effort: 6 })
    .toBuffer();
  if (check) {
    if (!bytes.equals(await readFile(target))) throw new Error(`Stale workshop sprite: ${target}`);
  } else {
    await writeFile(target, bytes);
  }
  console.log(`Workshop ${level}: ${bytes.length} bytes`);
}
