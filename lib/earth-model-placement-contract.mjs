/** Shared by the browser editor and the local project writer. No account data. */
/** @typedef {{id:string, longitude:number, latitude:number, heightMeters:number, headingDegrees:number, elevationMeters:number, exclusionRadiusMeters:number, excludeBuildings:boolean}} EarthModelPlacement */
/** @typedef {{version:1, placements:EarthModelPlacement[]}} EarthModelPlacementDocument */
export const EARTH_MODEL_PLACEMENT_IDS = Object.freeze([
  "eiffel-tower", "giza-pyramids", "colosseum", "saint-basils", "taj-mahal", "great-wall-badaling",
  "statue-of-liberty", "christ-redeemer", "sydney-opera",
]);
const fields = ["id", "longitude", "latitude", "heightMeters", "headingDegrees", "elevationMeters", "exclusionRadiusMeters", "excludeBuildings"];

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ожидается объект настроек модели.");
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @param {number} min @param {number} max @param {string} label */
function number(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label}: допустимо число от ${min} до ${max}.`);
  return value;
}

/** @param {unknown} input @param {boolean} legacy @returns {EarthModelPlacementDocument} */
function parseDocument(input, legacy) {
  const document = object(input);
  if (Object.keys(document).sort().join() !== "placements,version" || document.version !== 1
    || !Array.isArray(document.placements)
    || (document.placements.length !== EARTH_MODEL_PLACEMENT_IDS.length && !(legacy && document.placements.length === 1)))
    throw new Error("Неподдерживаемый формат размещения моделей.");
  const seen = new Set();
  const placements = document.placements.map(input => {
    const row = object(input);
    if (Object.keys(row).sort().join() !== [...fields].sort().join()
      || typeof row.id !== "string" || !EARTH_MODEL_PLACEMENT_IDS.includes(row.id) || seen.has(row.id))
      throw new Error("Неизвестная, повторяющаяся или неполная модель.");
    seen.add(row.id);
    if (typeof row.excludeBuildings !== "boolean") throw new Error("Исключение 3D-зданий должно быть включено или выключено.");
    return {
      id: row.id,
      longitude: number(row.longitude, -180, 180, "Долгота"),
      latitude: number(row.latitude, -85, 85, "Широта"),
      heightMeters: number(row.heightMeters, 1, 1000, "Высота"),
      headingDegrees: number(row.headingDegrees, -360, 360, "Поворот"),
      elevationMeters: number(row.elevationMeters, -100, 1000, "Подъём над землёй"),
      exclusionRadiusMeters: number(row.exclusionRadiusMeters, 0, 300, "Радиус исключения"),
      excludeBuildings: row.excludeBuildings,
    };
  });
  if (placements.length === 1 && placements[0].id !== "eiffel-tower")
    throw new Error("Неполный каталог размещения моделей.");
  return { version: 1, placements };
}

/** The authored file and write API always require the complete registered catalogue.
 * @param {unknown} input @returns {EarthModelPlacementDocument} */
export function parseEarthModelPlacementDocument(input) { return parseDocument(input, false); }

/** Only browser import/hydration accepts the historical single-Eiffel document.
 * Missing newly registered models retain their current values, initially the
 * published defaults. Unknown IDs and every malformed row still fail atomically.
 * @param {unknown} input @param {EarthModelPlacementDocument} current @returns {EarthModelPlacementDocument} */
export function normalizeEarthModelPlacementImport(input, current) {
  const parsed = parseDocument(input, true);
  const baseline = parseEarthModelPlacementDocument(current);
  const imported = new Map(parsed.placements.map(row => [row.id, row]));
  return { version: 1, placements: baseline.placements.map(row => imported.get(row.id) ?? row) };
}
