type AvailableCharacter = Readonly<{ id: "plesk"; available: true; name: string; role: string }>;
type UnknownCharacter = Readonly<{ id: `unknown-${number}`; available: false; silhouette: "spines" | "ears" | "round" | "tail" }>;
export type WorldCharacter = AvailableCharacter | UnknownCharacter;

/** Only an implemented resident can open a conversation. Unknown slots have no
 * name, unlock condition, account progress or pretend resident behind them. */
export const WORLD_CHARACTERS: readonly WorldCharacter[] = Object.freeze([
  Object.freeze({ id: "unknown-1", available: false, silhouette: "spines" }),
  Object.freeze({ id: "unknown-2", available: false, silhouette: "ears" }),
  Object.freeze({ id: "unknown-3", available: false, silhouette: "round" }),
  Object.freeze({ id: "plesk", available: true, name: "Плёска", role: "Рыбачка и торговка" }),
  Object.freeze({ id: "unknown-4", available: false, silhouette: "tail" }),
]);

export function worldCharacterResident(id: string): "plesk" | null {
  return WORLD_CHARACTERS.some(character => character.id === id && character.available) ? "plesk" : null;
}
