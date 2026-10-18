export type WorldResidentId = "plesk" | "builder" | "lopukh" | "kamneshmyg" | "leaftail";
export type WorldCharacterId = WorldResidentId;
export type WorldCharacter = Readonly<{ id: WorldResidentId; available: true; kind: "resident"; name: string; role: string; requiresQuarry?: true; requiresWoodlot?: true }>;

/** Every named card represents a resident with the same portrait as his map sprite. */
export const WORLD_CHARACTERS: readonly WorldCharacter[] = Object.freeze([
  Object.freeze({ id: "builder", available: true, kind: "resident", name: "Шишколап", role: "Ёжик-строитель" }),
  Object.freeze({ id: "lopukh", available: true, kind: "resident", name: "Лопоух", role: "Весёлый лесоруб", requiresWoodlot: true }),
  Object.freeze({ id: "kamneshmyg", available: true, kind: "resident", name: "Камнешмыг", role: "Шахтёр и знаток камня", requiresQuarry: true }),
  Object.freeze({ id: "plesk", available: true, kind: "resident", name: "Плёска", role: "Рыбачка и торговка" }),
  Object.freeze({ id: "leaftail", available: true, kind: "resident", name: "Листохвост", role: "Торговец находками" }),
]);

export function worldCharacterResident(id: string): WorldResidentId | null {
  return WORLD_CHARACTERS.find(character => character.id === id)?.id ?? null;
}

/** Pass only confirmed access for this account. The merchant also needs his
 * completed physical arrival; a house timer or closing the coach does not introduce him. */
export function worldResidentAvailable(id: WorldResidentId, quarryBuilt: boolean, leaftailAvailable = false, lopukhAvailable = false) {
  if (id === "lopukh") return lopukhAvailable;
  if (id === "kamneshmyg") return quarryBuilt;
  if (id === "leaftail") return leaftailAvailable;
  return true;
}
