export type WorldResidentId = "plesk" | "builder";
export type WorldCharacterId = WorldResidentId | "leaftail";
type AvailableCharacter = Readonly<{ id: WorldResidentId; available: true; kind: "resident"; name: string; role: string }>;
type ShopCharacter = Readonly<{ id: "leaftail"; available: true; kind: "shop"; name: string; role: string }>;
type UnknownCharacter = Readonly<{ id: `unknown-${number}`; available: false; silhouette: "spines" | "ears" | "round" | "tail" }>;
export type WorldCharacter = AvailableCharacter | ShopCharacter | UnknownCharacter;

/** Residents open conversations; the shopkeeper opens his existing map shop. Unknown slots have no
 * name, unlock condition, account progress or pretend resident behind them. */
export const WORLD_CHARACTERS: readonly WorldCharacter[] = Object.freeze([
  Object.freeze({ id: "builder", available: true, kind: "resident", name: "Шишколап", role: "Ёжик-строитель" }),
  Object.freeze({ id: "unknown-2", available: false, silhouette: "ears" }),
  Object.freeze({ id: "unknown-3", available: false, silhouette: "round" }),
  Object.freeze({ id: "plesk", available: true, kind: "resident", name: "Плёска", role: "Рыбачка и торговка" }),
  Object.freeze({ id: "leaftail", available: true, kind: "shop", name: "Листохвост", role: "Торговец находками" }),
]);

export function worldCharacterResident(id: string): WorldResidentId | null {
  const character = WORLD_CHARACTERS.find(character => character.id === id);
  return character?.available && character.kind === "resident" ? character.id : null;
}
