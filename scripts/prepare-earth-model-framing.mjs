import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bands = 8;

/** Every triangle contributes its full planar radius to each height slab its
 * z-bounds cross. The resulting camera envelope encloses triangle interiors,
 * including long faces that contain no original vertex in an intermediate slab. */
export function createEarthModelFraming(bytes, asset) {
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256 || bytes.length !== asset.bytes)
    throw new Error("Earth framing: prepared asset integrity mismatch");
  const version = bytes.readUInt32LE(4), stride = version === 1 ? 6 : version === 2 ? 11 : 0;
  const start = version === 1 ? 16 : 88;
  if (!stride || bytes.readUInt32LE(0) !== (version === 1 ? 0x314d4c45 : 0x324d4c45)
    || bytes.readUInt32LE(8) !== asset.vertexCount || bytes.readUInt32LE(12) !== asset.indexCount
    || asset.indexCount % 3 || start + asset.vertexCount * stride * 4 + asset.indexCount * 4 > bytes.length)
    throw new Error("Earth framing: invalid prepared geometry");
  const indexStart = start + asset.vertexCount * stride * 4;
  const result = Array.from({ length: bands }, (_, index) => ({ minZ: index / bands, maxZ: (index + 1) / bands, radius: 0 }));
  for (let triangle = 0; triangle < asset.indexCount; triangle += 3) {
    const points = [0, 1, 2].map(corner => {
      const index = bytes.readUInt32LE(indexStart + (triangle + corner) * 4);
      if (index >= asset.vertexCount) throw new Error("Earth framing: invalid prepared index");
      const point = [0, 1, 2].map(channel => bytes.readFloatLE(start + (index * stride + channel) * 4));
      if (!point.every(Number.isFinite) || Math.abs(point[0]) > 1.5 || Math.abs(point[1]) > 1.5 || point[2] < -.00001 || point[2] > 1.00001)
        throw new Error("Earth framing: invalid prepared position");
      return point;
    });
    const first = Math.max(0, Math.min(bands - 1, Math.floor(Math.min(...points.map(point => point[2])) * bands)));
    const last = Math.max(0, Math.min(bands - 1, Math.floor(Math.max(...points.map(point => point[2])) * bands)));
    const radius = Math.ceil(Math.max(...points.map(point => Math.hypot(point[0], point[1]))) * 1e9) / 1e9;
    for (let index = first; index <= last; index++) result[index].radius = Math.max(result[index].radius, radius);
  }
  return { version: 1, assetSha256: asset.sha256, framingBands: result };
}

async function main() {
  const args = process.argv.slice(2);
  let check = false, manifestName = "features/earth/data/eiffel-model.json";
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--manifest" && args[index + 1] && !args[index + 1].startsWith("--")) manifestName = args[++index];
    else throw new Error("Usage: node scripts/prepare-earth-model-framing.mjs [--manifest path] [--check]");
  }
  const manifestPath = path.resolve(root, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!/^[a-z0-9-]+$/.test(manifest.id) || manifest.detail.url !== `/earth/models/${manifest.id}/detail.elm`)
    throw new Error("Earth framing: expected a local prepared detail asset");
  const bytes = await readFile(path.join(root, "public", manifest.detail.url));
  const prepared = `${JSON.stringify(createEarthModelFraming(bytes, manifest.detail), null, 2)}\n`;
  const output = manifestPath.replace(/\.json$/, "-framing.json");
  if (output === manifestPath) throw new Error("Earth framing: expected a JSON manifest");
  if (check) {
    if (await readFile(output, "utf8") !== prepared) throw new Error("Earth framing: metadata needs regeneration");
  } else await writeFile(output, prepared);
  process.stdout.write(`Earth framing ${check ? "checked" : "prepared"}: ${manifest.id}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
