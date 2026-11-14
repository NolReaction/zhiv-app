import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export async function prepareVectorBuilding(building, spritePrefix, { check = false } = {}) {
  for (let level = 1; level <= 5; level++) {
    const source = new URL(`../../art/world/${building}-vector/${building}-${level}.svg`, import.meta.url);
    const target = new URL(`../../public/world/prototype/${spritePrefix}-${level}.webp`, import.meta.url);
    // Supersampling preserves fine branches and ropes inside the shared transparent frame.
    const bytes = await sharp(fileURLToPath(source), { density: 288 })
      .resize({ width: 960 })
      .webp({ quality: 90, alphaQuality: 100, smartSubsample: true, effort: 6 })
      .toBuffer();
    if (check) {
      if (!bytes.equals(await readFile(target))) throw new Error(`Stale sprite: ${fileURLToPath(target)}`);
    } else {
      await writeFile(target, bytes);
    }
    console.log(`${building} ${level}: ${bytes.length} bytes`);
  }
}
