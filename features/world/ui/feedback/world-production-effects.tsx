"use client";

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { InventoryGain } from "@/features/economy/domain/inventory-gain";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { CONSTRUCTION_MARKER, constructionMapPlace, type MapObjectScreenAnchor } from "@/features/world/scene/construction-map-anchor";
import { createInventoryGainPlayback } from "./inventory-gain-playback";
import styles from "./world-production-effects.module.css";

const NO_GAINS: readonly InventoryGain[] = [];

/** The shared receipt player discards mount/history, hidden pages and account
 * changes. This map-local layer stays below dialogs and never catches input. */
export function WorldProductionEffects({ economy, anchors, ready }: {
  economy: EconomyController; anchors: readonly MapObjectScreenAnchor[]; ready: boolean;
}) {
  const gains = economy.inventoryGains ?? NO_GAINS, owner = economy.snapshot?.ownerPublicId ?? null;
  const elements = useRef(new Map<string, HTMLDivElement>());
  const player = useRef<ReturnType<typeof createInventoryGainPlayback> | null>(null);
  useLayoutEffect(() => {
    if (player.current === null) player.current = createInventoryGainPlayback(owner, gains, {
      show(event) {
        const element = elements.current.get(event.id);
        if (!element || !event.stationId || event.source !== "claim" || document.hidden) return false;
        element.hidden = false; return true;
      },
      hide(event) { const element = elements.current.get(event.id); if (element) element.hidden = true; },
      schedule: (finish, milliseconds) => setTimeout(finish, milliseconds),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    player.current.receive(owner, gains, ready && !document.hidden);
  }, [gains, owner, ready]);
  useEffect(() => {
    const playback = player.current;
    const visibility = () => { if (document.hidden) playback?.clear(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); playback?.clear(); };
  }, []);

  return <div className={styles.layer} aria-hidden="true" data-production-effects>
    {gains.flatMap(event => {
      const anchor = event.stationId && anchors.find(value => value.place === constructionMapPlace(event.stationId!));
      const item = event.items[0];
      if (!anchor || !item || event.source !== "claim" || event.ownerPublicId !== owner) return [];
      return <div key={event.id} hidden className={styles.effect} data-production-gain={event.id} data-map-object={anchor.objectId}
        ref={element => { if (element) elements.current.set(event.id, element); else elements.current.delete(event.id); }}
        style={{ left: anchor.x + anchor.pointerOffset, top: anchor.y + CONSTRUCTION_MARKER.gap } as CSSProperties}>
        <span className={styles.halo} /><span className={styles.ring} />
        <span className={styles.item}><PlayerItemIcon state={economy.snapshot} itemId={item.itemId} size={32} /><strong>+{item.quantity.toLocaleString("ru-RU")}</strong></span>
        <span className={styles.glints}><i /><i /><i /></span>
      </div>;
    })}
  </div>;
}
