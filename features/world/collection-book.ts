import { worldCatalog } from "./model";
import { economyCatalog, type EconomyView } from "@/features/economy/model";
import collectionCatalog from "@/apps/api/src/main/resources/world/collections-catalog.json";

export { collectionCatalog };
export const TRAVEL_COLLECTION_SECONDS = collectionCatalog.travel.secondsPerFind;
export const QUARRY_COLLECTION_SECONDS = collectionCatalog.quarry.secondsPerFind;
export const TRAVEL_COLLECTION_COUNT = collectionCatalog.travel.finds.length;
export const QUARRY_COLLECTION_COUNT = collectionCatalog.quarry.finds.length;
export const FISHING_COLLECTION_COUNT = economyCatalog.fishing?.fish.length ?? 0;
export const BOOK_COLLECTION_COUNT = TRAVEL_COLLECTION_COUNT + QUARRY_COLLECTION_COUNT + FISHING_COLLECTION_COUNT;

export const COLLECTION_CHAPTERS = [
  { id: "travel", title: "Путешествия", subtitle: "Память лесных троп" },
  { id: "fishing", title: "Рыбалка", subtitle: "Речные обитатели" },
  { id: "quarry", title: "Каменоломня", subtitle: "Истории в камне" },
] as const;
export type CollectionChapter = typeof COLLECTION_CHAPTERS[number]["id"];
export const quarryCollectionFinds = collectionCatalog.quarry.finds;
export const bookFindIds = [...collectionCatalog.travel.finds, ...quarryCollectionFinds.map(find => find.id)];

export function collectionBookEntries(chapter: CollectionChapter, inherited: readonly string[], economy?: EconomyView | null) {
  const finds = new Set([...inherited, ...(economy?.progression?.collections.finds ?? [])]);
  if (chapter === "fishing") return (economy?.catalog.fishing ?? economyCatalog.fishing)?.fish.map(fish => ({
    id: fish.itemId, name: economyCatalog.items.find(item => item.id === fish.itemId)?.name ?? fish.itemId,
    description: fish.description, owned: (economy?.fishing.catches[fish.itemId] ?? 0) > 0,
    source: "Поймайте на берегу и заберите улов", illustration: "item" as const,
  })) ?? [];
  const entries = chapter === "travel" ? worldCatalog.finds.filter(find => find.group === "forest") : quarryCollectionFinds;
  return entries.map(find => ({ ...find, owned: finds.has(find.id), illustration: "collection" as const,
    source: chapter === "travel" ? "Завершайте лесные вылазки" : "Получайте результаты шахты и каменных маршрутов" }));
}

export function collectionBookProgress(chapter: CollectionChapter, economy?: EconomyView | null) {
  if (chapter === "fishing") return null;
  const total = chapter === "travel" ? economy?.progression?.collections.travelSeconds ?? 0 : economy?.progression?.collections.quarrySeconds ?? 0;
  const seconds = chapter === "travel" ? collectionCatalog.travel.secondsPerFind : collectionCatalog.quarry.secondsPerFind;
  return { completed: total % seconds, seconds };
}
