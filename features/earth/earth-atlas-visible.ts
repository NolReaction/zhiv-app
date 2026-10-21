import { EARTH_ATLAS_ENTRIES, earthAtlasEntry } from "./earth-atlas";

/** Visible places are independent of the complete v1 discovery catalogue.
 * Keep historical region/meeting IDs valid so filtering the UI never erases saves.
 */
export const EARTH_ATLAS_PLACES = Object.freeze(EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === "landmark"));
const placeIds = new Set(EARTH_ATLAS_PLACES.map(entry => entry.id));
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();

export function earthAtlasPlaces(query: string) {
  const search = normalize(query);
  return search ? EARTH_ATLAS_PLACES.filter(entry => normalize(entry.title).includes(search)) : EARTH_ATLAS_PLACES;
}

export function earthAtlasPlaceProgress(ids: readonly string[]) {
  const known = new Set(ids.filter(id => earthAtlasEntry(id) !== null));
  const opened = [...known].filter(id => placeIds.has(id)).length;
  return { opened, total: EARTH_ATLAS_PLACES.length, otherSaved: known.size - opened };
}
