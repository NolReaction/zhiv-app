import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";

// Reproducible crop/export only; artwork is authored in world/tiled/art/.
const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Usage: node scripts/prepare-tiled-assets.mjs [--check]");
const focus = { x: 486, y: 514, width: 256, height: 256 };
const home = { x: 600, y: 526, width: 142, height: 134 };
const workshop = { x: 126, y: 428, width: 166, height: 150 };
const output = path.join(root, "public/world/tiled");
const source = name => path.join(root, name);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const forest = await readFile(source("public/world/maps/forest-region-v3.png"));
const original = await readFile(source("public/world/maps/home-detail-v1.png"));
if (sha(forest) !== "6bc7d8274bc1f1e660de570f0ac4d9eb1f7651ad1a38a84abba9e5b01c45be59"
  || sha(original) !== "f14fba0d71b976ed63530726e3b4a86241ab72a409e8e837a7a5b36fae5ef8bd")
  throw new Error("Original map changed: recalibrate the prototype art contract before exporting.");

const raw = (input, width, height) => sharp(input).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer();
const crop = (input, width, height, rect, scale = 1) => sharp(input, { raw: { width, height, channels: 3 } })
  .extract({ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale })
  .raw().toBuffer();
const clamp = value => Math.max(0, Math.min(1, value));
function blend(base, top, width, height, rim, feather) {
  const result = Buffer.from(base);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = clamp((Math.min(x, width - 1 - x) - rim) / feather)
      * clamp((Math.min(y, height - 1 - y) - rim) / feather);
    for (let c = 0; c < 3; c++) {
      const i = (y * width + x) * 3 + c;
      result[i] = Math.round(base[i] * (1 - a) + top[i] * a);
    }
  }
  return result;
}
function paste(base, width, top, topWidth, topHeight, x, y) {
  const result = Buffer.from(base);
  for (let row = 0; row < topHeight; row++) top.copy(result, ((row + y) * width + x) * 3, row * topWidth * 3, (row + 1) * topWidth * 3);
  return result;
}
const localHome = { ...home, x: home.x - focus.x, y: home.y - focus.y };
const detail = await raw(original, 1024, 1024);
const clean = await raw(source("world/tiled/art/clean-home.png"), 1024, 1024);
const oldPatch = await crop(detail, 1024, 1024, localHome, 4);
const cleanPatch = await crop(clean, 1024, 1024, localHome, 4);
const groundPatch = blend(oldPatch, cleanPatch, 568, 536, 4, 16);
const cleanDetail = paste(detail, 1024, groundPatch, 568, 536, localHome.x * 4, localHome.y * 4);
const focusOriginal = await sharp(forest).extract({ left: focus.x, top: focus.y, width: 256, height: 256 }).resize(1024, 1024).removeAlpha().raw().toBuffer();
const detailedGround = blend(focusOriginal, cleanDetail, 1024, 1024, 8, 48);
// Keep the region at source resolution: upscaling its unchanged trees costs
// bandwidth and decoded memory without adding detail. Upgrade plates stay 4x.
const forestPixels = await raw(forest, 1254, 1254);
const groundPixels = await raw(await sharp(detailedGround, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer(), 256, 256);
const terrain = paste(forestPixels, 1254, groundPixels, 256, 256, focus.x, focus.y);
const assets = new Map([["terrain.webp", { pixels: terrain, width: 1254, height: 1254 }]]);
const terrainHome = await sharp(terrain, { raw: { width: 1254, height: 1254, channels: 3 } })
  .extract({ left: home.x, top: home.y, width: home.width, height: home.height })
  .resize(568, 536).raw().toBuffer();

// Shared outer pixels keep every state joined to the same terrain. The opaque
// interior replaces the previous state entirely, including its shadow/foliage.
for (const level of [1, 2, 3]) {
  const plate = level === 1 ? detail : await raw(source(`world/tiled/art/home-level-${level}.png`), 1024, 1024);
  const statePatch = blend(oldPatch, await crop(plate, 1024, 1024, localHome, 4), 568, 536, 4, 16);
  const stateDetail = paste(detail, 1024, statePatch, 568, 536, localHome.x * 4, localHome.y * 4);
  const joined = blend(focusOriginal, stateDetail, 1024, 1024, 8, 48);
  const patch = await crop(joined, 1024, 1024, localHome, 4);
  // Match the terrain's actual sampling density at the perimeter. Blending only
  // between high-resolution plates leaves a rectangular sharpness seam.
  assets.set(`home-${level}.webp`, { pixels: blend(terrainHome, patch, 568, 536, 0, 24), width: 568, height: 536 });
}
const workshopOriginal = await sharp(forest).extract({ left: workshop.x, top: workshop.y, width: workshop.width, height: workshop.height })
  .resize(664, 600).removeAlpha().raw().toBuffer();
for (const level of [0, 1, 2]) {
  const plate = level === 0 ? workshopOriginal : await raw(source(`world/tiled/art/workshop-level-${level}.png`), 664, 600);
  const pixels = blend(workshopOriginal, plate, 664, 600, 16, 48);
  assets.set(`workshop-${level}.webp`, { pixels, width: 664, height: 600 });
}
await mkdir(output, { recursive: true });
const inventory = [];
for (const [name, { pixels, width, height }] of assets) {
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).webp({ quality: 90, effort: 6 }).toBuffer();
  const target = path.join(output, name);
  if (check) {
    const existing = await readFile(target);
    if (!existing.equals(bytes)) throw new Error(`${name} is stale; run npm run world:assets.`);
  } else await writeFile(target, bytes);
  inventory.push({ file: name, width, height, bytes: bytes.length, sha256: sha(bytes) });
}
const report = `${JSON.stringify({ recipeVersion: 1, assets: inventory }, null, 2)}\n`;
const reportPath = source("world/tiled/assets.generated.json");
if (check) {
  if (await readFile(reportPath, "utf8") !== report) throw new Error("Asset inventory is stale.");
} else await writeFile(reportPath, report);
console.log(`${check ? "Verified" : "Exported"} ${assets.size} Tiled images, ${Math.round(inventory.reduce((sum, asset) => sum + asset.bytes, 0) / 1024)} KiB total.`);
