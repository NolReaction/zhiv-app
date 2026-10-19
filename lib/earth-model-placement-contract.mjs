/** Shared by the browser editor and the local project writer. No account data. */
/** @typedef {{id:string, longitude:number, latitude:number, heightMeters:number, headingDegrees:number, elevationMeters:number, exclusionRadiusMeters:number, excludeBuildings:boolean}} EarthModelPlacement */
/** @typedef {{version:1, placements:EarthModelPlacement[]}} EarthModelPlacementDocument */
export const EARTH_MODEL_PLACEMENT_IDS = Object.freeze(["eiffel-tower"]);
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

/** @param {unknown} input @returns {EarthModelPlacementDocument} */
export function parseEarthModelPlacementDocument(input) {
  const document = object(input);
  if (Object.keys(document).sort().join() !== "placements,version" || document.version !== 1
    || !Array.isArray(document.placements) || document.placements.length !== EARTH_MODEL_PLACEMENT_IDS.length)
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
  return { version: 1, placements };
}
