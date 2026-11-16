import { BOAT_ASSEMBLY, type BoatArtLayer } from "@/features/world/objects/fishing-boat/fishing-boat-artwork";
import { FISHING_BOAT_PIVOT, type FishingBoatTransform } from "./fishing-scene-buoyancy";
import { fishingBoatWaterSample, fishingHullWaterFrame } from "./fishing-scene-hull-water";

type WaterArtwork = { hull: HTMLCanvasElement; plain: HTMLCanvasElement; submerged: HTMLCanvasElement; inputs: HTMLImageElement[] };
const artwork = new WeakMap<HTMLImageElement, Map<string, WaterArtwork>>();

/** Cache transparent artwork masks once per decoded loadout. Actors and scenery never enter this image. */
export function fishingBoatWaterArtwork(layers: readonly BoatArtLayer[], images: ReadonlyMap<string, HTMLImageElement>): WaterArtwork | null {
  const inputs = layers.map(layer => images.get(layer.src));
  // Also keeps server-side/fallback canvases independent of document and unloaded image sizes.
  if (typeof document === "undefined" || inputs.some(image => !image?.complete || !(image.naturalWidth > 0))) return null;
  const ready = inputs as HTMLImageElement[], key = layers.map(layer => layer.src).join("|"), hull = ready[0];
  let variants = artwork.get(hull);
  if (!variants) { variants = new Map(); artwork.set(hull, variants); }
  const cached = variants.get(key);
  if (cached && cached.inputs.every((image, index) => image === ready[index])) return cached;
  const plain = document.createElement("canvas"), submerged = document.createElement("canvas");
  plain.width = submerged.width = 1000; plain.height = submerged.height = 650;
  const hullFront = document.createElement("canvas");
  hullFront.width = BOAT_ASSEMBLY.width; hullFront.height = BOAT_ASSEMBLY.height - BOAT_ASSEMBLY.foredeck;
  const front = hullFront.getContext("2d"), source = plain.getContext("2d"), wet = submerged.getContext("2d");
  if (!source || !wet || !front) return null;
  const [x, y, width, height] = layers[0].box;
  front.drawImage(hull, ...layers[0].crop, x, y - BOAT_ASSEMBLY.foredeck, width, height);
  layers.forEach((layer, index) => source.drawImage(ready[index], ...layer.crop, ...layer.box));
  wet.filter = "saturate(.48) contrast(.78)";
  wet.drawImage(plain, 0, 0); wet.filter = "none";
  wet.globalCompositeOperation = "source-atop";
  const depth = wet.createLinearGradient(0, 490, 0, 600);
  depth.addColorStop(0, "rgba(16,105,112,.45)"); depth.addColorStop(.5, "rgba(9,94,107,.66)");
  depth.addColorStop(1, "rgba(8,77,96,.86)"); wet.fillStyle = depth; wet.fillRect(0, 0, 1000, 650);
  const result = { hull: hullFront, plain, submerged, inputs: ready };
  if (variants.size >= 4) variants.delete(variants.keys().next().value!);
  variants.set(key, result);
  return result;
}

function applyBoat(ctx: CanvasRenderingContext2D, boat: FishingBoatTransform) {
  ctx.translate(boat.x, boat.y); ctx.scale(boat.scale, boat.scale);
  ctx.translate(FISHING_BOAT_PIVOT.x, FISHING_BOAT_PIVOT.y); ctx.rotate(boat.roll ?? 0);
  ctx.translate(-FISHING_BOAT_PIVOT.x, -FISHING_BOAT_PIVOT.y);
}

/** A small true-artwork reflection is broken into sparse compressed strips. It is not a flipped duplicate boat. */
export function paintFishingBoatReflection(ctx: CanvasRenderingContext2D, boat: FishingBoatTransform, source: WaterArtwork | null,
  time: number, still: boolean, surface: number) {
  if (!source) return;
  const frame = fishingHullWaterFrame(boat, time, still, surface);
  if (frame.contact.length < 2) return;
  const t = still ? 0 : time, compression = .36;
  // One bitmap is clipped by all strip subpaths. Eight separately transformed full-image draws
  // were expensive in software Canvas renderers even though most pixels were clipped away.
  ctx.save(); ctx.beginPath();
  for (let strip = 0; strip < 8; strip++) {
    const distance = (2 + strip * 5) * boat.scale;
    const thickness = (2.2 - strip * .16) * boat.scale;
    const drift = Math.sin(t * .87 + strip * 1.7) * (1.5 + strip * .7) * boat.scale;
    frame.contact.forEach((point, index) => index ? ctx.lineTo(point.x + drift, point.y + distance) : ctx.moveTo(point.x + drift, point.y + distance));
    for (let index = frame.contact.length - 1; index >= 0; index--) {
      const point = frame.contact[index]; ctx.lineTo(point.x + drift, point.y + distance + thickness);
    }
    ctx.closePath();
  }
  ctx.clip(); ctx.globalAlpha *= .095;
  ctx.translate(Math.sin(t * .73) * 2 * boat.scale, surface * (1 + compression)); ctx.scale(1, -compression);
  applyBoat(ctx, boat); ctx.drawImage(source.plain, 0, 0); ctx.restore();
}

/** The sampled water covers the lower hull AND outboard leg. A cached alpha mask protects open water. */
export function paintFishingBoatImmersion(ctx: CanvasRenderingContext2D, boat: FishingBoatTransform, source: WaterArtwork | null,
  time: number, still: boolean, surface: number) {
  if (!source) return;
  const t = still ? 0 : time;
  const samples = Array.from({ length: 45 }, (_, index) => fishingBoatWaterSample(boat, index / 44 * 1000, t, still, surface));
  ctx.save(); ctx.beginPath();
  samples.forEach((sample, index) => index ? ctx.lineTo(sample.point.x, sample.point.y) : ctx.moveTo(sample.point.x, sample.point.y));
  const bottom = Math.max(...samples.map(sample => sample.point.y)) + 180 * boat.scale;
  ctx.lineTo(samples.at(-1)!.point.x + 80 * boat.scale, bottom); ctx.lineTo(samples[0].point.x - 80 * boat.scale, bottom);
  ctx.closePath(); ctx.clip();
  applyBoat(ctx, boat);
  // A low refraction offset and depth tint reduce contrast below the surface, including the propeller.
  ctx.drawImage(source.submerged, Math.sin(t * .73) * 1.1, .65);
  ctx.restore();
}
