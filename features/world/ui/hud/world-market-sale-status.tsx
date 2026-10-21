"use client";

import type { CSSProperties } from "react";
import { Coins } from "lucide-react";
import { CONSTRUCTION_MARKER, type MapObjectScreenAnchor } from "@/features/world/scene/construction-map-anchor";
import styles from "./world-market-sale-status.module.css";

/** Reuse the building roof and construction footprint, without pinning an
 * offscreen market to the HUD or covering an existing construction shortcut. */
export function marketSaleMarkerAnchor(anchors: readonly MapObjectScreenAnchor[], reserved: readonly MapObjectScreenAnchor[] = []) {
  const anchor = anchors.find(entry => entry.place === "market");
  if (!anchor || reserved.some(other => Math.abs(other.x - anchor.x) < CONSTRUCTION_MARKER.width + 6
    && Math.abs(other.y - anchor.y) < CONSTRUCTION_MARKER.height + 6)) return null;
  return anchor;
}

export function WorldMarketSaleStatus({ count, anchor, hidden = false, onOpen }: {
  count: number; anchor: MapObjectScreenAnchor | null; hidden?: boolean; onOpen: () => void;
}) {
  if (!Number.isSafeInteger(count) || count <= 0 || !anchor || hidden) return null;
  return <button type="button" className={styles.marker} data-market-sale-status data-market-sale-count={count}
    data-map-object={anchor.objectId}
    style={{ left: anchor.x, top: anchor.y, "--pointer-offset": `${anchor.pointerOffset}px` } as CSSProperties}
    title="Товар купили. Заберите монеты в своей лавке"
    aria-label={`Проданные партии: ${count}. Открыть мою лавку и забрать монеты`} onClick={onOpen}>
    <span className={styles.pill}><Coins size={16} aria-hidden="true" /><strong>Продано</strong>
      {count > 1 && <span className={styles.count} aria-hidden="true">{count}</span>}
    </span>
  </button>;
}
