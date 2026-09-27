import sharp from "sharp";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** One editable terrain master; a stale PNG must never silently win over a new JPEG. */
export async function findTerrainMaster(directory) {
  const sources = (await readdir(directory)).filter(name => /^forest-ground\.(png|jpe?g)$/i.test(name)).sort();
  if (sources.length !== 1) throw new Error(sources.length
    ? `Ambiguous terrain masters: ${sources.join(", ")}. Keep exactly one forest-ground PNG or JPEG.`
    : "Terrain master missing: expected forest-ground.png, forest-ground.jpg or forest-ground.jpeg.");
  return path.join(directory, sources[0]);
}

/** Lossless refers to the decoded source: JPEG compression already present is not reversed. */
export async function encodeTerrainMaster(source) {
  const bytes = await sharp(source).autoOrient().webp({ lossless: true, effort: 6 }).toBuffer();
  const [master, exported] = await Promise.all([
    sharp(source).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (master.info.width !== exported.info.width || master.info.height !== exported.info.height
    || !master.data.equals(exported.data)) throw new Error("Terrain export must preserve every oriented source pixel.");
  return bytes;
}
