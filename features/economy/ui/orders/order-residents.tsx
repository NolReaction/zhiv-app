import { BuilderPortrait } from "@/features/world/characters/builder/builder-portrait";
import { LopukhPortrait } from "@/features/world/characters/lopukh/lopukh-portrait";
import { KamneshmygPortrait } from "@/features/world/characters/kamneshmyg/kamneshmyg-portrait";
import { PleskPortrait } from "@/features/world/characters/plesk/plesk-portrait";
import { LeaftailPortrait } from "@/features/world/characters/leaftail/leaftail-portrait";
import type { WorldResidentId } from "@/features/world/characters/world-characters-model";

export type OrderResidentId = WorldResidentId;
export type OrderCustomer = "all" | OrderResidentId;

/** Portraits and names follow the same residents as the map and character gallery. */
export const orderResidents = {
  builder: { name: "Шишколап", dative: "Шишколапу", title: "Просьбы Шишколапа", role: "Материалы и инструменты", description: "Помоги мастеру подготовить материалы для лесных построек.", Portrait: BuilderPortrait },
  lopukh: { name: "Лопоух", dative: "Лопоуху", title: "Просьбы Лопоуха", role: "Лесной участок и припасы", description: "Собери снаряжение и провизию для работы в лесу.", Portrait: LopukhPortrait },
  kamneshmyg: { name: "Камнешмыг", dative: "Камнешмыгу", title: "Просьбы Камнешмыга", role: "Добыча и крепкие материалы", description: "Подготовь припасы и крепления для новых вылазок за камнем.", Portrait: KamneshmygPortrait },
  plesk: { name: "Плёска", dative: "Плёске", title: "Просьбы Плёски", role: "Улов, блюда и припасы", description: "Помоги рыбачке собрать улов и припасы для берега.", Portrait: PleskPortrait },
  leaftail: { name: "Листохвост", dative: "Листохвосту", title: "Просьбы Листохвоста", role: "Путешествия и находки", description: "Подготовь товары и провизию для следующего путешествия.", Portrait: LeaftailPortrait },
} as const satisfies Record<OrderResidentId, unknown>;

export const orderResidentIds: readonly OrderResidentId[] = ["builder", "lopukh", "kamneshmyg", "plesk", "leaftail"];

export const orderResidentUnlockHints: Record<OrderResidentId, string> = {
  builder: "Познакомься с жителем",
  lopukh: "Открой лесной участок и дождись прибытия жителя",
  kamneshmyg: "Построй каменоломню",
  plesk: "Познакомься с жителем",
  leaftail: "Улучши дом до 3-го уровня и дождись прибытия жителя",
};
