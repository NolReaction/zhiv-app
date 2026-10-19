import defaultsDocument from "./data/model-placements.json";
import { parseEarthModelPlacementDocument } from "@/lib/earth-model-placement-contract.mjs";

export { parseEarthModelPlacementDocument } from "@/lib/earth-model-placement-contract.mjs";
export type EarthModelPlacementDocument = ReturnType<typeof parseEarthModelPlacementDocument>;
export type EarthModelPlacement = Readonly<EarthModelPlacementDocument["placements"][number]>;
export const EARTH_MODEL_PLACEMENT_DRAFT_KEY = "zhiv.earth.model-placement.v1";
const defaults: readonly EarthModelPlacement[] = Object.freeze(parseEarthModelPlacementDocument(defaultsDocument).placements.map(row => Object.freeze(row)));
let placements = defaults;
const listeners = new Set<() => void>();

/** Published JSON is always the starting point; production never reads browser drafts. */
export function getEarthModelPlacements(): readonly EarthModelPlacement[] { return placements; }
export function getEarthModelPlacementDefaults(): readonly EarthModelPlacement[] { return defaults; }
export function subscribeEarthModelPlacements(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function replace(document: EarthModelPlacementDocument) {
  if (JSON.stringify(document.placements) === JSON.stringify(placements)) return;
  placements = Object.freeze(document.placements.map(row => Object.freeze(row)));
  for (const listener of listeners) listener();
}
export function updateEarthModelPlacement(id: string, patch: Partial<Omit<EarthModelPlacement, "id">>): void {
  if (!placements.some(row => row.id === id)) throw new Error("Модель не найдена.");
  replace(parseEarthModelPlacementDocument({ version: 1, placements: placements.map(row => row.id === id ? { ...row, ...patch, id } : row) }));
}
export function resetEarthModelPlacements(): void {
  replace(parseEarthModelPlacementDocument({ version: 1, placements: defaults }));
}
export function exportEarthModelPlacements(): string {
  return `${JSON.stringify({ version: 1, placements }, null, 2)}\n`;
}
export function importEarthModelPlacements(input: unknown): void {
  replace(parseEarthModelPlacementDocument(typeof input === "string" ? JSON.parse(input) : input));
}
/** Only the explicitly mounted development editor calls the following helpers. */
export function hydrateEarthModelPlacementDraft(storage: Pick<Storage, "getItem">): void {
  const value = storage.getItem(EARTH_MODEL_PLACEMENT_DRAFT_KEY);
  if (value !== null) importEarthModelPlacements(value);
}
export function persistEarthModelPlacementDraft(storage: Pick<Storage, "setItem">): void {
  storage.setItem(EARTH_MODEL_PLACEMENT_DRAFT_KEY, exportEarthModelPlacements());
}
