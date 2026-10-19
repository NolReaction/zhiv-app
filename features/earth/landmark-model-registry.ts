import eiffel from "./data/eiffel-model.json";
import eiffelFraming from "./data/eiffel-model-framing.json";
import christ from "./data/christ-redeemer-model.json";
import colosseum from "./data/colosseum-model.json";
import pyramids from "./data/giza-pyramids-model.json";
import wall from "./data/great-wall-badaling-model.json";
import basils from "./data/saint-basils-model.json";
import liberty from "./data/statue-of-liberty-model.json";
import opera from "./data/sydney-opera-model.json";
import taj from "./data/taj-mahal-model.json";
import type { EarthModelAssets } from "./landmark-model";

export type EarthModelBounds = Readonly<{ min: readonly [number, number, number]; max: readonly [number, number, number] }>;
export type EarthModelFramingBand = Readonly<{ minZ: number; maxZ: number; radius: number }>;
export type EarthModelDefinition = Readonly<{ id: string; assets: EarthModelAssets; heightMeters: number; normalizedBounds: EarthModelBounds;
  framingBands?: readonly EarthModelFramingBand[] }>;

/** Only prepared, local assets are registered. Importing metadata does not fetch their geometry or textures. */
export const EARTH_MODEL_REGISTRY: readonly EarthModelDefinition[] = [eiffel, christ, colosseum, pyramids,
  wall, basils, liberty, opera, taj].map(manifest => Object.freeze({ id: manifest.id,
    assets: manifest as EarthModelAssets, heightMeters: manifest.coordinates.heightMeters,
    normalizedBounds: ("bounds" in manifest.coordinates ? manifest.coordinates.bounds
      : { min: [-.226, -.226, 0], max: [.226, .226, 1] }) as EarthModelBounds,
    ...(manifest.id === "eiffel-tower" && eiffelFraming.assetSha256 === manifest.detail.sha256 ? { framingBands: eiffelFraming.framingBands } : {}) }));

export function getEarthModelDefinition(id: string): EarthModelDefinition | null {
  return EARTH_MODEL_REGISTRY.find(model => model.id === id) ?? null;
}
