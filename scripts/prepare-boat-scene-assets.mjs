import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const check = process.argv.includes("--check");
const assets = [
  { source: "art/world/boat-garage/garage.png", output: "public/world/boat-garage/garage.webp", width: 1671, height: 941 },
  { source: "art/world/boat/lake-water.png", output: "public/world/boat/lake-water.webp", width: 1024, height: 1024 },
];
for (const asset of assets) {
  const source = fileURLToPath(new URL(`../${asset.source}`, import.meta.url));
  const output = fileURLToPath(new URL(`../${asset.output}`, import.meta.url));
  const bytes = await sharp(source).resize(asset.width, asset.height, { fit: "fill" }).webp({ quality: 90, effort: 6 }).toBuffer();
  if (check) {
    if (!bytes.equals(await readFile(output))) throw new Error(`Boat scene asset is stale: ${asset.output}`);
  } else await writeFile(output, bytes);
  console.log(`${asset.output}: ${asset.width}×${asset.height}, ${bytes.length} bytes${check ? " (verified)" : ""}`);
}
const standSource = new URL("../art/world/boat-garage/stand-side.svg", import.meta.url);
const standOutput = new URL("../public/world/boat-garage/stand-side.svg", import.meta.url);
const standBytes = await readFile(standSource);
if (check) {
  if (!standBytes.equals(await readFile(standOutput))) throw new Error("Boat stand SVG is stale: public/world/boat-garage/stand-side.svg");
} else await writeFile(standOutput, standBytes);
console.log(`public/world/boat-garage/stand-side.svg: ${standBytes.length} bytes${check ? " (verified)" : ""}`);
