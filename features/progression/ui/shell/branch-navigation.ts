export type BranchSection = "catalog" | "development" | "analysis" | "rewards" | "world";
export function branchLocation(hash: string): { section: BranchSection; itemId?: string } {
  const value = hash.replace(/^#/, "");
  if (value === "world") return { section: "world" };
  if (value === "development" || value === "economy-unlocks" || value === "economy-stages") return { section: "development" };
  if (value === "rewards" || value === "economy-pearls") return { section: "rewards" };
  if (value === "analysis" || value === "economy-analysis") return { section: "analysis" };
  if (value.startsWith("catalog/")) {
    try { return { section: "catalog", itemId: decodeURIComponent(value.slice(8)) }; } catch { return { section: "catalog" }; }
  }
  // Old economy, ingredients and detail anchors keep opening their reference.
  return { section: "catalog" };
}
export const readBranchHash = () => window.location.hash;
export const serverBranchHash = () => "";
export function subscribeBranchHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
export function navigateBranch(section: BranchSection, itemId?: string) {
  const hash = itemId ? `catalog/${encodeURIComponent(itemId)}` : section;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${hash}`);
  window.dispatchEvent(new Event("hashchange"));
}
