import { ItemIcon } from "@/features/items/item-icon";
import { FISH_SPECIES_IDS } from "@/features/world/fish-species";
import type { EconomyView } from "./model";

/** Inventory, gifts and purchases are not personal discoveries. */
export function fishDiscovered(state: Pick<EconomyView, "fishing"> | null | undefined, itemId: string) {
  return (state?.fishing?.catches[itemId] ?? 0) > 0;
}

export function HiddenFishIcon({ size = 40 }: { size?: number }) {
  return <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" data-hidden-fish="true"
    style={{ flexShrink: 0, verticalAlign: "middle", color: "var(--forest-muted, #59624d)" }}>
    <path d="M13 31 5 21v22l8-10c9 14 30 15 45-1C43 16 22 17 13 31Z" fill="currentColor" opacity=".17" />
    <path d="M27 25c1-5 10-5 11 0 1 4-6 5-6 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <circle cx="32" cy="40" r="1.7" fill="currentColor" />
  </svg>;
}

/** Owned fish are visible goods. Only personal catches unlock the separate collection book. */
export function PlayerItemIcon({ state, itemId, size = 24 }: { state?: Pick<EconomyView, "fishing"> & Partial<Pick<EconomyView, "inventory">> | null; itemId: string; size?: number }) {
  return itemId !== "fish" && FISH_SPECIES_IDS.some(id => id === itemId) && !fishDiscovered(state, itemId) && (state?.inventory?.[itemId] ?? 0) <= 0
    ? <HiddenFishIcon size={size} /> : <ItemIcon itemId={itemId} size={size} />;
}
