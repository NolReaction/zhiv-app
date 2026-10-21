export const COLLECTION_PAGE_SIZE = 4;
export type CollectionBookFilter = "all" | "owned" | "missing";

/** Presentation only: keep catalogue order and ownership untouched. */
export function collectionBookPage<T extends { owned: boolean }>(entries: readonly T[], filter: CollectionBookFilter, requestedPage: number) {
  const matching = filter === "all" ? entries : entries.filter(entry => entry.owned === (filter === "owned"));
  const pages = Math.max(1, Math.ceil(matching.length / COLLECTION_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0));
  return { entries: matching.slice(page * COLLECTION_PAGE_SIZE, (page + 1) * COLLECTION_PAGE_SIZE), page, pages, count: matching.length };
}
