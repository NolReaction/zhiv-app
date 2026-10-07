export type WorldResidentId = "plesk" | "builder";
type AvailableCharacter = Readonly<{ id: WorldResidentId; available: true; name: string; role: string }>;
type UnknownCharacter = Readonly<{ id: `unknown-${number}`; available: false; silhouette: "spines" | "ears" | "round" | "tail" }>;
export type WorldCharacter = AvailableCharacter | UnknownCharacter;

/** Only an implemented resident can open a conversation. Unknown slots have no
 * name, unlock condition, account progress or pretend resident behind them. */
export const WORLD_CHARACTERS: readonly WorldCharacter[] = Object.freeze([
  Object.freeze({ id: "builder", available: true, name: "Шишколап", role: "Ёжик-строитель" }),
  Object.freeze({ id: "unknown-2", available: false, silhouette: "ears" }),
  Object.freeze({ id: "unknown-3", available: false, silhouette: "round" }),
  Object.freeze({ id: "plesk", available: true, name: "Плёска", role: "Рыбачка и торговка" }),
  Object.freeze({ id: "unknown-4", available: false, silhouette: "tail" }),
]);

export function worldCharacterResident(id: string): WorldResidentId | null {
  const character = WORLD_CHARACTERS.find(character => character.id === id);
  return character?.available ? character.id : null;
}
